// Year-0000 seasons stay servable with a database present.
//
// Regression: literal year-0 windows bind `0000-..` ISO bounds, which
// Postgres rejects (22008, no year 0) — and postgres-js rewrites any string
// bound to a timestamptz param through `new Date(x).toISOString()`, so BC
// text cannot travel as a bound param either. Both SQL consumers
// (loadJoinsGrid, loadMemberRanking) clamp year-0 bounds to 0001-01-01T00Z,
// which is result-exact: every year-0 window ends on or before 0001-01-01,
// so the clamp yields the empty range exactly where the true window holds no
// app-reachable rows. The windows themselves stay literal (see
// test/hotzone-season-window.test.ts); only the SQL binds move.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { joinAttempts, users } from "../src/db/schema";
import { loadJoinsGrid } from "../src/hotzones/aggregates";
import { parseSeasonParam, pgSeasonBound, type SeasonWindow } from "../src/hotzones/season";
import { loadMemberRanking } from "../src/leaderboards/members";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const windowOf = (raw: string): Extract<SeasonWindow, { kind: "window" }> => {
  const window = parseSeasonParam(raw);
  if (window?.kind !== "window") throw new Error(`expected window for ${raw}`);
  return window;
};

describe("pgSeasonBound (no DB)", () => {
  it.each(["0000", "0000-01", "0000-12", "0000-Q1", "0000-Q4"])(
    "clamps the year-0 bounds of %s to 0001-01-01T00Z",
    (raw) => {
      const window = windowOf(raw);
      expect(pgSeasonBound(window.start).toISOString()).toBe("0001-01-01T00:00:00.000Z");
      expect(pgSeasonBound(window.end).toISOString()).toBe("0001-01-01T00:00:00.000Z");
    },
  );

  it.each(["0001", "0001-01", "0099", "0099-12", "0100", "2026", "2026-09"])(
    "leaves the bounds of %s untouched (same object, same wire bytes)",
    (raw) => {
      const window = windowOf(raw);
      expect(pgSeasonBound(window.start)).toBe(window.start);
      expect(pgSeasonBound(window.end)).toBe(window.end);
    },
  );
});

describe.skipIf(!process.env.DATABASE_URL)("year-0000 seasons resolve against Postgres", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it.each(["0000", "0000-01", "0000-Q4"])(
    "loadJoinsGrid(%s) resolves empty, never 22008",
    async (raw) => {
      await fixture.reset();
      const { cells, total, eventCount } = await loadJoinsGrid(db, windowOf(raw));
      expect(total).toBe(0);
      expect(eventCount).toBe(0);
      expect(cells.flat().every((n) => n === 0)).toBe(true);
    },
  );

  it.each(["0000", "0000-01", "0000-Q4"])(
    "loadMemberRanking(%s) resolves empty, never 22008",
    async (raw) => {
      await fixture.reset();
      await expect(loadMemberRanking(db, windowOf(raw), null)).resolves.toEqual([]);
    },
  );

  it("keeps the 0000/0001 boundary exact: a year-1 row counts only in 0001", async () => {
    await fixture.reset();
    const first = new Date("0001-06-01T12:00:00.000Z");
    await db.insert(users).values({
      id: "100000000000000701",
      username: "zxq-y1k-member",
      member: true,
      avatar: null,
    });
    const [event] = await db
      .insert(events)
      .values({
        eventKey: "00000000000000000000009001",
        title: "zxq year-1 gathering",
        game: "Chess",
        status: "published",
        startsAt: first,
        endsAt: new Date(first.getTime() + 2 * 3600_000),
      })
      .returning({ id: events.id });
    await db
      .insert(rsvps)
      .values({ eventId: event!.id, userId: "100000000000000701", status: "going" });
    await db.insert(joinAttempts).values({
      outcome: "added",
      source: "zxq-year-zero",
      requestId: "zxq-year-zero-0",
      discordId: null,
      createdAt: first,
    });
    // The true window [0000-01-01, 0001-01-01) excludes the year-1 rows, and
    // so does the clamped empty range: both read empty without throwing.
    const zero = windowOf("0000");
    const joinsZero = await loadJoinsGrid(db, zero);
    expect(joinsZero.total).toBe(0);
    expect(joinsZero.eventCount).toBe(0);
    await expect(loadMemberRanking(db, zero, null)).resolves.toEqual([]);
    // The neighboring bindable window still counts the same rows.
    const one = windowOf("0001");
    const joinsOne = await loadJoinsGrid(db, one);
    expect(joinsOne.total).toBe(1);
    expect(joinsOne.eventCount).toBe(1);
    const ranked = await loadMemberRanking(db, one, null);
    expect(ranked).toEqual([
      { userId: "100000000000000701", username: "zxq-y1k-member", count: 1 },
    ]);
  });

  it("keeps 0099 resolving empty (control: bindable before and after)", async () => {
    await fixture.reset();
    const { total, eventCount } = await loadJoinsGrid(db, windowOf("0099"));
    expect(total).toBe(0);
    expect(eventCount).toBe(0);
    await expect(loadMemberRanking(db, windowOf("0099"), null)).resolves.toEqual([]);
  });
});
