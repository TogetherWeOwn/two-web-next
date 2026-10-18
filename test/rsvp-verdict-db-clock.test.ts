// RSVP verdicts on the post-lock database clock: writeRsvp must judge
// whether an event has ended (and stamp the rows it writes) from the
// database clock read inside the transaction, not from the worker clock
// the caller injects. Direct service calls against the disposable
// Postgres fixture (skipped without DATABASE_URL, like
// test/rsvp-withdraw-clock.test.ts). Never point this at anything but a
// test container.
//
// The database clock here is the fixture's real wall time, so each
// new-behavior case puts the event end on the opposite side of the two
// clocks: an event that ended years ago by the database clock is still
// open to a worker clock frozen before its end, and an event decades
// from ending is already over to a worker clock frozen past its end.
// A verdict taken from the worker clock gives the opposite outcome
// from the one the database clock requires.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { withdrawRsvp, writeRsvp } from "../src/events/rsvp";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const PAST_START = new Date("2020-01-01T20:00:00Z");
const PAST_END = new Date("2020-01-01T22:00:00Z");
const PAST_PRE_END = new Date("2020-01-01T21:00:00Z");
const FUTURE_START = new Date("2099-01-01T20:00:00Z");
const FUTURE_END = new Date("2099-01-01T22:00:00Z");
const FUTURE_PRE_END = new Date("2099-01-01T21:00:00Z");
const FUTURE_POST_END = new Date(FUTURE_END.getTime() + 3600_000);
const SEEDED_STAMP = new Date("2020-01-01T00:00:00.000Z");
// Stored stamps are millisecond Dates read back through the driver; the
// database-clock window is widened a little so truncation cannot flake.
const STAMP_SLACK_MS = 2_000;

describe.skipIf(!process.env.DATABASE_URL)(
  "writeRsvp database-clock verdicts (agent-testdb)",
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

    const hitsFor = async (userId: string) => {
      const hits =
        await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${userId}`}`;
      return hits[0]!.n as number;
    };

    const dbNowMs = async () => {
      const [row] = await client`select clock_timestamp() as now`;
      return new Date(row!.now as Date).getTime();
    };

    const expectStampInDbWindow = (stamp: Date, beforeMs: number, afterMs: number) => {
      expect(stamp.getTime()).toBeGreaterThanOrEqual(beforeMs - STAMP_SLACK_MS);
      expect(stamp.getTime()).toBeLessThanOrEqual(afterMs + STAMP_SLACK_MS);
    };

    // One published event between the given instants, seeded by direct
    // insert so ended/future arrangements bypass the write gates.
    async function seed(startsAt: Date, endsAt: Date, capacity: number | null = 10) {
      const [ev] = await db
        .insert(events)
        .values({
          eventKey: `01W1${crypto
            .randomUUID()
            .replace(/[^0-9a-f]/g, "")
            .slice(0, 22)
            .toUpperCase()}`,
          title: "Database clock night",
          startsAt,
          endsAt,
          timezone: "UTC",
          location: "Voice",
          status: "published",
          capacity,
        })
        .returning();
      return ev!;
    }

    it("accepts a going write when the worker and database clocks agree the event is open (control)", async () => {
      const ev = await seed(FUTURE_START, FUTURE_END);

      const result = await writeRsvp(db, ev.eventKey, "agree-open", "going", () => new Date());

      expect(result.ok).toBe(true);
      expect((await rows(ev.id)).map((r) => [r.userId, r.status])).toEqual([
        ["agree-open", "going"],
      ]);
      expect(await hitsFor("agree-open")).toBe(1);
    });

    it("refuses a going write when the worker and database clocks agree the event has ended (control)", async () => {
      const ev = await seed(PAST_START, PAST_END);

      const result = await writeRsvp(db, ev.eventKey, "agree-ended", "going", () => new Date());

      expect(result).toEqual({ ok: false, reason: "closed", why: "past" });
      expect(await rows(ev.id)).toHaveLength(0);
      expect(await hitsFor("agree-ended")).toBe(0);
    });

    it("refuses when the worker clock is behind the database clock and the database clock is past the end", async () => {
      // The event ended in 2020 by the database (wall) clock; only the
      // injected worker clock, frozen an hour before that end, still
      // sees it as open.
      const ev = await seed(PAST_START, PAST_END);

      const result = await writeRsvp(db, ev.eventKey, "behind-worker", "going", () => PAST_PRE_END);

      expect(result).toEqual({ ok: false, reason: "closed", why: "past" });
      expect(await rows(ev.id)).toHaveLength(0);
      // A refusal spends no write budget.
      expect(await hitsFor("behind-worker")).toBe(0);
    });

    it("accepts when the worker clock is ahead of the database clock and the database clock is before the end", async () => {
      // The event ends in 2099 by the database (wall) clock; only the
      // injected worker clock, frozen an hour past that end, already
      // sees it as over.
      const ev = await seed(FUTURE_START, FUTURE_END);

      const result = await writeRsvp(
        db,
        ev.eventKey,
        "ahead-worker",
        "going",
        () => FUTURE_POST_END,
      );

      expect(result.ok).toBe(true);
      expect((await rows(ev.id)).map((r) => [r.userId, r.status])).toEqual([
        ["ahead-worker", "going"],
      ]);
      expect(await hitsFor("ahead-worker")).toBe(1);
    });

    it("stamps a fresh row's created and updated stamps from the one database clock", async () => {
      // Both clocks agree the 2099 event is open, so the write lands
      // either way; only the stamps can betray a worker-clock source,
      // because the injected clock is decades from the database clock.
      const ev = await seed(FUTURE_START, FUTURE_END);

      const beforeMs = await dbNowMs();
      const result = await writeRsvp(
        db,
        ev.eventKey,
        "stamp-source",
        "going",
        () => FUTURE_PRE_END,
      );
      const afterMs = await dbNowMs();

      expect(result.ok).toBe(true);
      const [row] = await rows(ev.id);
      expectStampInDbWindow(row!.createdAt, beforeMs, afterMs);
      expectStampInDbWindow(row!.updatedAt, beforeMs, afterMs);
      // Sibling stamps from a single clock read sit together, not
      // decades apart.
      expect(Math.abs(row!.updatedAt.getTime() - row!.createdAt.getTime())).toBeLessThanOrEqual(
        5_000,
      );
    });

    it("stamps a waitlist promotion from the database clock, never the worker clock", async () => {
      // A single-seat 2099 event: both clocks are before its end, so the
      // withdrawal promotes the head either way; only the promoted
      // row's updated stamp can betray a worker-clock source.
      const ev = await seed(FUTURE_START, FUTURE_END, 1);
      await db.insert(rsvps).values({ eventId: ev.id, userId: "holder", status: "going" });
      await db.insert(rsvps).values({ eventId: ev.id, userId: "head", status: "waitlisted" });
      await client`update rsvps set created_at = '2020-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z' where event_id = ${ev.id}`;

      const beforeMs = await dbNowMs();
      const result = await withdrawRsvp(db, ev.eventKey, "holder", () => FUTURE_PRE_END);
      const afterMs = await dbNowMs();

      expect(result.limited).toBe(false);
      const after = await rows(ev.id);
      expect(after.map((r) => [r.userId, r.status])).toEqual([["head", "going"]]);
      // Promotion rewrites the updated stamp from the database clock and
      // leaves the original creation stamp untouched.
      expect(after[0]!.createdAt).toEqual(SEEDED_STAMP);
      expectStampInDbWindow(after[0]!.updatedAt, beforeMs, afterMs);
    });
  },
);
