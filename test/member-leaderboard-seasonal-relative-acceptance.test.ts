// route-inventory: GET /leaderboards/members
// Acceptance (test files only) for the member leaderboard.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Route (v1, Hono + SvelteKit strangler shell serving the same reads, per the
// web/src/routes/events/past/ precedent):
// - `/leaderboards/members` — member leaderboard. Complements, never
//   duplicates, the sibling game-leaderboards `/leaderboards` + `/leaderboards/[game]`
//   boards. Builder exposes this path on the Hono app with the same aggregate
//   reads the Kit `load` calls, so this Vitest suite proves the contract; the
//   Kit shell under web/src/routes/leaderboards/members/ carries `csr = false`
//   and the same grammar. Ordering on every layer: auth gate, then query
//   validation (400s below precede any DB read), then aggregation.
//
// `?season=` — same pure date-window grammar as the hot-zone file:
// absent/`all` (default unbounded), `YYYY`, `YYYY-MM`, `YYYY-QN` (N 1..4);
// anything else -> 400. RSVP-derived counts filter by `events.startsAt` in
// the window. `?scope=` — absent/`overall` (default, full ranking);
// `relative` (viewer + 5 neighbors above/below, clamped to the board edges,
// at most 11 rows: the evidenced demotivation guard); `friends` is deferred
// (no friend graph exists) -> 400 naming the deferral, never a friend graph,
// never a silent overall board; anything else -> 400. `?activity=` — absent/
// `all` (default, going counts across every game in the window) or one
// normalized game name (`events.game` normalization shared with the sibling
// `[game]` drill-down: trimmed, lowercased, 1..64 chars of
// `[a-z0-9 _-]`), filtering to going RSVPs for events with that game.
// Syntactically invalid activity -> 400; well-formed but unmatched game ->
// 200 with zero rows. The `?activity=` game vocabulary and the sibling
// `?mode=` vocabulary both derive from existing fields only (`rsvps` going
// counts, `profiles.games`); v1 never invents per-user activity from
// messages, voice, or presence.
//
// Rows show rank + display name + aggregate count only — never timestamps,
// never presence. The board is member-gated like /members/:user: logged-out
// gets the sign-in bounce (302 to /auth/discord), never the board;
// signed-in non-members get 403, never the board.
//
// Rank key: count of `rsvps` with status `going` for published events in the
// window (game-filtered when `?activity=` names one), grouped by user_id,
// descending; ties break by user_id ascending (deterministic relative
// windows). Only members with at least one counted going appear. Every
// aggregate excludes opted-out (`profiles.leaderboard_opt_out`, boolean,
// default false, member-editable; single migration owned by whichever slice —
// this card's Builder B or the sibling's — merges first, the other reuses it)
// and erased members. No member-rank board ships before the toggle + one
// versioned privacy-policy paragraph land (same change).
//
// Analytics: anonymous board-view log mirroring `eventSearchLogs` in one
// shared `board_view_logs` table (whichever Builder A merges first owns the
// migration, the other reuses it): `normalized_board_key + scope + season +
// result_count + occurred_at`, no user id / session / IP columns, fail-open
// with write deadlines (a locked table degrades to an unrecorded view, never
// a broken board), 90-day prune. This board logs `normalized_board_key =
// 'members'`; hot-zone views log `hotzones` / `hotzones/<signal>` into the
// same table. Privacy floor unchanged: first-party anonymous counts only.
//
// How this fails before the Builder lands: the Hono path 404s (guest 302s,
// member 200s, and every 400 become 404), the Kit shell + privacy paragraph
// + new column/table are absent, and no anonymous row can be written.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { joinAttempts, profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { waitForNoLockWaiters } from "./helpers/wait-for-no-lock-waiters";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { POLICY_FILE } from "../src/privacy";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// All-digit 26-char import-shaped keys, so no secret scanner trips.
const gameKey = (n: number) => String(n).padStart(26, "0");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = (path: string) => resolve(root, path);

type Actor = { userId: string; username: string; member: boolean; moderator: boolean };
const MEMBER: Actor = {
  userId: "100000000000000201",
  username: "zxq-board-member",
  member: true,
  moderator: false,
};
const OUTSIDER: Actor = {
  userId: "100000000000000202",
  username: "zxq-board-outsider",
  member: false,
  moderator: false,
};

