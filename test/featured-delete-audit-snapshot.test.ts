// Featured delete audit: full slot snapshot (roadmap acceptance, store level).
//
// A deleted slot must leave a reconstructable receipt: the delete audit pins
// the full locked-row snapshot (every editable field, same value shape as
// update audits) with `after: null` per field, inside the deleting
// transaction. Description, subject, causer and single-audit-per-delete stay
// exactly as today; not-found and second-delete audit nothing; safe-delete
// (no orphans, visible reads drop the row) and homepage-cache retirement are
// unchanged.
//
// FAIL-FIRST: the snapshot and reconstruction tests below are RED until the
// delete audit carries the full snapshot. The not-found, second-delete,
// rollback and safe-delete/cache tests pin unchanged behavior and pass both
// before and after.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteFeatured, getFeatured, NotFoundError, type Actor } from "../src/admin/store";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { listVisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";
import { env } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const actor: Actor = { id: "featured-delete-snapshot-moderator", username: "Snapshot moderator" };

const STARTS_AT = new Date("2026-10-08T18:00:00.000Z");
const ENDS_AT = new Date("2026-10-09T18:00:00.000Z");
// Update-audit value shape for window bounds: the UTC text projection
// (`featuredEditSelection`), not ISO. The creation suite pins this format.
const STARTS_AT_TEXT = "2026-10-08 18:00:00.000000";
const ENDS_AT_TEXT = "2026-10-09 18:00:00.000000";

const FULL_SLOT = {
  title: "Doomed headline",
  body: "Doomed body",
  url: "https://example.test/doomed",
  imageUrl: "/images/doomed.png",
  imageAlt: "Doomed alt text",
  isPublished: true,
  position: 3,
  startsAt: STARTS_AT,
  endsAt: ENDS_AT,
} as const;

type AuditProps = Record<string, { before: unknown; after: unknown }>;

// Every editable field must round-trip through the audit with `after: null`.
// A null-valued field is reconstructable whether the audit pins an explicit
// null or omits the key (dirty-shaped sparse snapshot), so both read as null.
function expectSnapshotField(props: AuditProps, key: string, expectedBefore: unknown) {
  const entry = props[key];
  if (expectedBefore === null) {
    if (entry === undefined) return;
    expect(entry, key).toEqual({ before: null, after: null });
    return;
  }
  expect(entry, key).toEqual({ before: expectedBefore, after: null });
}

function expectFullSnapshot(props: AuditProps, slot: typeof FULL_SLOT) {
  expectSnapshotField(props, "title", slot.title);
  expectSnapshotField(props, "body", slot.body);
  expectSnapshotField(props, "url", slot.url);
  expectSnapshotField(props, "imageUrl", slot.imageUrl);
  expectSnapshotField(props, "imageAlt", slot.imageAlt);
  expectSnapshotField(props, "isPublished", slot.isPublished);
  expectSnapshotField(props, "position", slot.position);
  expectSnapshotField(props, "startsAt", slot.startsAt === null ? null : STARTS_AT_TEXT);
  expectSnapshotField(props, "endsAt", slot.endsAt === null ? null : ENDS_AT_TEXT);
}

