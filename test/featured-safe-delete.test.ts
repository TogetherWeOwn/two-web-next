import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteFeatured,
  getFeatured,
  listFeatured,
  NotFoundError,
  type Actor,
} from "../src/admin/store";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const actor: Actor = { id: "featured-safe-delete-moderator", username: "Safe delete moderator" };
const now = new Date("2026-10-02T12:00:00Z");
const before = new Date(now.getTime() - 1000);
const after = new Date(now.getTime() + 1000);

// Deleting featured content is safe (src/admin/routes.tsx:20: nothing refers
// to it), but only double-delete was covered. This proves the delete also
// removes the row from the store's visible reads — the same featured_contents
// table the homepage renders — leaves no orphan row, and keeps the
// second-delete NotFound contract. Store-level only: no route/page edits.
describe.skipIf(!process.env.DATABASE_URL)(
  "featured safe delete removes the homepage row (isolated test Postgres)",
  () => {
    let fixture: MemberDataFixture | undefined;
    beforeEach(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      await fixture.reset();
      await fixture.db.delete(featuredContents);
    });
    afterEach(async () => {
      await fixture?.dispose();
      fixture = undefined;
    });

    it("visible row -> delete -> visible reads drop it, no orphans, second delete is NotFound", async () => {
      const { db } = fixture!;
      const [deleted, control] = await db
        .insert(featuredContents)
        .values([
          {
            title: "Doomed feature",
            isPublished: true,
            startsAt: before,
            endsAt: after,
            position: 1,
          },
          {
            title: "Surviving feature",
            isPublished: true,
            startsAt: before,
            endsAt: after,
            position: 2,
          },
        ])
        .returning();
      const id = deleted!.id;

      // Visible before the delete through the store's reads.
      expect(await getFeatured(db, id)).toMatchObject({ id, title: "Doomed feature" });
      expect((await listFeatured(db, { published: true })).map((row) => row.id)).toContain(id);

      await deleteFeatured(db, actor, id);

      // Visible reads drop the row; the untouched control row still lists.
      expect(await getFeatured(db, id)).toBeNull();
      expect((await listFeatured(db, { published: true })).map((row) => row.title)).toEqual([
        "Surviving feature",
      ]);
      expect((await listFeatured(db, {})).map((row) => row.id)).toEqual([control!.id]);

      // No orphan row remains, and the delete left exactly one audit.
      expect(await db.select().from(featuredContents)).toHaveLength(1);
      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        subjectType: "FeaturedContent",
        subjectId: String(id),
        causerId: actor.id,
        description: "deleted featured content Doomed feature",
        properties: { title: { before: "Doomed feature", after: null } },
      });

      // A second delete follows the existing not-found contract and audits nothing.
      await expect(deleteFeatured(db, actor, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteFeatured(db, actor, id)).rejects.toMatchObject({
        message: "featured content not found",
      });
      expect(await db.select().from(activityLog)).toHaveLength(1);
    });
  },
);
