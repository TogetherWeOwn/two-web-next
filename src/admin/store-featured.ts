// Featured content leaves of the admin store (W11). Pure move out of
// `./store`: FeaturedContent CRUD + delete (safe: nothing downstream refers
// to it) with the spatie LogsActivity dirty-only audit. `./store`
// re-exports every name below, so all existing importers keep working
// untouched.

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { FEATURED_PAGE_SIZE, parseFeaturedListQuery, type FeaturedState } from "./table-list";
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
/**
 * Inventory rows for the list page: the list projection always carries the
 * exact bound text, while direct page renders may omit it for finite windows.
 */
export type FeaturedListRow = FeaturedRow & {
  startsAtText?: string | null;
  endsAtText?: string | null;
};

// Date decoding loses imported microseconds and cannot represent infinity.
// Pin formatting to UTC independently of the connection's TimeZone/DateStyle.
// Keep BC visible so validation cannot mistake an unsupported era for AD.
// Exported for the read-classifier unit contract: the list read projects
// these same reviewed fragments, never arbitrary computed SQL.
export const featuredEditSelection = {
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
): Promise<FeaturedRow> {
  const row = await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    const [locked] = await tx
      .select(featuredEditSelection)
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
    if (!locked) throw new NotFoundError("featured content");
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

// Latest instant a JavaScript Date represents (+8.64e15 ms). Postgres stores
// finite timestamps past it (up to year 294276) that the driver decodes as
// Invalid Date; a published bound there is unavailable, never live. No lower
// bound: the earliest finite timestamptz Postgres stores (4713 BC) is
// millennia inside the earliest instant Date represents (-271821).
const MAX_JS_INSTANT = sql`'275760-09-13 00:00:00+00'::timestamptz`;

type FeaturedBoundColumn = typeof featuredContents.startsAt | typeof featuredContents.endsAt;

/** No bound, or a bound the driver decodes to a finite Date. */
function decodableBound(column: FeaturedBoundColumn): SQL {
  return or(isNull(column), and(sql`isfinite(${column})`, lte(column, MAX_JS_INSTANT)))!;
}

/** A saved bound present but undecodable: infinite or past the Date range. */
function undecodableBound(column: FeaturedBoundColumn): SQL {
  return or(sql`NOT isfinite(${column})`, gt(column, MAX_JS_INSTANT))!;
}

/**
 * Effective-state predicate at saved database precision: start inclusive,
 * end exclusive, unpublished precedence, scheduled before expired — the same
 * verdict the guarded admin eligibility check reaches in
 * src/featured-eligibility.ts for every fixture class it shares (open,
 * finite, infinite and out-of-range bounds). Residual exotic rows the SQL
 * reads as decodable but V8 cannot parse still render safely: the shared
 * eligibility/bound-display backstop withholds the verdict and shows the
 * exact saved text.
 */
function featuredStateCondition(state: FeaturedState, now: Date): SQL | undefined {
  const { isPublished, startsAt, endsAt } = featuredContents;
  const publishedDecodable = [
    eq(isPublished, true),
    decodableBound(startsAt),
    decodableBound(endsAt),
  ];
  switch (state) {
    case "":
      return undefined;
    case "unpublished":
      return eq(isPublished, false);
    case "unavailable":
      return and(eq(isPublished, true), or(undecodableBound(startsAt), undecodableBound(endsAt)));
    case "scheduled":
      return and(...publishedDecodable, gt(startsAt, now));
    case "expired":
      return and(...publishedDecodable, lte(endsAt, now), or(isNull(startsAt), lte(startsAt, now)));
    case "live":
      return and(
        ...publishedDecodable,
        or(isNull(startsAt), lte(startsAt, now)),
        or(isNull(endsAt), gt(endsAt, now)),
      );
  }
}

/**
 * Featured inventory: one transaction behind the shared transaction-local
 * lock/statement bound, so a stalled table cancels server-side and the
 * caller refuses only after the transaction settles. The state facet is an
 * orthogonal SQL predicate applied before the 25+1 lookahead, evaluated at
 * the caller's instant so badges render the same verdict selection used.
 */
export async function listFeatured(
  db: Db,
  opts: {
    published?: boolean;
    q?: string;
    sort?: string;
    order?: string;
    page?: string | number;
    state?: string;
    now?: Date;
  },
): Promise<FeaturedEditRow[]> {
  const query = parseFeaturedListQuery({
    q: opts.q,
    sort: opts.sort,
    order: opts.order,
    page: opts.page === undefined ? undefined : String(opts.page),
    state: opts.state,
  });
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await nonSensitiveRead("timeouts", () => boundInventoryRead(tx));
    const conds: SQL[] = [];
    if (opts.published !== undefined) conds.push(eq(featuredContents.isPublished, opts.published));
    if (query.q) conds.push(ilike(featuredContents.title, `%${escapeLikeTerm(query.q)}%`));
    const stateCond = featuredStateCondition(query.state, now);
    if (stateCond) conds.push(stateCond);
    const column =
      query.sort === "updated_at" ? featuredContents.updatedAt : featuredContents.position;
    const order = query.order === "desc" ? desc(column) : asc(column);
    // Fetch one extra row so pagination needs no separate count query. The
    // exact saved bound text rides along so undecodable rows stay inspectable.
    return nonSensitiveRead("featured", () =>
      tx
        .select(featuredEditSelection)
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
