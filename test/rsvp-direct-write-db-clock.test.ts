// Direct-write updatedAt stamps on the post-lock database clock.
//
// Companion to the paired acceptance suite
// (test/rsvp-verdict-db-clock.test.ts, owned by that card and never edited
// here): its "stamps a fresh row" case writes Going, which settles as
// waitlisted and self-promotes, so the updatedAt it asserts is written by
// promoteWaitlist — not by the insert/onConflictDoUpdate this card changed.
// These cases write rows promotion never touches (a fresh non-seat answer,
// then a re-answer on an existing row) with the worker clock skewed decades
// from the database clock, so a stamp taken from the worker clock fails.
// Direct service calls against the disposable Postgres fixture (skipped
// without DATABASE_URL). Never point this at anything but a test container.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { writeRsvp } from "../src/events/rsvp";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const FUTURE_START = new Date("2099-01-01T20:00:00Z");
const FUTURE_END = new Date("2099-01-01T22:00:00Z");
const FUTURE_PRE_END = new Date("2099-01-01T21:00:00Z");
// Stored stamps are millisecond Dates read back through the driver; the
// database-clock window is widened a little so truncation cannot flake.
const STAMP_SLACK_MS = 2_000;

describe.skipIf(!process.env.DATABASE_URL)("writeRsvp direct-write stamps (agent-testdb)", () => {
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
  // insert so the arrangement bypasses the write gates.
  async function seed(startsAt: Date, endsAt: Date, capacity: number | null = 10) {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: `01W1${crypto
          .randomUUID()
          .replace(/[^0-9a-f]/g, "")
          .slice(0, 22)
          .toUpperCase()}`,
        title: "Direct-write clock night",
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

  it("stamps a fresh non-seat answer from the database clock, never the worker clock", async () => {
    // Both clocks agree the 2099 event is open, so the write lands either
    // way; only the updated stamp can betray a worker-clock source,
    // because the injected clock is decades from the database clock. A
    // non-seat answer settles without promotion, so the asserted stamp is
    // the insert's own — not promoteWaitlist's rewrite.
    const ev = await seed(FUTURE_START, FUTURE_END);

    const beforeMs = await dbNowMs();
    const result = await writeRsvp(db, ev.eventKey, "direct-maybe", "maybe", () => FUTURE_PRE_END);
    const afterMs = await dbNowMs();

    expect(result.ok).toBe(true);
    const [row] = await rows(ev.id);
    expect([[row!.userId, row!.status]]).toEqual([["direct-maybe", "maybe"]]);
    expectStampInDbWindow(row!.createdAt, beforeMs, afterMs);
    expectStampInDbWindow(row!.updatedAt, beforeMs, afterMs);
    expect(await hitsFor("direct-maybe")).toBe(1);
  });

  it("stamps a re-answer from the database clock, never the worker clock", async () => {
    // The second write takes the onConflictDoUpdate path on the existing
    // row; a non-seat re-answer leaves the line untouched, so the asserted
    // stamp is the upsert's own set — not promoteWaitlist's rewrite.
    const ev = await seed(FUTURE_START, FUTURE_END);
    const first = await writeRsvp(db, ev.eventKey, "re-answer", "maybe", () => new Date());
    expect(first.ok).toBe(true);

    const beforeMs = await dbNowMs();
    const result = await writeRsvp(db, ev.eventKey, "re-answer", "not_going", () => FUTURE_PRE_END);
    const afterMs = await dbNowMs();

    expect(result.ok).toBe(true);
    const [row] = await rows(ev.id);
    expect([[row!.userId, row!.status]]).toEqual([["re-answer", "not_going"]]);
    expectStampInDbWindow(row!.updatedAt, beforeMs, afterMs);
    expect(await hitsFor("re-answer")).toBe(2);
  });
});
