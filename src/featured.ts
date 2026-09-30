// Public featured-content read: moderator drafts never reach the homepage.
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { featuredContents } from "./db/admin-schema";
import type { Db } from "./db/index";

export type VisibleFeatured = Pick<typeof featuredContents.$inferSelect, "id" | "title" | "body" | "url" | "imageUrl" | "imageAlt">;

/** Legacy currentlyVisible: start inclusive, end exclusive; no homepage cap. */
export async function listVisibleFeatured(db: Db, now = new Date()): Promise<VisibleFeatured[]> {
  return db
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
}
