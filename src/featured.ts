// Public featured-content read: moderator drafts never reach the homepage.
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { featuredContents } from "./db/admin-schema";
import type { Db } from "./db/index";

export type VisibleFeatured = Pick<typeof featuredContents.$inferSelect, "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt">;

export const FEATURED_READ_DEADLINE_MS = 500;
const FEATURED_DB_TIMEOUT_MS = 250;

/** Legacy currentlyVisible: start inclusive, end exclusive; no homepage cap. */
export async function listVisibleFeatured(db: Db, now = new Date()): Promise<VisibleFeatured[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = db.transaction(async (tx) => {
    // Like optional search analytics: cancel lock waits/slow statements in
    // Postgres, not just the HTTP wait, and never alter pooled session settings.
    await tx.execute(sql`select set_config('lock_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${FEATURED_DB_TIMEOUT_MS}ms`}, true)`);
    return tx
      .select({
        id: featuredContents.id,
        title: featuredContents.title,
        body: featuredContents.body,
        url: featuredContents.url,
        imageUrl: featuredContents.imageUrl,
        imageAlt: featuredContents.imageAlt,
      })
      .from(featuredContents)
      .where(and(
        eq(featuredContents.isPublished, true),
        or(isNull(featuredContents.startsAt), lte(featuredContents.startsAt, now)),
        or(isNull(featuredContents.endsAt), gt(featuredContents.endsAt, now)),
      ))
      .orderBy(asc(featuredContents.position), asc(featuredContents.id));
  }).catch(() => []);
  // Also bound connection acquisition/transport stalls before the SQL timeout
  // can take effect. Late rejection is consumed by the read's catch above.
  const deadline = new Promise<VisibleFeatured[]>((resolve) => {
    timer = setTimeout(() => resolve([]), FEATURED_READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
