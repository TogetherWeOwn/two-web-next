// Public featured-content read: moderator drafts never reach the homepage.
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { featuredContents } from "./db/admin-schema";
import type { Db } from "./db/index";
import { featuredLinkRefusal, isSafeFeaturedLink } from "./image-policy";

export type VisibleFeatured = Pick<
  typeof featuredContents.$inferSelect,
  "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt"
>;

/**
 * The one place a stored link is judged before it can become a public href
 * (Hono and Kit homepages both read through the two readers below; the admin
 * Homepage previews judge their preview copy with it too). A row saved before
 * the save-time policy, or written around the form, keeps its title and body
 * but loses its link.
 */
export function safeStoredLink<T extends { url: string | null }>(row: T): T {
  const url = row.url;
  if (url === null || isSafeFeaturedLink(url) || isSameSitePath(url)) return row;
  return { ...row, url: null };
}

// Rows seeded outside the form (the Lighthouse fixture links "/events") may
// hold a same-site path: not deceptive, and the same checks apply. "//host"
// is protocol-relative, so it is not a path.
function isSameSitePath(raw: string): boolean {
  return /^\/(?!\/)/.test(raw) && featuredLinkRefusal(raw) === null;
}

export const FEATURED_READ_DEADLINE_MS = 500;
const FEATURED_DB_TIMEOUT_MS = 250;

// The lock/statement guard both readers share: cancel lock waits/slow
// statements in Postgres, not just the HTTP wait, and never alter pooled
// session settings.
function featuredTimeoutGuard() {
  return sql`select set_config('lock_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true)`;
}

/** Generous row cap per read: normal homepages hold only a handful of slots;
 * pathological published inventory is bounded even when form-valid. */
export const FEATURED_ROW_CAP = 100;

/**
 * SQL-side admission for stored featured text: every projected text column
 * is judged against the established write maxima of the featured form
 * (`src/admin/validation-featured-form.ts`: title 255, body 1000, url 255,
 * image_url 255, image_alt 255), counted in characters — PostgreSQL
 * `length()` counts characters, so a multibyte value AT a maximum crosses
 * byte-identical and one character over never crosses at all. Null is
 * admitted. A row that fails is skipped whole, never truncated after
 * transfer; healthy siblings keep their order and bytes.
 */
const featuredTextAdmission = sql`length(${featuredContents.title}) <= 255
  and (${featuredContents.body} is null or length(${featuredContents.body}) <= 1000)
  and (${featuredContents.url} is null or length(${featuredContents.url}) <= 255)
  and (${featuredContents.imageUrl} is null or length(${featuredContents.imageUrl}) <= 255)
  and (${featuredContents.imageAlt} is null or length(${featuredContents.imageAlt}) <= 255)`;

/**
 * Collapse one bounded read to its capped rows plus at most one counts-only
 * diagnostic. The read's single statement left-joins the admitted rows
 * (probe: cap + 1) onto a counts-only subquery of visibility-matching rows
 * the admission refused, so the skipped count rides every row — and rides
 * one all-null sentinel row when nothing was admitted — while no oversized
 * byte ever crosses the projection. Rows the reader's visibility filter
 * already excludes are in neither subquery and never count as skipped. The
 * diagnostic carries counts only, never stored text (sitemap-skip
 * precedent): `skipped` for refused rows, `limit`/`returned` on saturation.
 */
function boundFeaturedRows<Out extends { id: number }>(
  // The left join types every admitted column nullable: the all-null
  // sentinel is the only row that uses that, and it is filtered out below.
  rows: Array<{ [K in keyof Out]: Out[K] | null } & { skippedOversized: unknown }>,
): Out[] {
  const skippedCount = Number(rows[0]?.skippedOversized);
  const skipped = Number.isSafeInteger(skippedCount) && skippedCount > 0 ? skippedCount : 0;
  const admitted = rows.filter((row) => row.id !== null && row.id !== undefined);
  const saturated = admitted.length > FEATURED_ROW_CAP;
  const bounded = saturated ? admitted.slice(0, FEATURED_ROW_CAP) : admitted;
  if (skipped > 0 || saturated) {
    const diagnostic: { skipped?: number; limit?: number; returned?: number } = {};
    if (skipped > 0) diagnostic.skipped = skipped;
    if (saturated) {
      diagnostic.limit = FEATURED_ROW_CAP;
      diagnostic.returned = bounded.length;
    }
    console.warn("Featured read bounded oversized stored rows.", diagnostic);
  }
  return bounded.map(({ skippedOversized, ...row }) => {
    void skippedOversized;
    return row as unknown as Out;
  });
}

async function withFeaturedDeadline<T>(run: () => Promise<T[]>): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = run().catch(() => [] as T[]);
  // Also bound connection acquisition/transport stalls before the SQL timeout
  // can take effect. Late rejection is consumed by the read's catch above.
  const deadline = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), FEATURED_READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Published-base variant of the deadline race: rejections and the deadline
 * propagate to cachedFeatured (`src/home-cache.ts`), which logs the one
 * home-pattern warn and serves the empty-list fallback. The legacy visible
 * path keeps the swallowing variant above — its callers rely on never-throw.
 */
