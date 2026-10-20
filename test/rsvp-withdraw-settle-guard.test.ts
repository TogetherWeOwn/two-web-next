// Past-end settle refusal: a waitlisted attendee's withdrawal deletes their
// own row but must not settle the line once the event has ended on the
// post-lock database clock, even when the caller's frozen worker clock still
// sees it as live. Companion to test/rsvp-withdraw-clock.test.ts: its
// stranger case deletes no row, so promotion never runs and the frozen clock
// cannot matter there; this file pins the attendee case the guard must
// refuse. Direct service calls against the disposable Postgres fixture
// (skipped without DATABASE_URL). Never point this at anything but a test
// container.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { withdrawRsvp } from "../src/events/rsvp";
import { waitlistPosition } from "../src/events/waitlist";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SYNCED_STAMP = new Date("2020-01-03T00:00:00.000Z");

describe.skipIf(!process.env.DATABASE_URL)(
  "withdrawRsvp past-end settle refusal (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let client: MemberDataFixture["client"];

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      db = fixture.db;
      client = fixture.client;
    });
    beforeEach(async () => {
      await fixture.reset();
      await client`delete from web_throttle_hits`;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const rows = (eventId: number) =>
      db.select().from(rsvps).where(eq(rsvps.eventId, eventId)).orderBy(rsvps.id);

    it("deletes a waitlisted attendee past the end without settling the line under a frozen pre-end worker clock", async () => {
      // The database clock is years after this event ended; only the frozen
      // worker clock still sees it as live. A vacant seat beside the line
      // means a worker-clock promotion would visibly move the second waiter.
      const [ev] = await db
        .insert(events)
        .values({
          eventKey: `01W1${crypto
            .randomUUID()
            .replace(/[^0-9a-f]/g, "")
            .slice(0, 22)
            .toUpperCase()}`,
          title: "Settle refusal night",
          startsAt: new Date("2020-01-01T20:00:00Z"),
          endsAt: new Date("2020-01-01T22:00:00Z"),
          timezone: "UTC",
          location: "Voice",
          status: "published",
          capacity: 1,
        })
        .returning();
      const event = ev!;
      await db.insert(rsvps).values({ eventId: event.id, userId: "head", status: "waitlisted" });
      await db.insert(rsvps).values({ eventId: event.id, userId: "second", status: "waitlisted" });
      await client`update rsvps set created_at = '2020-01-01T00:00:00Z', synced_to_discord_at = '2020-01-03T00:00:00Z' where event_id = ${event.id}`;
      const preEnd = new Date("2020-01-01T21:00:00Z");

      const result = await withdrawRsvp(db, event.eventKey, "head", () => preEnd);

      // The attendee's own row is gone ...
      expect(result).toEqual({ limited: false, deleted: true, status: "published" });
      // ... but the guard refused to settle the line on the database clock.
      const after = await rows(event.id);
      expect(after.map((r) => [r.userId, r.status])).toEqual([["second", "waitlisted"]]);
      expect(after[0]!.syncedToDiscordAt).toEqual(SYNCED_STAMP);
      expect(await waitlistPosition(db, event.id, "second")).toBe(1);
    });
  },
);
