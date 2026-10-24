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

/** Legacy currentlyVisible: start inclusive, end exclusive; no homepage cap. */
export async function listVisibleFeatured(db: Db, now = new Date()): Promise<VisibleFeatured[]> {
  return withFeaturedDeadline(() =>
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
          ),
        )
        .orderBy(asc(featuredContents.position), asc(featuredContents.id));
      return rows.map(safeStoredLink);
    }),
  );
}

export type PublishedFeatured = Pick<
  typeof featuredContents.$inferSelect,
  "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt" | "startsAt" | "endsAt"
>;

/**
 * Published base list for the homepage guest cache: every published row with
 * its window bounds, same order, same deadline/cancel contract. The homepage
 * applies the live window per request (currentlyVisible in
 * `./featured-status`), so boundary instants stay exact while the
 * time-invariant base is shared across requests. Unlike the legacy visible
 * read, failures and the deadline reject: the only caller, cachedFeatured,
 * logs the one home-pattern warn and serves the empty-list fallback.
 */
export async function listPublishedFeatured(db: Db): Promise<PublishedFeatured[]> {
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
        .where(eq(featuredContents.isPublished, true))
        .orderBy(asc(featuredContents.position), asc(featuredContents.id));
      return rows.map(safeStoredLink);
    }),
  );
}
