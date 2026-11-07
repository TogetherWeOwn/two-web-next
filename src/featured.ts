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
export const FEATURED_ROW_CAP = 100;

// Keep the inherited stored-text admission at the form's existing maxima.
// Inspect only max + 1 PostgreSQL characters, not an entire pathological value;
// refuse a row whole before transfer rather than truncating its display text.
const featuredTextAdmission = sql`length(substring(${featuredContents.title} from 1 for 256)) <= 255
  and (${featuredContents.body} is null or length(substring(${featuredContents.body} from 1 for 1001)) <= 1000)
  and (${featuredContents.url} is null or length(substring(${featuredContents.url} from 1 for 256)) <= 255)
  and (${featuredContents.imageUrl} is null or length(substring(${featuredContents.imageUrl} from 1 for 256)) <= 255)
  and (${featuredContents.imageAlt} is null or length(substring(${featuredContents.imageAlt} from 1 for 256)) <= 255)`;

function boundFeaturedRows<T>(rows: T[], status?: { saturated: boolean }): T[] {
  const saturated = rows.length > FEATURED_ROW_CAP;
  if (status) status.saturated = saturated;
  if (saturated) {
    // Counts only: never log stored text, SQL, URLs or identities.
    console.warn("Featured read reached the row cap.", {
      limit: FEATURED_ROW_CAP,
      returned: FEATURED_ROW_CAP,
    });
  }
  return rows.slice(0, FEATURED_ROW_CAP);
}

// The lock/statement guard both readers share: cancel lock waits/slow
// statements in Postgres, not just the HTTP wait, and never alter pooled
// session settings.
function featuredTimeoutGuard() {
  return sql`select set_config('lock_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true)`;
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

/** Start inclusive, end exclusive; admit text and cap rows before transfer. */
export async function listVisibleFeatured(
  db: Db,
  now = new Date(),
  propagateFailure = false,
): Promise<VisibleFeatured[]> {
  const run = () =>
    db.transaction(async (tx) => {
      // Like optional search analytics: cancel lock waits/slow statements in
      // Postgres, not just the HTTP wait, and never alter pooled session settings.
      await tx.execute(featuredTimeoutGuard());
      const rows = await tx
        .select({
          id: featuredContents.id,
          title: featuredContents.title,
          body: featuredContents.body,
          url: featuredContents.url,
          imageUrl: featuredContents.imageUrl,
          imageAlt: featuredContents.imageAlt,
        })
        .from(featuredContents)
        .where(
          and(
            eq(featuredContents.isPublished, true),
            or(isNull(featuredContents.startsAt), lte(featuredContents.startsAt, now)),
            or(isNull(featuredContents.endsAt), gt(featuredContents.endsAt, now)),
            featuredTextAdmission,
          ),
        )
        .orderBy(asc(featuredContents.position), asc(featuredContents.id))
        .limit(FEATURED_ROW_CAP + 1);
      return boundFeaturedRows(rows).map(safeStoredLink);
    });
  // The saturated-cache fallback must propagate failures to cachedFeatured's
  // existing one-warn fallback; ordinary visible-reader callers never throw.
  return propagateFailure ? withPublishedFeaturedRead(run) : withFeaturedDeadline(run);
}

export type PublishedFeatured = Pick<
  typeof featuredContents.$inferSelect,
  "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt" | "startsAt" | "endsAt"
>;

/**
 * Bounded published base for the homepage guest cache. Exclude already-ended
 * rows before the cap so expired inventory cannot crowd out live content.
 * Future windows remain: the homepage evaluates visibility per request, keeping
 * boundary instants exact. A saturated base is incomplete and must not be cached;
 * the caller uses the bounded visible read instead. Failures and the deadline
 * reject to cachedFeatured's existing one-warn empty-list fallback.
 */
export async function listPublishedFeatured(
  db: Db,
  now = new Date(),
  status?: { saturated: boolean },
): Promise<PublishedFeatured[]> {
  return withPublishedFeaturedRead(() =>
    db.transaction(async (tx) => {
      await tx.execute(featuredTimeoutGuard());
      const rows = await tx
        .select({
          id: featuredContents.id,
          title: featuredContents.title,
          body: featuredContents.body,
          url: featuredContents.url,
          imageUrl: featuredContents.imageUrl,
          imageAlt: featuredContents.imageAlt,
          startsAt: featuredContents.startsAt,
          endsAt: featuredContents.endsAt,
        })
        .from(featuredContents)
        .where(
          and(
            eq(featuredContents.isPublished, true),
            or(isNull(featuredContents.endsAt), gt(featuredContents.endsAt, now)),
            featuredTextAdmission,
          ),
        )
        .orderBy(asc(featuredContents.position), asc(featuredContents.id))
        .limit(FEATURED_ROW_CAP + 1);
      return boundFeaturedRows(rows, status).map(safeStoredLink);
    }),
  );
}
