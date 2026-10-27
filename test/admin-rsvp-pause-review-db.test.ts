// Independent acceptance (DB-gated): a reviewed pause alone mutates no
// waitlist row, and activity-log entries keep the existing shape.
//
// These are preserved-behavior controls: the review step is UI-only and the
// pause endpoint keeps calling setRsvpOpen ordered under the same event lock.
// They run only with DATABASE_URL on the disposable agent-testdb fixtures and
// must stay GREEN on the unmodified tree.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { setRsvpOpen } from "../src/admin/store";
import { newEventKey } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const actor = { id: "100000000000000111", username: "mod" };

describe.skipIf(!process.env.DATABASE_URL)(
  "RSVP pause review persistence controls (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
      const [row] = await fixture.db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Pause review night",
          startsAt: new Date("2099-01-01T20:00:00Z"),
          endsAt: new Date("2099-01-01T22:00:00Z"),
          status: "published",
          ...over,
        })
        .returning();
      return row!;
    };

    it("a pause alone mutates no waitlist row", async () => {
      const row = await seed({ capacity: 1 });
      const stamp = new Date("2026-01-01T00:00:00Z");
      await fixture.db.insert(rsvps).values([
        { eventId: row.id, userId: "going-member", status: "going" },
        {
          eventId: row.id,
          userId: "first",
          status: "waitlisted",
          createdAt: stamp,
          syncedToDiscordAt: stamp,
        },
        {
          eventId: row.id,
          userId: "second",
          status: "waitlisted",
          createdAt: new Date(stamp.getTime() + 1000),
          syncedToDiscordAt: stamp,
        },
      ]);
      const before = await fixture.db.select().from(rsvps);
      const { row: paused } = await setRsvpOpen(fixture.db, actor, row.eventKey, false);
      expect(paused.rsvpOpen).toBe(false);
      const after = await fixture.db.select().from(rsvps);
      expect(after).toEqual(before);
      expect(after.find((r) => r.userId === "first")).toMatchObject({
        status: "waitlisted",
        syncedToDiscordAt: stamp,
      });
      expect(after.find((r) => r.userId === "going-member")).toMatchObject({ status: "going" });
    });

    it("pause and reopen activity entries keep the existing shape", async () => {
      const row = await seed();
      await setRsvpOpen(fixture.db, actor, row.eventKey, false);
      await setRsvpOpen(fixture.db, actor, row.eventKey, true);
      const audits = await fixture.db.select().from(activityLog);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        logName: "default",
        description: `paused RSVPs for event ${row.title}`,
        subjectType: "Event",
        subjectId: row.eventKey,
        causerId: actor.id,
        properties: { rsvpOpen: { before: true, after: false } },
      });
      expect(audits[1]).toMatchObject({
        logName: "default",
        description: `reopened RSVPs for event ${row.title}`,
        subjectType: "Event",
        subjectId: row.eventKey,
        causerId: actor.id,
        properties: { rsvpOpen: { before: false, after: true } },
      });
    });
  },
);
