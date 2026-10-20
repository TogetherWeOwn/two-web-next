// route-inventory: GET /leaderboards/members
// Acceptance (test files only): the relative member board answers from a
// bounded ranking read instead of fetching one row per ranked member and
// slicing the viewer's +/-5 window in application code.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass. This file is
// acceptance-owned: the Builder never edits it and returns it to the Test
// Author if a test looks wrong.
//
// Locked contract:
// - Serving a relative view (Hono route and the shared Kit loader) fetches
//   at most MAX_RELATIVE_FETCHED_ROWS database result rows for the ranking,
//   and that fetched-row count is identical whether the seeded community
//   holds 30 or 330 ranked members. "Fetched rows" is every result row the
//   driver returns on the database handle the route/loader is given, so the
//   bound holds for any internal design (window CTE, rank lookup plus
//   LIMIT/OFFSET, ...) and cannot be met by fetching everything and slicing.
// - Visible rows are identical to today for a viewer at the top edge, the
//   bottom edge, mid-board, and unranked (no rows, the "not ranked" copy):
//   ranks, usernames and counts, in `count DESC, user_id ASC` tie order.
// - Counting is unchanged: only `going` RSVPs for published events inside
//   the season window count; the `?activity=` game filter still applies;
//   opted-out members, non-members and erased members never appear, never
//   shift a rank, and never shift a window.
// - The overall scope is untouched: still capped at 100 rows, still the
//   same rows. The route still serves 200 inside the member-read boundary,
//   which means every statement the relative read issues still matches the
//   statement-shape guard (a guard mismatch refuses the read and the board
//   answers 503, so a served board proves the match).
// - No new throttle, cache or schema migration is needed to pass: the same
//   seeded database serves both community sizes back to back.
//
// How this fails before the Builder lands: the relative scope issues the
// full grouped ranking read, so a 330-member community makes the driver
// return 330 rows for an 11-row window and the fetched count grows with
// community size. Every visible-window, tie, filter and overall-cap control
// passes today and must keep passing.
import { drizzle } from "drizzle-orm/postgres-js";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { adminSchema, schema } from "../src/db/index";
import { memberReadDb } from "../src/db/member-reads";
import type { Env } from "../src/env";
import { loadMembersBoardData } from "../src/kit-members";
import { profiles, users } from "../src/db/schema";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// The visible relative window is at most 11 rows (viewer +/- 5). A bounded
// read may fetch a small constant multiple of that (a rank lookup row, an
// edge-recentering fetch, ...), never the ranking itself.
const MAX_RELATIVE_FETCHED_ROWS = 40;
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

type Row = { rank: number; username: string; count: number };

