// Featured content leaves of the admin store (W11). Pure move out of
// `./store`: FeaturedContent CRUD + delete (safe: nothing downstream refers
// to it) with the spatie LogsActivity dirty-only audit. `./store`
// re-exports every name below, so all existing importers keep working
// untouched.

import { and, asc, desc, eq, getTableColumns, ilike, sql, type SQL } from "drizzle-orm";
import { FEATURED_PAGE_SIZE, parseFeaturedListQuery } from "./table-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { nonSensitiveRead } from "../member-reads";
import { activityLog, featuredContents } from "../db/admin-schema";
import type { FeaturedFormInput } from "./validation";
import {
  audit,
  boundInventoryRead,
  boundModeratorWrite,
  dirty,
  NotFoundError,
  type Actor,
} from "./store-shared";
import { retireHomeGuestCache } from "../home-cache";

export type FeaturedRow = typeof featuredContents.$inferSelect;
export type FeaturedEditRow = FeaturedRow & {
  startsAtText: string | null;
  endsAtText: string | null;
};

// Date decoding loses imported microseconds and cannot represent infinity.
// Pin formatting to UTC independently of the connection's TimeZone/DateStyle.
// Keep BC visible so validation cannot mistake an unsupported era for AD.
const featuredEditSelection = {
  ...getTableColumns(featuredContents),
  startsAtText: sql<string | null>`CASE WHEN isfinite(${featuredContents.startsAt})
    THEN to_char(${featuredContents.startsAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
      || CASE WHEN EXTRACT(YEAR FROM ${featuredContents.startsAt} AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END
    ELSE ${featuredContents.startsAt}::text END`,
  endsAtText: sql<string | null>`CASE WHEN isfinite(${featuredContents.endsAt})
    THEN to_char(${featuredContents.endsAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
      || CASE WHEN EXTRACT(YEAR FROM ${featuredContents.endsAt} AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END
    ELSE ${featuredContents.endsAt}::text END`,
};

function featuredTimestamp(date: Date | null, text: string | null | undefined) {
  return text === undefined ? date : text === null ? null : sql`${text}::timestamptz`;
}

function featuredAuditValues({ startsAtText, endsAtText, ...row }: FeaturedEditRow) {
  return { ...row, startsAt: startsAtText, endsAt: endsAtText };
}

// Every editable field nulled out: diffed against the locked-row snapshot,
// the delete audit reconstructs the slot. dirty() omits null-to-null fields,
// so the receipt keeps the same sparse shape as create/update audits.
const NULL_FEATURED_SNAPSHOT = {
  title: null,
  body: null,
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: null,
  position: null,
  startsAt: null,
  endsAt: null,
};

/** A form Save arrived with a baseline that no longer matches the saved row. */
export class StaleFeaturedSaveError extends Error {
  constructor(readonly slotId: number) {
    super(`featured content ${slotId} changed since the form was rendered`);
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Server-derived baseline for exactly the saved content an edit form displays.
 * The payload mirrors featuredValues()/KitFeaturedEditValues field-for-field —
 * title, body, url, image fields, publish flag, position and the microsecond
 * window texts — so any saved change, even two updates inside one JavaScript
 * millisecond or one microsecond apart, mints a different baseline, while a
 * content-identical re-read mints the same one. updatedAt is deliberately
 * excluded: it is not displayed and must not invalidate a fresh form.
 */
export async function featuredSaveBaseline(row: FeaturedEditRow): Promise<string> {
  const payload = JSON.stringify({
    title: row.title,
    body: row.body ?? "",
    url: row.url ?? "",
    image_url: row.imageUrl ?? "",
    image_alt: row.imageAlt ?? "",
    is_published: row.isPublished ? "on" : "",
    position: String(row.position),
    starts_at: row.startsAtText ?? "",
    ends_at: row.endsAtText ?? "",
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createFeatured(
  db: Db,
  actor: Actor,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  const row = await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    const [row] = await tx
      .insert(featuredContents)
      .values({
        title: input.title,
        body: input.body,
        url: input.url,
        imageUrl: input.imageUrl,
        imageAlt: input.imageAlt,
        isPublished: input.isPublished,
        position: input.position,
        startsAt: featuredTimestamp(input.startsAtUtc, input.startsAtUtcText),
        endsAt: featuredTimestamp(input.endsAtUtc, input.endsAtUtcText),
        createdBy: actor.id,
      })
      .returning(featuredEditSelection);
    if (!row) throw new Error("featured insert returned no row");
    await audit(tx, {
      subjectType: "FeaturedContent",
      subjectId: String(row.id),
      causerId: actor.id,
      description: `created featured content ${row.title}`,
      properties: dirty({} as Record<string, unknown>, featuredAuditValues(row)),
    });
    return row;
  });
  // Committed: the new slot is visible to guests on the next homepage fetch.
  await retireHomeGuestCache();
  return row;
}

export async function updateFeatured(
  db: Db,
  actor: Actor,
  id: number,
  input: FeaturedFormInput,
  opts?: { expectedBaseline?: string },
): Promise<FeaturedRow> {
  const row = await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    const [locked] = await tx
      .select(featuredEditSelection)
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
    if (!locked) throw new NotFoundError("featured content");
    // Form-save precondition, compared after the committing lock resolves so a
    // contender blocked on another moderator's lock refuses against the
    // committed successor, not the pre-lock read. A mismatch throws before any
    // content write, audit insert or cache retirement. Callers without a form
    // baseline keep the unconditional low-level contract.
    if (opts?.expectedBaseline !== undefined) {
      const current = await featuredSaveBaseline(locked);
      if (!timingSafeEqualHex(current, opts.expectedBaseline)) throw new StaleFeaturedSaveError(id);
    }
    const [row] = await tx
      .update(featuredContents)
      .set({
        title: input.title,
        body: input.body,
        url: input.url,
        imageUrl: input.imageUrl,
        imageAlt: input.imageAlt,
        isPublished: input.isPublished,
        position: input.position,
        startsAt: featuredTimestamp(input.startsAtUtc, input.startsAtUtcText),
        endsAt: featuredTimestamp(input.endsAtUtc, input.endsAtUtcText),
        updatedAt: new Date(),
      })
      .where(eq(featuredContents.id, id))
      .returning(featuredEditSelection);
    if (!row) throw new Error("featured update returned no row");
    const changes = dirty(featuredAuditValues(locked), featuredAuditValues(row));
    if (Object.keys(changes).length > 0) {
      await tx.insert(activityLog).values({
        logName: "default",
        description: `updated featured content ${row.title}`,
        subjectType: "FeaturedContent",
        subjectId: String(row.id),
        causerId: actor.id,
        properties: changes,
      });
    }
    return row;
  });
  // Committed: the edit is visible to guests on the next homepage fetch.
  await retireHomeGuestCache();
  return row;
}

export async function unpublishFeatured(db: Db, actor: Actor, id: number): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    const [locked] = await tx
      .select({ title: featuredContents.title, isPublished: featuredContents.isPublished })
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
    if (!locked) throw new NotFoundError("featured content");
    if (!locked.isPublished) return false;
    await tx
      .update(featuredContents)
      .set({ isPublished: false, updatedAt: new Date() })
      .where(eq(featuredContents.id, id));
    await audit(tx, {
      subjectType: "FeaturedContent",
      subjectId: String(id),
      causerId: actor.id,
      description: `unpublished featured content ${locked.title}`,
      properties: dirty<Pick<FeaturedRow, "isPublished">>(
        { isPublished: locked.isPublished },
        { isPublished: false },
      ),
    });
    return true;
  });
  // Only a committed change retires the cache; repeated withdrawals are no-ops.
  if (changed) await retireHomeGuestCache();
}