async function cookieFor(
  store: ReturnType<typeof createMemorySessionStore>,
  actor: Actor,
): Promise<string> {
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

describe("member leaderboard member-gating (no DB)", () => {
  it.each(["/leaderboards/members", "/leaderboards/members?scope=relative"])(
    "bounces a guest from %s to sign-in, never the board",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/auth/discord");
      const setCookies = res.headers.getSetCookie().join(";");
      expect(setCookies).toContain("__Host-two_login_intended=");
      expect(await res.text()).not.toContain("zxq-board-member");
    },
  );

  it.each(["/leaderboards/members?season=2026-09", "/leaderboards/members?activity=chess"])(
    "bounces a guest from %s before any grammar is evaluated",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/auth/discord");
    },
  );

  it("answers 403, never the board, for a signed-in non-member", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, OUTSIDER);
    const live = { ...env, SESSION_STORE: store } as unknown as Env;
    const res = await app.request("/leaderboards/members", { headers: { cookie } }, live);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("zxq-board-member");
  });
});

describe("member leaderboard query grammar (memory sessions, no DB)", () => {
  const memberEnv = async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    return { live: { ...env, SESSION_STORE: store } as unknown as Env, cookie };
  };

  it("serves the board to a signed-in member", async () => {
    const { live, cookie } = await memberEnv();
    const res = await app.request("/leaderboards/members", { headers: { cookie } }, live);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it.each(["neighbors", "friends-list", "ALL", ""])(
    "rejects ?scope=%s with 400, never a silent overall board",
    async (scope) => {
      const { live, cookie } = await memberEnv();
      const res = await app.request(
        `/leaderboards/members?scope=${encodeURIComponent(scope)}`,
        { headers: { cookie } },
        live,
      );
      expect(res.status).toBe(400);
    },
  );

  it("names the deferral for the deferred friends scope", async () => {
    const { live, cookie } = await memberEnv();
    const res = await app.request(
      "/leaderboards/members?scope=friends",
      { headers: { cookie } },
      live,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/friend|defer/i);
  });

  it.each(["!!!", "a".repeat(65), "chess!"])("rejects ?activity=%s with 400", async (activity) => {
    const { live, cookie } = await memberEnv();
    const res = await app.request(
      `/leaderboards/members?activity=${encodeURIComponent(activity)}`,
      { headers: { cookie } },
      live,
    );
    expect(res.status).toBe(400);
  });

  it.each(["last-season", "2026-13", "2026-Q0"])(
    "rejects ?season=%s with 400 before any aggregation",
    async (season) => {
      const { live, cookie } = await memberEnv();
      const res = await app.request(
        `/leaderboards/members?season=${encodeURIComponent(season)}`,
        { headers: { cookie } },
        live,
      );
      expect(res.status).toBe(400);
    },
  );
});

describe("member leaderboard shells + copy (no DB)", () => {
  it("ships a server-rendered members shell with the locked grammar", () => {
    expect(existsSync(shell("web/src/routes/leaderboards/members/+page.server.ts"))).toBe(true);
    expect(existsSync(shell("web/src/routes/leaderboards/members/+page.svelte"))).toBe(true);
    const server = readFileSync(
      shell("web/src/routes/leaderboards/members/+page.server.ts"),
      "utf8",
    );
    expect(server).toContain("csr = false");
    for (const token of ["overall", "relative", "season", "activity"]) {
      expect(server).toContain(token);
    }
  });

  it("versions one leaderboard opt-out paragraph in the privacy policy", () => {
    const policy = readFileSync(shell(POLICY_FILE), "utf8");
    expect(policy).toMatch(/leaderboard/i);
    expect(policy).toMatch(/opt.?out/i);
  });

  const srcFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return srcFiles(full);
      return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
    });

  it("logs board views fail-open with write deadlines, mirroring search-log", () => {
    const hits = srcFiles(shell("src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /board.view.logs/i.test(text) && /deadline|fail-open|LogWriteDeadline/i.test(text);
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("prunes anonymous board views by age like search logs", () => {
    const hits = srcFiles(shell("src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /board.view.logs/i.test(text) && /prune|90|retention|occurred_at/i.test(text);
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("member leaderboard (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let store: ReturnType<typeof createMemorySessionStore>;
  let live: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    store = createMemorySessionStore();
    live = {
      ...env,
      get ADMIN_DB() {
        return db;
      },
      SESSION_STORE: store,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const lockClient = () => {
    const safe = testDatabaseUrl(process.env.DATABASE_URL!);
    return postgres(safe.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => safe.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  };

  const memberIds = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(300 + i)}`);

  const seedBoard = async (opts: {
    prefix: string;
    goings: number[];
    game?: string;
    startsAt?: Date;
    keyBase?: number;
  }) => {
    const game = opts.game ?? "Chess";
    const startsAt = opts.startsAt ?? new Date("2026-09-08T19:00:00Z");
    const ids = memberIds(opts.prefix, opts.goings.length);
    await db.insert(users).values(
      ids.map((id, i) => ({
        id,
        username: `zxq-${opts.prefix}-m${String(i).padStart(2, "0")}`,
        member: true,
        avatar: null,
      })),
    );
    const needed = Math.max(...opts.goings);
    const eventIds: number[] = [];
    for (let e = 0; e < needed; e++) {
      const [row] = await db
        .insert(events)
        .values({
          eventKey: gameKey((opts.keyBase ?? 100) + e),
          title: `zxq ${game} night ${e}`,
          game,
          status: "published",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * 3600_000),
        })
        .returning();
      eventIds.push(row!.id);
    }
    for (let m = 0; m < ids.length; m++) {
      for (let g = 0; g < opts.goings[m]!; g++) {
        await db.insert(rsvps).values({ eventId: eventIds[g]!, userId: ids[m]!, status: "going" });
      }
    }
    return ids;
  };

  const board = (query: string, actor: Actor = MEMBER) =>
    cookieFor(store, actor).then((cookie) =>
      app.request(`/leaderboards/members${query}`, { headers: { cookie } }, live),
    );

  it("ranks by going counts, aggregates only", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [3, 2, 1], keyBase: 100 });
    const res = await board("?season=2026-09");
    expect(res.status).toBe(200);
    const html = await res.text();
    const [a, b, c] = ["m00", "m01", "m02"].map((s) =>
      html.indexOf(`zxq-100000000000000-${s}`),
    ) as [number, number, number];
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(html).toContain("3");
    expect(html).not.toMatch(/20\d\d-\d\d-\d\dT\d\d:/);
    expect(html).not.toContain("created_at");
    expect(html).not.toContain("discord_id");
    expect(html).not.toContain("presence");
  });

  it("breaks going-count ties by user id", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 2], keyBase: 120 });
    const html = await (await board("?season=2026-09")).text();
    expect(html.indexOf("zxq-100000000000000-m00")).toBeLessThan(
      html.indexOf("zxq-100000000000000-m01"),
    );
  });

  it("filters counts to the season window", async () => {
    await fixture.reset();
    const ids = await seedBoard({ prefix: "100000000000000", goings: [2, 2], keyBase: 140 });
    const [jan] = await db
      .insert(events)
      .values({
        eventKey: gameKey(160),
        title: "zxq January chess",
        game: "Chess",
        status: "published",
        startsAt: new Date("2025-01-07T19:00:00Z"),
        endsAt: new Date("2025-01-07T21:00:00Z"),
      })
      .returning();
    await db.insert(rsvps).values({ eventId: jan!.id, userId: ids[0]!, status: "going" });
    const sept = await (await board("?season=2026-09")).text();
    const january = await (await board("?season=2025-01")).text();
    expect(sept).not.toBe(january);
    expect(january).toContain("zxq-100000000000000-m00");
    expect(january).not.toContain("zxq-100000000000000-m01");
  });

  it("filters to one game with ?activity= and answers 200 with zero rows for an unmatched game", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 170, game: "Chess" });
    await seedBoard({ prefix: "100000000000001", goings: [1], keyBase: 180, game: "Go" });
    const chess = await (await board("?season=2026-09&activity=chess")).text();
    expect(chess).toContain("zxq-100000000000000-m00");
    expect(chess).not.toContain("zxq-100000000000001-m00");
    const empty = await board("?season=2026-09&activity=checkers");
    expect(empty.status).toBe(200);
    const emptyHtml = await empty.text();
    expect(emptyHtml).not.toContain("zxq-100000000000000-m00");
    expect(emptyHtml).not.toContain("zxq-100000000000001-m00");
  });

  it("centers the relative window on the viewer", async () => {
    await fixture.reset();
    const ids = await seedBoard({
      prefix: "100000000000000",
      goings: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      keyBase: 190,
    });
    const viewer: Actor = {
      userId: ids[6]!,
      username: "zxq-100000000000000-m06",
      member: true,
      moderator: false,
    };
    const overall = await (await board("?season=2026-09&scope=overall", viewer)).text();
    for (let i = 0; i < 13; i++)
      expect(overall).toContain(`zxq-100000000000000-m${String(i).padStart(2, "0")}`);
    const relative = await (await board("?season=2026-09&scope=relative", viewer)).text();
    expect(relative).toContain("zxq-100000000000000-m06");
    expect(relative).not.toContain("zxq-100000000000000-m00");
    expect(relative).not.toContain("zxq-100000000000000-m12");
    expect(relative).toContain("zxq-100000000000000-m01");
    expect(relative).toContain("zxq-100000000000000-m11");
  });

  it("clamps the relative window at the top edge", async () => {
    await fixture.reset();
    const ids = await seedBoard({
      prefix: "100000000000000",
      goings: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      keyBase: 220,
    });
    const viewer: Actor = {
      userId: ids[0]!,
      username: "zxq-100000000000000-m00",
      member: true,
      moderator: false,
    };
    const relative = await (await board("?season=2026-09&scope=relative", viewer)).text();
    expect(relative).toContain("zxq-100000000000000-m00");
    expect(relative).toContain("zxq-100000000000000-m01");
    expect(relative).not.toContain("zxq-100000000000000-m12");
  });

  it("provides the opt-out column defaulting to false", async () => {
    const cols = (await fixture.client.unsafe(
      `select column_name, column_default from information_schema.columns where table_schema = '${fixture.schemaName}' and table_name = 'profiles' and column_name = 'leaderboard_opt_out'`,
    )) as { column_name: string; column_default: string | null }[];
    expect(cols).toHaveLength(1);
    expect(cols[0]!.column_default ?? "").toContain("false");
  });

  it("excludes opted-out members from every aggregate", async () => {
    await fixture.reset();
    const ids = await seedBoard({ prefix: "100000000000000", goings: [3, 5], keyBase: 250 });
    await db
      .insert(profiles)
      .values({ userId: ids[1]!, leaderboardOptOut: true })
      .onConflictDoUpdate({ target: profiles.userId, set: { leaderboardOptOut: true } });
    const html = await (await board("?season=2026-09")).text();
    expect(html).toContain("zxq-100000000000000-m00");
    expect(html).not.toContain("zxq-100000000000000-m01");
  });

  it("excludes erased members and never invents activity from joins", async () => {
    await fixture.reset();
    const ids = await seedBoard({ prefix: "100000000000000", goings: [3, 5], keyBase: 260 });
    // Erasure removes the member rows; the aggregate must follow, not linger.
    await db.delete(rsvps);
    await db.delete(profiles);
    await db.delete(users);
    await db.insert(users).values([
      { id: ids[0]!, username: "zxq-100000000000000-m00", member: true, avatar: null },
      { id: ids[1]!, username: "zxq-100000000000000-m01", member: true, avatar: null },
    ]);
    const [row] = await db
      .insert(events)
      .values({
        eventKey: gameKey(280),
        title: "zxq erased-member event",
        game: "Chess",
        status: "published",
        startsAt: new Date("2026-09-09T19:00:00Z"),
        endsAt: new Date("2026-09-09T21:00:00Z"),
      })
      .returning();
    await db.insert(rsvps).values({ eventId: row!.id, userId: ids[0]!, status: "going" });
    // A join attempt with no goings is not board activity.
    await db.insert(joinAttempts).values({
      outcome: "added",
      source: "zxq-erasure-probe",
      requestId: "zxq-erasure-probe-0",
      discordId: ids[1]!,
      createdAt: new Date("2026-09-09T19:05:00Z"),
    });
    const html = await (await board("?season=2026-09")).text();
    expect(html).toContain("zxq-100000000000000-m00");
    expect(html).not.toContain("zxq-100000000000000-m01");
  });

  it("logs one anonymous row per board view, nothing identifying", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 290 });
    await fixture.client.unsafe("delete from board_view_logs");
    const res = await board("?season=2026-09&scope=overall");
    expect(res.status).toBe(200);
    const rows = (await fixture.client.unsafe(
      "select normalized_board_key, scope, season, result_count, occurred_at from board_view_logs order by occurred_at desc limit 1",
    )) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalized_board_key: "members",
      scope: "overall",
      season: "2026-09",
      result_count: 2,
    });
    const cols = (await fixture.client.unsafe(
      `select column_name from information_schema.columns where table_schema = '${fixture.schemaName}' and table_name = 'board_view_logs'`,
    )) as { column_name: string }[];
    const names = cols.map((c) => c.column_name);
    for (const required of [
      "normalized_board_key",
      "scope",
      "season",
      "result_count",
      "occurred_at",
    ]) {
      expect(names).toContain(required);
    }
    for (const forbidden of ["user_id", "discord_id", "session_id", "ip_address", "username"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("still serves the board when the view log is locked (fail-open)", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [1], keyBase: 300 });
    const locker = lockClient();
    try {
      await locker.begin(async (tx) => {
        await tx`lock table board_view_logs in access exclusive mode`;
        const t0 = Date.now();
        const res = await board("?season=2026-09");
        expect(res.status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(10_000);
        expect(
          await waitForNoLockWaiters(
            async () =>
              (
                (await tx`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%board_view_logs%' and pid <> pg_backend_pid()`) as unknown as {
                  n: number;
                }[]
              )[0]!.n,
            { timeoutMs: 2000 },
          ),
        ).toBe(true);
      });
    } finally {
      await locker.end();
    }
  }, 30_000);
});
