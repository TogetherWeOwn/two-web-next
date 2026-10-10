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
import { audit, dirty, NotFoundError, type Actor } from "./store-shared";

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

export async function createFeatured(
  db: Db,
  actor: Actor,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  return db.transaction(async (tx) => {
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
}

export async function updateFeatured(
  db: Db,
  actor: Actor,
  id: number,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  return db.transaction(async (tx) => {
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
}

/** Deleting featured content is safe — nothing downstream refers to it — one row at a time, audited. */
export async function deleteFeatured(db: Db, actor: Actor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
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
      properties: { title: { before: locked.title, after: null } },
    });
  });
}

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
  const conds: SQL[] = [];
  if (opts.published !== undefined) conds.push(eq(featuredContents.isPublished, opts.published));
  if (query.q) conds.push(ilike(featuredContents.title, `%${escapeLikeTerm(query.q)}%`));
  const column =
    query.sort === "updated_at" ? featuredContents.updatedAt : featuredContents.position;
  const order = query.order === "desc" ? desc(column) : asc(column);
  // Fetch one extra row so pagination needs no separate count query.
  return nonSensitiveRead("featured", () =>
    db
      .select()
      .from(featuredContents)
      .where(and(...conds))
      .orderBy(order, asc(featuredContents.id))
      .limit(FEATURED_PAGE_SIZE + 1)
      .offset((query.page - 1) * FEATURED_PAGE_SIZE),
  );
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
