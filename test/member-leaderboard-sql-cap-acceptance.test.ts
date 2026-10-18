// route-inventory: GET /leaderboards/members
// Acceptance (test files only): the overall member board is aggregated in
// SQL with a cap, instead of materialising one row per counted `going` RSVP
// and folding counts in application code.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass. This file is
// acceptance-owned: the Builder never edits it and returns it to the Test
// Author if a test looks wrong.
//
// Locked contract:
// - The overall board is capped at the top 100 members (ranks 1..100).
//   `boardRows(ranked, "overall", viewer)` returns at most 100 rows, and
//   `loadMemberRanking(db, window, game)` — still callable with exactly
//   these three arguments — returns at most 100 rows for the board it feeds.
// - The ranking read is bounded in SQL: one observed statement aggregates
//   with GROUP BY + COUNT and carries a LIMIT, so thousands of `going` rows
//   never become thousands of result rows. Ordering stays
//   `count DESC, userId ASC`, including the tie-break at the cap boundary:
//   of two members tied on count at ranks 100/101, the lower user id keeps
//   the last capped slot.
// - Counting is unchanged: only `going` RSVPs for published events inside
//   the season window count; the `?activity=` game filter still applies;
//   opted-out members and non-members never appear and never consume a
//   capped slot.
// - The relative scope is unchanged even beyond the cap: a viewer ranked
//   below #100 still gets their own ±5 window from the route, so capping
//   the overall read must not silently shrink the relative board.
//
// How this fails before the Builder lands: the overall read returns every
// ranked member (130+ rows here) with no GROUP BY / COUNT / LIMIT statement,
// `boardRows` returns the whole ranking for `overall`, and the route HTML
// lists members past rank 100. Counting, filtering and relative-window
// controls pass today and must keep passing.
import { drizzle } from "drizzle-orm/postgres-js";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { adminSchema, schema } from "../src/db/index";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { parseSeasonParam } from "../src/hotzones/season";
import { type RankedMember, boardRows, loadMemberRanking } from "../src/leaderboards/members";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const OVERALL_CAP = 100;
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const rankedFixture = (n: number): RankedMember[] =>
  Array.from({ length: n }, (_, i) => ({
    userId: `1000000000000003${String(i).padStart(3, "0")}`,
    username: `member-${i}`,
    count: n - i,
  }));

