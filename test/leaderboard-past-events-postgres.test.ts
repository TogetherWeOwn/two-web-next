// Finished events keep counting.
//
// Regression: the 10-minute close job (closeFinished, src/jobs/events.ts)
// flips ended events from `published` to `past`. The member leaderboard and
// the hotzones event count filtered `published` only, so every finished night
// dropped out of both. A `past` event with a `going` RSVP inside the season
// window must count on the overall board, the relative board, and in the
// hotzones event count; `draft` and `cancelled` events still never count.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { loadJoinsGrid } from "../src/hotzones/aggregates";
import { parseSeasonParam, type SeasonWindow } from "../src/hotzones/season";
import { loadMemberRanking } from "../src/leaderboards/members";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const MEMBER = "100000000000000731";
const season = (): SeasonWindow => {
  const window = parseSeasonParam("2026-09");
  if (window?.kind !== "window") throw new Error("expected a 2026-09 window");
  return window;
};

describe.skipIf(!process.env.DATABASE_URL)("past events count on boards and hotzones", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  async function seed(statuses: string[]): Promise<void> {
    await fixture.reset();
    await db
      .insert(users)
      .values({ id: MEMBER, username: "zxq-past-member", member: true, avatar: null });
    for (const [i, status] of statuses.entries()) {
      const startsAt = new Date(Date.UTC(2026, 8, 10 + i, 19));
      const [event] = await db
        .insert(events)
        .values({
          eventKey: `0000000000000000000000973${i}`,
          title: `zxq ${status} night`,
          game: "Chess",
          status,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * 3600_000),
        })
        .returning({ id: events.id });
      await db.insert(rsvps).values({ eventId: event!.id, userId: MEMBER, status: "going" });
    }
  }

  it("counts a past event on the overall board", async () => {
    await seed(["past"]);
    await expect(loadMemberRanking(db, season(), null)).resolves.toEqual([
      { userId: MEMBER, username: "zxq-past-member", count: 1 },
    ]);
  });

  it("counts a past event on the relative board", async () => {
    await seed(["past"]);
    await expect(loadMemberRanking(db, season(), null, "relative", MEMBER)).resolves.toEqual([
      { userId: MEMBER, username: "zxq-past-member", count: 1, rank: 1 },
    ]);
  });

  it("counts a past event in the hotzones event count", async () => {
    await seed(["past"]);
    const { eventCount } = await loadJoinsGrid(db, season());
    expect(eventCount).toBe(1);
  });

  it("counts published and past together, never draft or cancelled", async () => {
    await seed(["published", "past", "draft", "cancelled"]);
    await expect(loadMemberRanking(db, season(), null)).resolves.toEqual([
      { userId: MEMBER, username: "zxq-past-member", count: 2 },
    ]);
    await expect(loadMemberRanking(db, season(), null, "relative", MEMBER)).resolves.toEqual([
      { userId: MEMBER, username: "zxq-past-member", count: 2, rank: 1 },
    ]);
    expect((await loadJoinsGrid(db, season())).eventCount).toBe(2);
  });
});