async function withPublishedFeaturedRead<T>(run: () => Promise<T[]>): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = run();
  // A deadline win must not leave the losing read's late rejection
  // unhandled; this branched catch consumes it without changing the race.
  void read.catch(() => {});
  // Also bound connection acquisition/transport stalls before the SQL timeout
  // can take effect. The message never surfaces: cachedFeatured logs the
  // bounded `ReadFailure` class only.
  const deadline = new Promise<T[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error("FeaturedReadDeadline")), FEATURED_READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legacy currentlyVisible: start inclusive, end exclusive. Stored text is
 * admitted in SQL (`featuredTextAdmission`) and the read is capped at
 * `FEATURED_ROW_CAP` rows, so one oversized stored row is skipped whole in
 * the database instead of being transferred, cached, and serialized.
 */
export async function listVisibleFeatured(db: Db, now = new Date()): Promise<VisibleFeatured[]> {
  return withFeaturedDeadline(() =>
    db.transaction(async (tx) => {
      // Like optional search analytics: cancel lock waits/slow statements in
      // Postgres, not just the HTTP wait, and never alter pooled session settings.
      await tx.execute(featuredTimeoutGuard());
      const visibility = and(
        eq(featuredContents.isPublished, true),
        or(isNull(featuredContents.startsAt), lte(featuredContents.startsAt, now)),
        or(isNull(featuredContents.endsAt), gt(featuredContents.endsAt, now)),
      );
      const admitted = tx
        .select({
          id: featuredContents.id,
          title: featuredContents.title,
          body: featuredContents.body,
          url: featuredContents.url,
          imageUrl: featuredContents.imageUrl,
          imageAlt: featuredContents.imageAlt,
          position: featuredContents.position,
        })
        .from(featuredContents)
        .where(and(visibility, featuredTextAdmission))
        .orderBy(asc(featuredContents.position), asc(featuredContents.id))
        .limit(FEATURED_ROW_CAP + 1)
        .as("admitted_featured");
      const skipped = tx
        .select({ n: sql<number>`count(*)`.as("n") })
        .from(featuredContents)
        .where(and(visibility, sql`not (${featuredTextAdmission})`))
        .as("skipped_featured");
      const rows = await tx
        .select({
          id: admitted.id,
          title: admitted.title,
          body: admitted.body,
          url: admitted.url,
          imageUrl: admitted.imageUrl,
          imageAlt: admitted.imageAlt,
          skippedOversized: skipped.n,
        })
        .from(skipped)
        .leftJoin(admitted, sql`true`)
        .orderBy(asc(admitted.position), asc(admitted.id));
      return boundFeaturedRows<VisibleFeatured>(rows).map(safeStoredLink);
    }),
  );
}

export type PublishedFeatured = Pick<
  typeof featuredContents.$inferSelect,
  "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt" | "startsAt" | "endsAt"
>;

/**
 * Published base list for the homepage guest cache: every admitted published
 * row (same SQL admission and row cap as the visible read, so the cached
 * base never holds oversized stored text) with its window bounds, same
 * order, same deadline/cancel contract. The homepage
 * applies the live window per request (currentlyVisible in
 * `./featured-status`), so boundary instants stay exact while the
 * time-invariant base is shared across requests. Unlike the legacy visible
 * read, failures and the deadline reject: the only caller, cachedFeatured,
 * logs the one home-pattern warn and serves the empty-list fallback.
 *
 * When the caller passes its request time, published rows whose window
 * already ended are excluded before the row cap: an ended row can never
 * become visible again (end-exclusive window, time moves forward), so
 * ordinary accumulated expired inventory must not consume the cap and crowd
 * live rows out of the cached base. Future-window rows stay in the base —
 * the per-request window filter needs them — and the exclusion stays safe
 * for every request at or after the cache fill. The no-`now` path keeps the
 * legacy time-invariant base exactly (pinned by CONTROL-SQL02 and the
 * bounded homepage acceptance); no production caller uses it.
 */
export async function listPublishedFeatured(db: Db, now?: Date): Promise<PublishedFeatured[]> {
  return withPublishedFeaturedRead(() =>
    db.transaction(async (tx) => {
      await tx.execute(featuredTimeoutGuard());
      const visibility = now
        ? and(
            eq(featuredContents.isPublished, true),
            or(isNull(featuredContents.endsAt), gt(featuredContents.endsAt, now)),
          )
        : eq(featuredContents.isPublished, true);
      const admitted = tx
        .select({
          id: featuredContents.id,
          title: featuredContents.title,
          body: featuredContents.body,
          url: featuredContents.url,
          imageUrl: featuredContents.imageUrl,
          imageAlt: featuredContents.imageAlt,
          startsAt: featuredContents.startsAt,
          endsAt: featuredContents.endsAt,
          position: featuredContents.position,
        })
        .from(featuredContents)
        .where(and(visibility, featuredTextAdmission))
        .orderBy(asc(featuredContents.position), asc(featuredContents.id))
        .limit(FEATURED_ROW_CAP + 1)
        .as("admitted_featured");
      const skipped = tx
        .select({ n: sql<number>`count(*)`.as("n") })
        .from(featuredContents)
        .where(and(visibility, sql`not (${featuredTextAdmission})`))
        .as("skipped_featured");
      const rows = await tx
        .select({
          id: admitted.id,
          title: admitted.title,
          body: admitted.body,
          url: admitted.url,
          imageUrl: admitted.imageUrl,
          imageAlt: admitted.imageAlt,
          startsAt: admitted.startsAt,
          endsAt: admitted.endsAt,
          skippedOversized: skipped.n,
        })
        .from(skipped)
        .leftJoin(admitted, sql`true`)
        .orderBy(asc(admitted.position), asc(admitted.id));
      return boundFeaturedRows<PublishedFeatured>(rows).map(safeStoredLink);
    }),
  );
}