describe("overall board cap in boardRows (no DB)", () => {
  it("caps the overall scope at the top 100 rows, ranks 1..100", () => {
    const board = rankedFixture(250);
    const rows = boardRows(board, "overall", board[0]!.userId);
    expect(rows).toHaveLength(OVERALL_CAP);
    expect(rows[0]).toMatchObject({ userId: board[0]!.userId, rank: 1 });
    expect(rows[OVERALL_CAP - 1]).toMatchObject({
      userId: board[OVERALL_CAP - 1]!.userId,
      rank: OVERALL_CAP,
    });
    expect(rows.some((r) => r.userId === board[OVERALL_CAP]!.userId)).toBe(false);
  });

  it("returns an exactly-100 ranking whole (control)", () => {
    const rows = boardRows(rankedFixture(100), "overall", "x");
    expect(rows).toHaveLength(100);
    expect(rows[99]!.rank).toBe(100);
  });

  it("keeps the relative window intact deep in a long ranking (control)", () => {
    const board = rankedFixture(250);
    const rows = boardRows(board, "relative", board[200]!.userId);
    expect(rows.map((r) => r.rank)).toEqual([
      196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206,
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "overall board SQL aggregation + cap (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let queries: string[] = [];
    let countedDb: MemberDataFixture["db"];
    let store: ReturnType<typeof createMemorySessionStore>;
    let live: Env;

    // 130 ranked members: member i has 130-i counted goings, except member
    // 100 is bumped to 31 so members 99 and 100 tie exactly at the cap
    // boundary (ranks 100 and 101). Lower user id = lower index throughout.
    const RANKED = 130;
    const EVENTS = 135;
    const memberId = (i: number) => `100000000000000${String(300 + i)}`;
    const memberName = (i: number) => `zxq-cap-m${String(i).padStart(3, "0")}`;
    const countedGoings = (i: number) => (i === 100 ? 31 : RANKED - i);
    const OPTOUT_ID = "100000000000000290";
    const NONMEMBER_ID = "100000000000000291";
    const GO_IDS = ["100000000000000500", "100000000000000501"];
    const sept = () => parseSeasonParam("2026-09")!;

    type Actor = { userId: string; username: string; member: boolean; moderator: boolean };
    const VIEWER: Actor = {
      userId: "100000000000000201",
      username: "zxq-cap-viewer",
      member: true,
      moderator: false,
    };

    async function cookieFor(actor: Actor): Promise<string> {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: actor.userId,
        username: actor.username,
        avatar: null,
        member: actor.member,
        moderator: actor.moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }

    const boardHtml = async (query: string, actor: Actor = VIEWER) => {
      const cookie = await cookieFor(actor);
      const res = await app.request(`/leaderboards/members${query}`, { headers: { cookie } }, live);
      expect(res.status).toBe(200);
      return res.text();
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      // Statement-observing handle over the same pool: only reads issued
      // through it are captured, never the seeds below.
      countedDb = drizzle(fixture.client, {
        schema: { ...schema, ...adminSchema },
        logger: {
          logQuery(query) {
            queries.push(query);
          },
        },
      });
      store = createMemorySessionStore();
      live = {
        ...env,
        get ADMIN_DB() {
          return db;
        },
        SESSION_STORE: store,
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as unknown as Env;

      await db.insert(users).values([
        ...Array.from({ length: RANKED }, (_, i) => ({
          id: memberId(i),
          username: memberName(i),
          member: true,
          avatar: null,
        })),
        { id: OPTOUT_ID, username: "zxq-cap-optout", member: true, avatar: null },
        { id: NONMEMBER_ID, username: "zxq-cap-nonmember", member: false, avatar: null },
        { id: GO_IDS[0]!, username: "zxq-cap-go0", member: true, avatar: null },
        { id: GO_IDS[1]!, username: "zxq-cap-go1", member: true, avatar: null },
      ]);
      await db.insert(profiles).values({ userId: OPTOUT_ID, leaderboardOptOut: true });

      const gameKey = (n: number) => String(n).padStart(26, "0");
      const starts = (e: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + e * 3600_000);
      const published = await db
        .insert(events)
        .values(
          Array.from({ length: EVENTS }, (_, e) => ({
            eventKey: gameKey(1000 + e),
            title: `zxq cap chess ${e}`,
            game: "Chess",
            status: "published",
            startsAt: starts(e),
            endsAt: new Date(starts(e).getTime() + 2 * 3600_000),
          })),
        )
        .returning({ id: events.id });
      const eventIds = published.map((row) => row.id);
      const drafts = await db
        .insert(events)
        .values(
          [0, 1].map((e) => ({
            eventKey: gameKey(2000 + e),
            title: `zxq cap draft ${e}`,
            game: "Chess",
            status: "draft",
            startsAt: starts(10 + e),
            endsAt: new Date(starts(10 + e).getTime() + 2 * 3600_000),
          })),
        )
        .returning({ id: events.id });
      const goEvents = await db
        .insert(events)
        .values(
          [0, 1].map((e) => ({
            eventKey: gameKey(3000 + e),
            title: `zxq cap go ${e}`,
            game: "Go",
            status: "published",
            startsAt: starts(20 + e),
            endsAt: new Date(starts(20 + e).getTime() + 2 * 3600_000),
          })),
        )
        .returning({ id: events.id });

      // Thousands of going rows: ~8.5k across the ranked members alone.
      const rows: { eventId: number; userId: string; status: string }[] = [];
      for (let i = 0; i < RANKED; i++) {
        for (let g = 0; g < countedGoings(i); g++) {
          rows.push({ eventId: eventIds[g]!, userId: memberId(i), status: "going" });
        }
      }
      // Would outrank everyone, but excluded: opt-out and non-member.
      for (let g = 0; g < EVENTS; g++) {
        rows.push({ eventId: eventIds[g]!, userId: OPTOUT_ID, status: "going" });
      }
      for (let g = 0; g < EVENTS - 1; g++) {
        rows.push({ eventId: eventIds[g]!, userId: NONMEMBER_ID, status: "going" });
      }
      // Counted never: non-going answers and goings on draft events.
      rows.push({ eventId: eventIds[130]!, userId: memberId(0), status: "maybe" });
      rows.push({ eventId: eventIds[131]!, userId: memberId(0), status: "not_going" });
      for (const draft of drafts) {
        rows.push({ eventId: draft.id, userId: memberId(0), status: "going" });
      }
      rows.push({ eventId: goEvents[0]!.id, userId: GO_IDS[0]!, status: "going" });
      rows.push({ eventId: goEvents[1]!.id, userId: GO_IDS[0]!, status: "going" });
      rows.push({ eventId: goEvents[0]!.id, userId: GO_IDS[1]!, status: "going" });
      for (let at = 0; at < rows.length; at += 2000) {
        await db.insert(rsvps).values(rows.slice(at, at + 2000));
      }
    }, 120_000);

    afterAll(async () => {
      await fixture?.dispose();
    });

    it("answers the ranking from a bounded GROUP BY + COUNT + LIMIT statement", async () => {
      queries = [];
      const ranked = await loadMemberRanking(countedDb, sept(), null);
      expect(ranked.length).toBeGreaterThan(0);
      const aggregated = queries.filter(
        (q) => /group\s+by/i.test(q) && /count\s*\(/i.test(q) && /\blimit\b/i.test(q),
      );
      expect(aggregated.length).toBeGreaterThan(0);
      expect(queries.length).toBeLessThanOrEqual(3);
    });

    it("caps the ranking at 100 with the cap-boundary tie broken by user id", async () => {
      const ranked = await loadMemberRanking(db, sept(), null);
      expect(ranked).toHaveLength(OVERALL_CAP);
      expect(ranked[0]).toEqual({ userId: memberId(0), username: memberName(0), count: 130 });
      for (let i = 1; i < ranked.length; i++) {
        const prev = ranked[i - 1]!;
        const next = ranked[i]!;
        expect(
          prev.count > next.count || (prev.count === next.count && prev.userId < next.userId),
        ).toBe(true);
      }
      // Members 99 and 100 both have 31 goings: 99 keeps slot 100, 100 is out.
      expect(ranked[OVERALL_CAP - 1]).toEqual({
        userId: memberId(99),
        username: memberName(99),
        count: 31,
      });
      expect(ranked.some((r) => r.userId === memberId(100))).toBe(false);
      expect(ranked.some((r) => r.userId === OPTOUT_ID)).toBe(false);
      expect(ranked.some((r) => r.userId === NONMEMBER_ID)).toBe(false);
    });

    it("keeps exact going-only, published-only, game-filtered counts (control)", async () => {
      const ranked = await loadMemberRanking(db, sept(), null);
      const byId = new Map(ranked.map((r) => [r.userId, r]));
      // maybe/not_going answers and draft-event goings never inflate #1.
      expect(byId.get(memberId(0))?.count).toBe(130);
      expect(byId.get(memberId(5))?.count).toBe(125);
      expect(byId.has(OPTOUT_ID)).toBe(false);
      expect(byId.has(NONMEMBER_ID)).toBe(false);
      const go = await loadMemberRanking(db, sept(), "go");
      expect(go).toEqual([
        { userId: GO_IDS[0]!, username: "zxq-cap-go0", count: 2 },
        { userId: GO_IDS[1]!, username: "zxq-cap-go1", count: 1 },
      ]);
    });

    it("renders only the top 100 on the overall route", async () => {
      const html = await boardHtml("?season=2026-09&scope=overall");
      expect(html).toContain(memberName(0));
      expect(html).toContain(memberName(99));
      expect(html).not.toContain(memberName(100));
      expect(html).not.toContain(memberName(129));
      expect(html).not.toContain("zxq-cap-optout");
      expect(html).not.toContain("zxq-cap-nonmember");
    });

    it("still centers the relative route on a viewer ranked below the cap (control)", async () => {
      // Member 114 is rank 115: window is ranks 110..120 (members 109..119).
      const actor: Actor = {
        userId: memberId(114),
        username: memberName(114),
        member: true,
        moderator: false,
      };
      const html = await boardHtml("?season=2026-09&scope=relative", actor);
      expect(html).toContain(memberName(114));
      expect(html).toContain(memberName(109));
      expect(html).toContain(memberName(119));
      expect(html).not.toContain(memberName(108));
      expect(html).not.toContain(memberName(120));
      expect(html).not.toContain(memberName(0));
    });
  },
);