describe.skipIf(!process.env.DATABASE_URL)(
  "relative member board bounded read (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let counting: ReturnType<typeof postgres>;
    let fetchedRows = 0;
    let observedDb: MemberDataFixture["db"];
    let store: ReturnType<typeof createMemorySessionStore>;
    let live: Env;

    // Ranked member r (1-based) has MAX_COUNT+1-r counted goings, except the
    // three-way tie at ranks 8..10 (count 28). User ids ascend with rank, so
    // `count DESC, user_id ASC` lists members in index order throughout.
    const SMALL = 30;
    const LARGE = 330;
    const MAX_COUNT = 35;
    const EVENTS = 40;
    const memberId = (r: number) => `100000000000000${String(400 + r)}`;
    const fillerId = (j: number) => `200000000000000${String(400 + j)}`;
    const memberName = (r: number) => `zxq-rel-m${String(r).padStart(3, "0")}`;
    const fillerName = (j: number) => `zxq-rel-f${String(j).padStart(3, "0")}`;
    const countFor = (r: number) => (r >= 8 && r <= 10 ? 28 : MAX_COUNT + 1 - r);
    const OPTOUT_ID = "100000000000000390";
    const ERASED_ID = "100000000000000391";
    const NONMEMBER_ID = "100000000000000392";
    const UNRANKED_ID = "100000000000000393";
    const UNRANKED_NAME = "zxq-rel-unranked";

    const windowRows = (lo: number, hi: number): Row[] =>
      Array.from({ length: hi - lo + 1 }, (_, k) => {
        const r = lo + k;
        return { rank: r, username: memberName(r), count: countFor(r) };
      });

    type Actor = { userId: string; username: string; member: boolean; moderator: boolean };
    const asActor = (r: number): Actor => ({
      userId: memberId(r),
      username: memberName(r),
      member: true,
      moderator: false,
    });

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

    const htmlRows = (html: string): Row[] => {
      const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1];
      if (!tbody) return [];
      return [
        ...tbody.matchAll(
          /<tr[^>]*>\s*<td>(\d+)<\/td>\s*<th[^>]*>([^<]+)<\/th>\s*<td>(\d+)<\/td>/g,
        ),
      ].map((m) => ({ rank: Number(m[1]), username: m[2]!, count: Number(m[3]) }));
    };

    async function board(query: string, actor: Actor) {
      const cookie = await cookieFor(actor);
      fetchedRows = 0;
      const res = await app.request(`/leaderboards/members${query}`, { headers: { cookie } }, live);
      const fetched = fetchedRows;
      const html = await res.text();
      return { status: res.status, html, rows: htmlRows(html), fetched };
    }

    async function kitBoard(actor: Actor) {
      fetchedRows = 0;
      const data = await loadMembersBoardData({
        env,
        session: { status: "authenticated", userId: actor.userId, member: true },
        seasonParam: "2026-09",
        scopeParam: "relative",
        activityParam: null,
        setHeaders: () => {},
        dbForFn: async () => observedDb,
      } as never);
      const fetched = fetchedRows;
      return {
        rows: data.rows.map(({ rank, username, count }) => ({ rank, username, count })),
        viewers: data.rows.map((r) => r.isViewer),
        fetched,
      };
    }

    async function seedCommunity(rankedCount: number) {
      await fixture.reset();
      // The board-view log and member-access log sit outside reset()'s
      // deletes; clear them through the seed handle so no earlier test's
      // audit rows leak into the next community.
      await fixture.client.unsafe("delete from board_view_logs");
      await fixture.client.unsafe("delete from member_data_access_logs");

      const fillerCount = rankedCount - SMALL;
      await db.insert(users).values([
        ...Array.from({ length: SMALL }, (_, k) => ({
          id: memberId(k + 1),
          username: memberName(k + 1),
          member: true,
          avatar: null,
        })),
        ...Array.from({ length: fillerCount }, (_, j) => ({
          id: fillerId(j),
          username: fillerName(j),
          member: true,
          avatar: null,
        })),
        { id: OPTOUT_ID, username: "zxq-rel-optout", member: true, avatar: null },
        { id: ERASED_ID, username: "zxq-rel-erased", member: true, avatar: null },
        { id: NONMEMBER_ID, username: "zxq-rel-nonmember", member: false, avatar: null },
        { id: UNRANKED_ID, username: UNRANKED_NAME, member: true, avatar: null },
      ]);
      await db.insert(profiles).values({ userId: OPTOUT_ID, leaderboardOptOut: true });

      const gameKey = (n: number) => String(n).padStart(26, "0");
      const starts = (e: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + e * 3600_000);
      const published = await db
        .insert(events)
        .values(
          Array.from({ length: EVENTS }, (_, e) => ({
            eventKey: gameKey(5000 + e),
            title: `zxq rel chess ${e}`,
            game: "Chess",
            status: "published",
            startsAt: starts(e),
            endsAt: new Date(starts(e).getTime() + 2 * 3600_000),
          })),
        )
        .returning({ id: events.id });
      const eventIds = published.map((row) => row.id);
      const [draft] = await db
        .insert(events)
        .values({
          eventKey: gameKey(6000),
          title: "zxq rel draft",
          game: "Chess",
          status: "draft",
          startsAt: starts(5),
          endsAt: new Date(starts(5).getTime() + 2 * 3600_000),
        })
        .returning({ id: events.id });

      const rows: { eventId: number; userId: string; status: string }[] = [];
      for (let r = 1; r <= SMALL; r++) {
        for (let g = 0; g < countFor(r); g++) {
          rows.push({ eventId: eventIds[g]!, userId: memberId(r), status: "going" });
        }
      }
      // Every filler ranks strictly below the named members (1 going each),
      // so the named tail of the small board is mid-board once grown.
      for (let j = 0; j < fillerCount; j++) {
        rows.push({ eventId: eventIds[0]!, userId: fillerId(j), status: "going" });
      }
      // Would outrank everyone, but excluded: opt-out and non-member. The
      // erased member also outranks everyone until its user row is deleted
      // below; its orphaned RSVPs must not rank or shift anyone.
      for (const id of [OPTOUT_ID, ERASED_ID, NONMEMBER_ID]) {
        for (let g = 0; g < EVENTS; g++) {
          rows.push({ eventId: eventIds[g]!, userId: id, status: "going" });
        }
      }
      // Counted never: non-going answers and goings on a draft event.
      rows.push({ eventId: eventIds[36]!, userId: memberId(1), status: "maybe" });
      rows.push({ eventId: eventIds[37]!, userId: memberId(1), status: "not_going" });
      rows.push({ eventId: draft!.id, userId: memberId(1), status: "going" });
      // The unranked viewer is a member with no counted going at all.
      rows.push({ eventId: eventIds[38]!, userId: UNRANKED_ID, status: "maybe" });
      for (let at = 0; at < rows.length; at += 2000) {
        await db.insert(rsvps).values(rows.slice(at, at + 2000));
      }
      // Erasure: the member rows go, orphaned RSVP rows stay behind.
      await fixture.client.unsafe(`delete from users where id = '${ERASED_ID}'`);
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      // Row-counting handle: a second schema-scoped client whose `unsafe`
      // tallies every result row the driver returns. Drizzle (postgres-js)
      // executes all builders and raw sql through it, including inside
      // transactions, so the tally is the route's true row transfer on the
      // handle it is handed. Seeds run on fixture.client and never count.
      const safe = testDatabaseUrl(process.env.DATABASE_URL!);
      counting = postgres(safe.href, {
        max: 1,
        port: 5432,
        connect_timeout: 5,
        password: () => safe.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      type Unsafe = typeof counting.unsafe;
      type Pending = ReturnType<Unsafe>;
      const inner = counting.unsafe.bind(counting) as Unsafe;
      const counted = ((query: string, params?: unknown, options?: unknown) => {
        const pending = inner(query as never, params as never, options as never) as Pending;
        const then = pending.then.bind(pending) as Pending["then"];
        (pending as { then: Pending["then"] }).then = ((
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) =>
          then(
            ((rows: unknown) => {
              if (Array.isArray(rows)) fetchedRows += rows.length;
              return onFulfilled ? onFulfilled(rows) : rows;
            }) as never,
            onRejected as never,
          )) as Pending["then"];
        return pending;
      }) as Unsafe;
      (counting as { unsafe: Unsafe }).unsafe = counted;
      const countedDb = drizzle(counting, { schema: { ...schema, ...adminSchema } });
      observedDb = memberReadDb(countedDb as never) as MemberDataFixture["db"];

      store = createMemorySessionStore();
      live = {
        ...env,
        get ADMIN_DB() {
          return observedDb;
        },
        SESSION_STORE: store,
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as unknown as Env;
    }, 120_000);

    afterAll(async () => {
      await counting?.end({ timeout: 1 });
      await fixture?.dispose();
    });

    it("fetches a bounded, size-independent row count for a mid-board viewer", async () => {
      await seedCommunity(SMALL);
      const small = await board("?season=2026-09&scope=relative", asActor(15));
      expect(small.status).toBe(200);
      const expected = windowRows(10, 20);
      expect(small.rows).toEqual(expected);
      expect(small.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);

      await seedCommunity(LARGE);
      const large = await board("?season=2026-09&scope=relative", asActor(15));
      expect(large.status).toBe(200);
      expect(large.rows).toEqual(expected);
      expect(large.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);
      expect(large.fetched).toBe(small.fetched);
    }, 120_000);

    it("keeps identical edge and unranked windows in a large community, still bounded", async () => {
      await seedCommunity(LARGE);

      const top = await board("?season=2026-09&scope=relative", asActor(1));
      expect(top.status).toBe(200);
      expect(top.rows).toEqual(windowRows(1, 6));
      expect(top.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);

      // Named rank 30 sits mid-board now: fillers take over below it.
      const tail = await board("?season=2026-09&scope=relative", asActor(30));
      expect(tail.status).toBe(200);
      expect(tail.rows).toHaveLength(11);
      expect(tail.rows.slice(0, 6)).toEqual(windowRows(25, 30));
      expect(tail.rows.slice(6)).toEqual(
        [31, 32, 33, 34, 35].map((rank, k) => ({ rank, username: fillerName(k), count: 1 })),
      );
      expect(tail.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);

      const unranked = await board("?season=2026-09&scope=relative", {
        userId: UNRANKED_ID,
        username: UNRANKED_NAME,
        member: true,
        moderator: false,
      });
      expect(unranked.status).toBe(200);
      expect(unranked.rows).toEqual([]);
      expect(unranked.html).toContain("You are not ranked for this season and game yet.");
      expect(unranked.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);
    }, 120_000);

    it("keeps the bottom-edge window identical in a small community (control)", async () => {
      await seedCommunity(SMALL);
      const bottom = await board("?season=2026-09&scope=relative", asActor(30));
      expect(bottom.status).toBe(200);
      expect(bottom.rows).toEqual(windowRows(25, 30));

      const top = await board("?season=2026-09&scope=relative", asActor(2));
      expect(top.rows).toEqual(windowRows(1, 7));
    }, 120_000);

    it("serves the same bounded windows through the shared Kit loader", async () => {
      await seedCommunity(LARGE);
      const mid = await kitBoard(asActor(15));
      expect(mid.rows).toEqual(windowRows(10, 20));
      expect(mid.viewers).toEqual(mid.rows.map((r) => r.rank === 15));
      expect(mid.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);

      const unranked = await kitBoard({
        userId: UNRANKED_ID,
        username: UNRANKED_NAME,
        member: true,
        moderator: false,
      });
      expect(unranked.rows).toEqual([]);
      expect(unranked.fetched).toBeLessThanOrEqual(MAX_RELATIVE_FETCHED_ROWS);
    }, 120_000);

    it("preserves tie order, filters and the overall cap (control)", async () => {
      await seedCommunity(LARGE);
      const overall = await board("?season=2026-09&scope=overall", asActor(15));
      expect(overall.status).toBe(200);
      expect(overall.rows).toHaveLength(100);
      expect(overall.rows[0]).toEqual({ rank: 1, username: memberName(1), count: MAX_COUNT });
      // Ranks 8..10 tie at 28 goings: user_id ASC keeps them in index order.
      expect(overall.rows.slice(7, 10)).toEqual(windowRows(8, 10));
      expect(overall.rows[29]).toEqual({ rank: 30, username: memberName(30), count: 6 });
      expect(overall.rows[30]).toEqual({ rank: 31, username: fillerName(0), count: 1 });
      expect(overall.rows[99]!.rank).toBe(100);
      for (const excluded of ["zxq-rel-optout", "zxq-rel-erased", "zxq-rel-nonmember"]) {
        expect(overall.html).not.toContain(excluded);
      }
      expect(overall.rows.some((r) => r.username === UNRANKED_NAME)).toBe(false);

      const relative = await board("?season=2026-09&scope=relative", asActor(9));
      expect(relative.rows).toEqual(windowRows(4, 14));
    }, 120_000);

    it("keeps the game filter on the relative read (control)", async () => {
      await seedCommunity(SMALL);
      const chess = await board("?season=2026-09&scope=relative&activity=chess", asActor(15));
      expect(chess.rows).toEqual(windowRows(10, 20));
      const go = await board("?season=2026-09&scope=relative&activity=go", asActor(15));
      expect(go.status).toBe(200);
      expect(go.rows).toEqual([]);
      expect(go.html).toContain("You are not ranked for this season and game yet.");
    }, 120_000);
  },
);
