import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFeatured } from "../src/admin/store";
import type { FeaturedFormInput } from "../src/admin/validation";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const actor = { id: "featured-create-moderator", username: "different-display-name" };
const input: FeaturedFormInput = {
  title: "Community night",
  body: "Join the next community event.",
  url: "https://example.test/events/community-night",
  imageUrl: "/images/community-night.png",
  imageAlt: "Members playing together",
  isPublished: true,
  position: 7,
  startsAtUtc: new Date("2026-10-08T18:00:00.000Z"),
  endsAtUtc: new Date("2026-10-09T18:00:00.000Z"),
};

describe.skipIf(!process.env.DATABASE_URL)("featured creation atomicity (isolated test Postgres)", () => {
  let fixture: MemberDataFixture | undefined;
  beforeEach(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  it("rolls back after the feature insert when its audit fails, then retries without duplicates", async () => {
    const { db, client, schemaName } = fixture!;
    // Only this fixture's audit table fails. The trigger checks the candidate
    // exists before rejecting its audit; no test-owned transaction masks the bug.
    await client.unsafe(`
      CREATE FUNCTION "${schemaName}".reject_featured_create_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "${schemaName}".featured_contents
          WHERE id::text = NEW.subject_id) THEN
          RAISE EXCEPTION 'featured candidate missing before audit';
        END IF;
        RAISE EXCEPTION 'synthetic audit failure after featured insert';
      END;
      $$;
      CREATE TRIGGER reject_featured_create_audit
      BEFORE INSERT ON "${schemaName}".activity_log
      FOR EACH ROW WHEN (NEW.subject_type = 'FeaturedContent')
      EXECUTE FUNCTION "${schemaName}".reject_featured_create_audit();
    `);

    await expect(createFeatured(db, actor, input)).rejects.toMatchObject({
      cause: { code: "P0001", message: "synthetic audit failure after featured insert" },
    });
    expect(await db.select().from(featuredContents)).toEqual([]);
    expect(await db.select().from(activityLog)).toEqual([]);

    await client.unsafe(`DROP TRIGGER reject_featured_create_audit ON "${schemaName}".activity_log`);
    const row = await createFeatured(db, actor, input);
    expect(await db.select().from(featuredContents)).toEqual([row]);
    const audits = await db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      subjectType: "FeaturedContent",
      subjectId: String(row.id),
      causerId: actor.id,
      description: `created featured content ${input.title}`,
    });
  });

  it.each([true, false])("preserves the returned row, actor and dirty properties (published=%s)", async (isPublished) => {
    const { db } = fixture!;
    const values: FeaturedFormInput = isPublished ? input : {
      ...input,
      isPublished: false,
      position: 0,
      body: null,
      url: null,
      imageUrl: null,
      imageAlt: null,
      startsAtUtc: null,
      endsAtUtc: null,
    };
    const row = await createFeatured(db, actor, values);
    expect(row).toMatchObject({
      title: values.title,
      body: values.body,
      url: values.url,
      imageUrl: values.imageUrl,
      imageAlt: values.imageAlt,
      isPublished,
      position: values.position,
      startsAt: values.startsAtUtc,
      endsAt: values.endsAtUtc,
      createdBy: actor.id,
      legacyId: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(await db.select().from(featuredContents)).toEqual([row]);
    const audits = await db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      logName: "default",
      subjectType: "FeaturedContent",
      subjectId: String(row.id),
      causerId: actor.id,
      causerType: null,
      description: `created featured content ${values.title}`,
    });
    expect(audits[0]!.properties).toEqual({
      id: { before: null, after: row.id },
      title: { before: null, after: values.title },
      isPublished: { before: null, after: isPublished },
      position: { before: null, after: values.position },
      createdBy: { before: null, after: actor.id },
      createdAt: { before: null, after: row.createdAt.toISOString() },
      updatedAt: { before: null, after: row.updatedAt.toISOString() },
      ...(isPublished ? {
        body: { before: null, after: values.body },
        url: { before: null, after: values.url },
        imageUrl: { before: null, after: values.imageUrl },
        imageAlt: { before: null, after: values.imageAlt },
        startsAt: { before: null, after: values.startsAtUtc!.toISOString() },
        endsAt: { before: null, after: values.endsAtUtc!.toISOString() },
      } : {}),
    });
  });
});
