// Database-clock withdrawal: withdrawRsvp judges waitlist promotion against
// the post-lock database clock, not the caller's frozen worker clock (the
// clock param is a test seam and fallback only). Direct service calls against
// the disposable Postgres fixture (skipped without DATABASE_URL, like
// test/rsvp-waitlist.test.ts). Never point this at anything but a test
// container.
//
// Each case is arranged so the database (wall) clock and the frozen worker
// clock disagree about whether the event has ended: a withdrawal judged on
// the worker clock gives the opposite promotion outcome from the one the
// database clock requires.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { withdrawRsvp } from "../src/events/rsvp";
import { waitlistPosition } from "../src/events/waitlist";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SYNCED_STAMP = new Date("2020-01-03T00:00:00.000Z");

describe.skipIf(!process.env.DATABASE_URL)("withdrawRsvp frozen clock (agent-testdb)", () => {
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

  // One published single-seat event between the given instants, seeded by
  // direct inserts so ended/future arrangements bypass the write gates.
  async function seed(startsAt: Date, endsAt: Date) {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: `01W1${crypto
          .randomUUID()
          .replace(/[^0-9a-f]/g, "")
          .slice(0, 22)
          .toUpperCase()}`,
        title: "Frozen clock night",
        startsAt,
        endsAt,
        timezone: "UTC",
        location: "Voice",
        status: "published",
        capacity: 1,
      })
      .returning();
    return ev!;
  }

  // Holder in the only seat, then a stamped two-deep line behind them.
  // Same-instant created_at makes row ID the FIFO tie-break, as in
  // test/rsvp-waitlist.test.ts fullWithLine.
  async function seedFullWithLine(startsAt: Date, endsAt: Date) {
    const ev = await seed(startsAt, endsAt);
    await db.insert(rsvps).values({ eventId: ev.id, userId: "holder", status: "going" });
    await db.insert(rsvps).values({ eventId: ev.id, userId: "head", status: "waitlisted" });
    await db.insert(rsvps).values({ eventId: ev.id, userId: "second", status: "waitlisted" });
    await client`update rsvps set created_at = '2020-01-01T00:00:00Z', synced_to_discord_at = '2020-01-03T00:00:00Z' where event_id = ${ev.id}`;
    return ev;
  }

  it("promotes the head when the database clock is before the end despite a frozen past-end worker clock", async () => {
    // The database clock is decades before this event ends; only the frozen
    // worker clock already sees it as over, and it no longer governs.
    const endsAt = new Date("2099-01-01T22:00:00Z");
    const ev = await seedFullWithLine(new Date("2099-01-01T20:00:00Z"), endsAt);
    const pastEnd = new Date(endsAt.getTime() + 3600_000);

    const result = await withdrawRsvp(db, ev.eventKey, "holder", () => pastEnd);

    expect(result.limited).toBe(false);
    const after = await rows(ev.id);
    expect(after.map((r) => [r.userId, r.status])).toEqual([
      ["head", "going"],
      ["second", "waitlisted"],
    ]);
    // Promotion clears the mirror stamp of the promoted head only.
    expect(after[0]!.syncedToDiscordAt).toBeNull();
    expect(after[1]!.syncedToDiscordAt).toEqual(SYNCED_STAMP);
    expect(await waitlistPosition(db, ev.id, "head")).toBeNull();
    expect(await waitlistPosition(db, ev.id, "second")).toBe(1);
  });

  it("promotes nobody when the database clock is past the end despite a frozen pre-end worker clock", async () => {
    // The database clock is years after this event ended; only the frozen
    // worker clock still sees it as live, and it no longer governs.
    const ev = await seedFullWithLine(
      new Date("2020-01-01T20:00:00Z"),
      new Date("2020-01-01T22:00:00Z"),
    );
    const preEnd = new Date("2020-01-01T21:00:00Z");

    const result = await withdrawRsvp(db, ev.eventKey, "holder", () => preEnd);

    expect(result.limited).toBe(false);
    const after = await rows(ev.id);
    // The withdrawal itself still lands; the line does not move.
    expect(after.map((r) => [r.userId, r.status])).toEqual([
      ["head", "waitlisted"],
      ["second", "waitlisted"],
    ]);
    expect(after.filter((r) => r.status === "going")).toHaveLength(0);
    // Promotion clears the mirror stamp; an unpromoted head keeps it.
    expect(after[0]!.syncedToDiscordAt).toEqual(SYNCED_STAMP);
    expect(await waitlistPosition(db, ev.id, "head")).toBe(1);
    expect(await waitlistPosition(db, ev.id, "second")).toBe(2);
  });

  it("withdrawing a non-attendee is a quiet no-op under a frozen clock past the end", async () => {
    // A waitlisted line beside a vacant seat (seeded directly): settling
    // the line is the only visible effect a stray withdrawal could have,
    // and a withdrawal that deletes no row never settles it.
    const endsAt = new Date("2099-01-01T22:00:00Z");
    const ev = await seed(new Date("2099-01-01T20:00:00Z"), endsAt);
    await db.insert(rsvps).values({ eventId: ev.id, userId: "head", status: "waitlisted" });
    await db.insert(rsvps).values({ eventId: ev.id, userId: "second", status: "waitlisted" });
    await client`update rsvps set created_at = '2020-01-01T00:00:00Z', synced_to_discord_at = '2020-01-03T00:00:00Z' where event_id = ${ev.id}`;
    const before = await rows(ev.id);
    const pastEnd = new Date(endsAt.getTime() + 3600_000);

    const result = await withdrawRsvp(db, ev.eventKey, "stranger", () => pastEnd);

    expect(result.limited).toBe(false);
    expect(await rows(ev.id)).toEqual(before);
    expect(await waitlistPosition(db, ev.id, "head")).toBe(1);
  });
});