// Field-by-field reconstruction from the activity log alone: absent keys read
// as null, matching the sparse-snapshot reading in expectSnapshotField.
function reconstruct(props: AuditProps) {
  const before = (key: string) => props[key]?.before ?? null;
  return {
    title: before("title"),
    body: before("body"),
    url: before("url"),
    imageUrl: before("imageUrl"),
    imageAlt: before("imageAlt"),
    isPublished: before("isPublished"),
    position: before("position"),
    startsAt: before("startsAt"),
    endsAt: before("endsAt"),
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "featured delete audits the full slot snapshot (isolated test Postgres)",
  () => {
    let fixture: MemberDataFixture | undefined;
    beforeEach(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      __resetHomeGuestCacheForTests();
    });
    afterEach(async () => {
      __resetHomeGuestCacheForTests();
      await fixture?.dispose();
      fixture = undefined;
    });

    it("delete audits every editable field with after:null, envelope unchanged", async () => {
      const { db } = fixture!;
      const [seeded] = await db
        .insert(featuredContents)
        .values({ ...FULL_SLOT })
        .returning();
      const id = seeded!.id;

      // The locked row the audit must snapshot, in update-audit value shape.
      const locked = await getFeatured(db, id);
      expect(locked?.startsAtText).toBe(STARTS_AT_TEXT);
      expect(locked?.endsAtText).toBe(ENDS_AT_TEXT);

      await deleteFeatured(db, actor, id);

      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        logName: "default",
        subjectType: "FeaturedContent",
        subjectId: String(id),
        causerId: actor.id,
        description: "deleted featured content Doomed headline",
      });
      expectFullSnapshot(audits[0]!.properties as AuditProps, FULL_SLOT);
    });

    it("missing-row delete throws NotFound and audits nothing", async () => {
      const { db } = fixture!;
      await expect(deleteFeatured(db, actor, 424242)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteFeatured(db, actor, 424242)).rejects.toMatchObject({
        message: "featured content not found",
      });
      expect(await db.select().from(activityLog)).toHaveLength(0);
    });

    it("second delete throws NotFound and audits nothing", async () => {
      const { db } = fixture!;
      const [seeded] = await db
        .insert(featuredContents)
        .values({ title: "Doomed headline", position: 1 })
        .returning();
      const id = seeded!.id;

      await deleteFeatured(db, actor, id);
      expect(await db.select().from(activityLog)).toHaveLength(1);

      await expect(deleteFeatured(db, actor, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteFeatured(db, actor, id)).rejects.toMatchObject({
        message: "featured content not found",
      });
      expect(await db.select().from(activityLog)).toHaveLength(1);
    });

    it("rolls back the row removal when the delete audit fails", async () => {
      const { db, client, schemaName } = fixture!;
      const [seeded] = await db
        .insert(featuredContents)
        .values({ title: "Doomed headline", position: 1 })
        .returning();
      const id = seeded!.id;
      // Only this fixture's delete audit fails; the row lock and delete run
      // first, so a non-transactional audit would leave the row deleted.
      await client.unsafe(`
      CREATE FUNCTION "${schemaName}".reject_featured_delete_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic audit failure on featured delete';
      END;
      $$;
      CREATE TRIGGER reject_featured_delete_audit
      BEFORE INSERT ON "${schemaName}".activity_log
      FOR EACH ROW WHEN (NEW.subject_type = 'FeaturedContent')
      EXECUTE FUNCTION "${schemaName}".reject_featured_delete_audit();
    `);

      await expect(deleteFeatured(db, actor, id)).rejects.toMatchObject({
        cause: { code: "P0001", message: "synthetic audit failure on featured delete" },
      });
      expect(await getFeatured(db, id)).toMatchObject({ id, title: "Doomed headline" });
      expect(await db.select().from(featuredContents)).toHaveLength(1);
      expect(await db.select().from(activityLog)).toHaveLength(0);
    });

    it.each([
      {
        name: "published",
        slot: {
          title: "Published slot",
          body: "Published body",
          url: "https://example.test/published",
          imageUrl: "/images/published.png",
          imageAlt: "Published alt",
          isPublished: true,
          position: 1,
          startsAt: null,
          endsAt: null,
        },
      },
      {
        name: "windowed",
        slot: {
          title: "Windowed slot",
          body: "Windowed body",
          url: "https://example.test/windowed",
          imageUrl: "/images/windowed.png",
          imageAlt: "Windowed alt",
          isPublished: true,
          position: 2,
          startsAt: STARTS_AT,
          endsAt: ENDS_AT,
        },
      },
      {
        name: "draft",
        slot: {
          title: "Draft slot",
          body: null,
          url: null,
          imageUrl: null,
          imageAlt: null,
          isPublished: false,
          position: 5,
          startsAt: null,
          endsAt: null,
        },
      },
    ])("a deleted $name slot is reconstructable from the activity log alone", async ({ slot }) => {
      const { db } = fixture!;
      const [seeded] = await db
        .insert(featuredContents)
        .values({ ...slot })
        .returning();
      const id = seeded!.id;

      await deleteFeatured(db, actor, id);

      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        subjectType: "FeaturedContent",
        subjectId: String(id),
        causerId: actor.id,
        description: `deleted featured content ${slot.title}`,
      });
      expect(reconstruct(audits[0]!.properties as AuditProps)).toEqual({
        title: slot.title,
        body: slot.body,
        url: slot.url,
        imageUrl: slot.imageUrl,
        imageAlt: slot.imageAlt,
        isPublished: slot.isPublished,
        position: slot.position,
        startsAt: slot.startsAt === null ? null : STARTS_AT_TEXT,
        endsAt: slot.endsAt === null ? null : ENDS_AT_TEXT,
      });
    });

    it("safe delete drops the row from visible reads and retires the homepage guest cache", async () => {
      const { db } = fixture!;
      const bindings = { ...env, ADMIN_DB: db };
      const [seeded] = await db
        .insert(featuredContents)
        .values({ title: "Cached headline", isPublished: true, position: 1 })
        .returning();
      const id = seeded!.id;

      // The guest cache serves the row before the delete.
      const cached = await cachedFeatured(bindings, async () => db, new Date());
      expect(cached.map((row) => row.id)).toContain(id);

      await deleteFeatured(db, actor, id);

      // No retire call here: the delete itself must have retired the cache,
      // or the stale entry would keep serving the deleted row.
      expect(await cachedFeatured(bindings, async () => db, new Date())).toEqual([]);
      expect(await getFeatured(db, id)).toBeNull();
      expect(await listVisibleFeatured(db, new Date())).toEqual([]);
      expect(await db.select().from(featuredContents)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toHaveLength(1);
    });
  },
);