/**
 * Deleting featured content is safe — nothing downstream refers to it — one row at a time, audited.
 * The delete audit snapshots the full locked row (update-audit value shape, after null per field),
 * so a mistaken delete stays reconstructable from the activity log alone. Receipt only: no restore.
 */
export async function deleteFeatured(db: Db, actor: Actor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    const [locked] = await tx
      .select(featuredEditSelection)
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
    if (!locked) throw new NotFoundError("featured content");
    await tx.delete(featuredContents).where(eq(featuredContents.id, id));
    await tx.insert(activityLog).values({
      logName: "default",
      description: `deleted featured content ${locked.title}`,
      subjectType: "FeaturedContent",
      subjectId: String(locked.id),
      causerId: actor.id,
      properties: dirty(
        featuredAuditValues(locked) as Record<string, unknown>,
        NULL_FEATURED_SNAPSHOT,
      ),
    });
  });
  // Committed: the homepage drops the slot on the next fetch.
  await retireHomeGuestCache();
}

/**
 * Featured inventory: one transaction behind the shared transaction-local
 * lock/statement bound, so a stalled table cancels server-side and the
 * caller refuses only after the transaction settles.
 */
export async function listFeatured(
  db: Db,
  opts: { published?: boolean; q?: string; sort?: string; order?: string; page?: string | number },
): Promise<FeaturedRow[]> {
  const query = parseFeaturedListQuery({
    q: opts.q,
    sort: opts.sort,
    order: opts.order,
    page: opts.page === undefined ? undefined : String(opts.page),
  });
  return db.transaction(async (tx) => {
    await nonSensitiveRead("timeouts", () => boundInventoryRead(tx));
    const conds: SQL[] = [];
    if (opts.published !== undefined) conds.push(eq(featuredContents.isPublished, opts.published));
    if (query.q) conds.push(ilike(featuredContents.title, `%${escapeLikeTerm(query.q)}%`));
    const column =
      query.sort === "updated_at" ? featuredContents.updatedAt : featuredContents.position;
    const order = query.order === "desc" ? desc(column) : asc(column);
    // Fetch one extra row so pagination needs no separate count query.
    return nonSensitiveRead("featured", () =>
      tx
        .select()
        .from(featuredContents)
        .where(and(...conds))
        .orderBy(order, asc(featuredContents.id))
        .limit(FEATURED_PAGE_SIZE + 1)
        .offset((query.page - 1) * FEATURED_PAGE_SIZE),
    );
  });
}

/** Imported source IDs are independent of native IDs; never fall back to a native match. */
export async function getFeaturedIdByLegacyId(db: Db, legacyId: string): Promise<number | null> {
  const [row] = await nonSensitiveRead("featured", () =>
    db
      .select({ id: featuredContents.id })
      .from(featuredContents)
      .where(eq(featuredContents.legacyId, legacyId)),
  );
  return row?.id ?? null;
}

export async function getFeatured(db: Db, id: number): Promise<FeaturedEditRow | null> {
  const [row] = await nonSensitiveRead("featured", () =>
    db.select(featuredEditSelection).from(featuredContents).where(eq(featuredContents.id, id)),
  );
  return row ?? null;
}
