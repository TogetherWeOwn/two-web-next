// The baseline runner's one SELECT against a real activity_log: an event
// first published before the window and republished inside it must not count
// as a first publish, and a save that only stamped updatedAt is no re-edit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error standalone mjs has no type declarations
import { computeReeditShare, fetchActivityRows } from "../bin/event-reedit-baseline.mjs";
import { activityLog } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const windowStart = new Date("2026-10-01T00:00:00Z");
const windowEnd = new Date("2026-10-29T00:00:00Z");
const fetchEnd = new Date("2026-10-29T01:00:00Z");

const row = (subjectId: string, iso: string, description: string, properties: object) => ({
  description,
  subjectType: "Event",
  subjectId,
  causerId: "baseline-moderator",
  properties: properties as Record<string, { before: unknown; after: unknown }>,
  createdAt: new Date(iso),
});
const published = { status: { before: "draft", after: "published" } };

describe.skipIf(!process.env.DATABASE_URL)(
  "event re-edit baseline query (isolated test Postgres)",
  () => {
    let fixture: MemberDataFixture | undefined;
    beforeEach(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      await fixture.reset();
    });
    afterEach(async () => {
      await fixture?.dispose();
      fixture = undefined;
    });

    it("excludes republished events and bookkeeping-only saves", async () => {
      const { db, client } = fixture!;
      await db.insert(activityLog).values([
        // First published before the window, unpublished, republished inside.
        row("again", "2026-09-30T10:00:00Z", "published event Again", published),
        row("again", "2026-09-30T12:00:00Z", "unpublished event Again", {
          status: { before: "published", after: "draft" },
        }),
        row("again", "2026-10-02T10:00:00Z", "published event Again", published),
        row("again", "2026-10-02T10:20:00Z", "updated event Again", {
          title: { before: "Again", after: "Again!" },
        }),
        // A real content edit 30 minutes after publishing.
        row("fixed", "2026-10-03T10:00:00Z", "published event Fixed", published),
        row("fixed", "2026-10-03T10:30:00Z", "updated event Fixed", {
          startsAt: { before: "2026-10-10T18:00:00.000Z", after: "2026-10-10T19:00:00.000Z" },
        }),
        // A save that changed nothing but the updatedAt stamp.
        row("noop", "2026-10-04T10:00:00Z", "published event Noop", published),
        row("noop", "2026-10-04T10:10:00Z", "updated event Noop", {
          updatedAt: { before: "2026-10-04T10:00:00.000Z", after: "2026-10-04T10:10:00.000Z" },
        }),
        // Pre-window edits are never fetched.
        row("old", "2026-09-20T10:00:00Z", "updated event Old", {
          title: { before: "a", after: "b" },
        }),
      ]);

      const rows = await fetchActivityRows(client, { windowStart, fetchEnd });
      expect(rows.some((r: { subjectId: string }) => r.subjectId === "old")).toBe(false);
      expect(rows.filter((r: { subjectId: string }) => r.subjectId === "again")).toHaveLength(3);

      const report = computeReeditShare(rows, { windowStart, windowEnd, observedUntil: fetchEnd });
      expect(report).toMatchObject({ published: 2, reedited: 1, underObserved: 0 });
      expect(report.sharePercent).toBe(50);
    });
  },
);
