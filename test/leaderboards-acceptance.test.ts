// Acceptance tests: Game leaderboards + per-game drill-down (multi-board design).
// Test Author slice for TOG-22864 (blocks the build card): test files only, no src changes.
// These tests FAIL until the Builder lands the leaderboard slice. They lock the
// contract the Builder implements; do not weaken them to make a change pass.
//
// Locked contract (v1, Hono + server-rendered HTML in this repo):
// - Routes: GET /leaderboards (overall) + GET /leaderboards/:game (per-game drill-down).
// - ?mode= overall | attended | relative-modes below; unknown mode -> 400.
//   attended ranks by RSVP-going aggregates, hosted ranks by events created_by
//   aggregates (both columns already exist; no new per-user activity is collected).
// - ?season= all (default) | YYYY (calendar-year window over events.startsAt,
//   the seasonal reset); unknown season -> 400, never a silent overall board.
// - ?scope= overall (default) | relative (window around the viewer, member-only).
//   friends is DEFERRED (no friend graph exists): ?scope=friends -> 400/501 with
//   a message saying so, never a silent overall board. Unknown scope -> 400.
//   Invalid mode/season/scope are rejected BEFORE any database read (these tests
//   provide no ADMIN_DB for the 400 cases to prove it).
// - Member-only boards like /members/:user: guest -> 302 /auth/discord, never the
//   board; signed-in non-member -> 403; member -> 200 HTML. Rank rows show rank +
//   display name + aggregate count only: no timestamps, no presence/activity.
// - Opt-out: profiles.leaderboard_opt_out boolean default false, member-editable;
//   opted-out members are excluded from every board. No board ships before the
//   toggle + privacy copy land (the /privacy test below pins the copy).
// - Erased members (member-erasure) vanish from every board automatically: their
//   users/profiles/rsvps rows are gone, and boards aggregate only those sources.
// - Analytics: board_view_logs(normalized_board_key, scope, season, result_count,
//   occurred_at) mirroring event_search_logs via src/events/search-log.ts:
//   normalized key + result count only, no user/session/IP columns, fail-open
//   with write/read deadlines, 90-day prune. Measures engagement lift vs novelty
//   decay in aggregate. No third-party trackers anywhere on board pages.
import { serializeSigned } from "hono/utils/cookie";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { eraseMember } from "../src/member-erasure";
import type { ErasureSql } from "../src/member-erasure";
import { events, rsvps } from "../src/db/admin-schema";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";

const baseEnv = (store: SessionStore) =>
  ({
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
  }) as unknown as Env;

async function cookieFor(
  store: SessionStore,
  opts: { member: boolean; userId?: string; username?: string },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: opts.userId ?? "100000000000000201",
    username: opts.username ?? "board-viewer",
    avatar: null,
    member: opts.member,
    moderator: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return (
    await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

describe("leaderboard routes: member gating + grammar (no DB)", () => {
  it("bounces a guest from the overall board into Discord sign-in, never the board", async () => {
    const env = baseEnv(createMemorySessionStore());
    const res = await app.request("/leaderboards", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
    const body = await res.text();
    expect(body).not.toMatch(/data-leaderboard-rank/i);
  });

  it("bounces a guest from a per-game drill-down into sign-in, never the board", async () => {
    const env = baseEnv(createMemorySessionStore());
    const res = await app.request("/leaderboards/chess", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
  });

  it("refuses a signed-in non-member with 403 on every board route", async () => {
    const store = createMemorySessionStore();
    const env = baseEnv(store);
    const cookie = await cookieFor(store, { member: false });
    for (const path of [
      "/leaderboards",
      "/leaderboards/chess",
      "/leaderboards/chess?mode=hosted",
    ]) {
      const res = await app.request(path, { headers: { cookie } }, env);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toMatch(/data-leaderboard-rank/i);
    }
  });

  it("rejects an unknown ?mode= with 400 before touching the database", async () => {
    const store = createMemorySessionStore();
    // No ADMIN_DB and no DATABASE_URL: a 400 here proves validation runs first.
    const env = baseEnv(store);
    const cookie = await cookieFor(store, { member: true });
    const res = await app.request("/leaderboards?mode=bogus-mode", { headers: { cookie } }, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/mode/i);
  });

  it("rejects an unknown ?season= with 400, never a silent overall board", async () => {
    const store = createMemorySessionStore();
    const env = baseEnv(store);
    const cookie = await cookieFor(store, { member: true });
    const res = await app.request(
      "/leaderboards?season=bogus-season",
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/season/i);
  });

  it("rejects an unknown ?scope= with 400, never a silent overall board", async () => {
    const store = createMemorySessionStore();
    const env = baseEnv(store);
    const cookie = await cookieFor(store, { member: true });
    const res = await app.request("/leaderboards?scope=bogus-scope", { headers: { cookie } }, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/scope/i);
  });

  it("defers ?scope=friends with 400/501 and a message, never a silent overall board", async () => {
    const store = createMemorySessionStore();
    const env = baseEnv(store);
    const cookie = await cookieFor(store, { member: true });
    const res = await app.request("/leaderboards?scope=friends", { headers: { cookie } }, env);
    expect([400, 501]).toContain(res.status);
    expect(await res.text()).toMatch(/friend/i);
  });

  it("pins the privacy copy: /privacy names the anonymous board-view analytics", async () => {
    const env = baseEnv(createMemorySessionStore());
    const res = await app.request("/privacy", {}, env);
    expect(res.status).toBe(200);
    // The opt-out toggle + this paragraph land in the same change that adds
    // the toggle: no board ships before both exist.
    expect(await res.text()).toMatch(/leaderboard/i);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("leaderboard boards (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let store: SessionStore;
  let env: Env;
  let memberCookie: string;

  const key = (n: number) => String(n).padStart(26, "0");
  const MEMBER_A = "100000000000000211";
  const MEMBER_B = "100000000000000212";

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    store = createMemorySessionStore();
    env = {
      ...baseEnv(store),
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env;
    memberCookie = await cookieFor(store, { member: true, userId: MEMBER_A, username: "viewer-a" });
  });

  beforeEach(async () => {
    await fixture.reset();
    await db.insert(users).values([
      { id: MEMBER_A, username: "viewer-a", member: true },
      { id: MEMBER_B, username: "viewer-b", member: true },
    ]);
    await db.insert(profiles).values([{ userId: MEMBER_A }, { userId: MEMBER_B }]);
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = (path: string, cookie = memberCookie) =>
    app.request(path, { headers: { cookie } }, env);

  const seedGame = async (n: number, game: string, year: number, rsvpUserId: string) => {
    const [row] = await db
      .insert(events)
      .values({
        eventKey: key(n),
        title: `${game} night ${n}`,
        game,
        status: "published",
        startsAt: new Date(Date.UTC(year, 5, 10, 20)),
        endsAt: new Date(Date.UTC(year, 5, 10, 22)),
      })
      .returning({ id: events.id });
    await db.insert(rsvps).values({ eventId: row!.id, userId: rsvpUserId, status: "going" });
    return row!.id;
  };

  it("serves the overall board to members with links to every per-game sub-board", async () => {
    await seedGame(1, "chess", 2026, MEMBER_A);
    await seedGame(2, "go", 2026, MEMBER_B);
    const res = await get("/leaderboards");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-leaderboard-rank/);
    expect(html).toContain("/leaderboards/chess");
    expect(html).toContain("/leaderboards/go");
    expect(html).toContain("viewer-a");
    expect(html).toContain("viewer-b");
  });

  it("drill-down counts only same-game RSVPs", async () => {
    await seedGame(11, "chess", 2026, MEMBER_A);
    await seedGame(12, "go", 2026, MEMBER_A);
    await seedGame(13, "go", 2026, MEMBER_B);
    const res = await get("/leaderboards/chess");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-leaderboard-rank/);
    expect(html).toContain("viewer-a");
    // viewer-b never RSVP'd to a chess event, so the chess board must not rank them.
    expect(html).not.toContain("viewer-b");
  });

  it("answers an unknown game with 404 that names the game slug", async () => {
    const res = await get("/leaderboards/no-such-game-xyz");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no-such-game-xyz");
  });

  it("serves distinct attended/hosted per-mode sub-boards", async () => {
    await seedGame(21, "chess", 2026, MEMBER_B);
    const attended = await get("/leaderboards?mode=attended");
    expect(attended.status).toBe(200);
    expect(await attended.text()).toContain("viewer-b");
    const hosted = await get("/leaderboards?mode=hosted");
    expect(hosted.status).toBe(200);
    // Nobody created an event in the fixture, so the hosted board ranks nobody.
    expect(await hosted.text()).not.toMatch(/data-leaderboard-rank/);
  });

  it("applies ?season= as a pure date window over event starts (seasonal reset)", async () => {
    await seedGame(31, "chess", 2025, MEMBER_A);
    await seedGame(32, "chess", 2026, MEMBER_B);
    const res = await get("/leaderboards/chess?season=2026");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("viewer-b");
    expect(html).not.toContain("viewer-a");
  });

  it("serves a relative scope window around the viewer", async () => {
    await seedGame(41, "chess", 2026, MEMBER_A);
    const res = await get("/leaderboards?scope=relative");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/relative/i);
    expect(html).toContain("viewer-a");
  });

  it("excludes opted-out members from every board", async () => {
    await seedGame(51, "chess", 2026, MEMBER_A);
    await seedGame(52, "chess", 2026, MEMBER_B);
    await db.execute(
      sql`UPDATE profiles SET leaderboard_opt_out = true WHERE user_id = ${MEMBER_A}`,
    );
    for (const path of ["/leaderboards", "/leaderboards/chess"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("viewer-a");
      expect(html).toContain("viewer-b");
    }
  });

  it("excludes erased members automatically (their RSVPs are gone)", async () => {
    await seedGame(61, "chess", 2026, MEMBER_B);
    let res = await get("/leaderboards/chess");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("viewer-b");
    const safe = testDatabaseUrl(process.env.DATABASE_URL!);
    const client = postgres(safe.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => safe.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    try {
      await eraseMember(client as unknown as ErasureSql, MEMBER_B, { dryRun: false });
    } finally {
      await client.end({ timeout: 1 });
    }
    res = await get("/leaderboards/chess");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("viewer-b");
  });

  it("renders aggregates only: rank + name + count, no timestamps or presence", async () => {
    await seedGame(71, "chess", 2026, MEMBER_A);
    const res = await get("/leaderboards");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-leaderboard-rank/);
    // Seeded events start 2026-06-10: that instant must never leak into a rank row.
    expect(html).not.toContain("2026-06-10");
    expect(html).not.toMatch(/presence|online now|last active/i);
  });

  it("records an anonymous board view: normalized key + scope + season + count", async () => {
    await seedGame(81, "chess", 2026, MEMBER_A);
    await seedGame(82, "chess", 2026, MEMBER_B);
    const res = await get("/leaderboards/Chess?scope=overall&season=2026");
    expect(res.status).toBe(200);
    const rows = await db
      .execute(sql`SELECT normalized_board_key, scope, season, result_count FROM board_view_logs`)
      .catch((err: unknown) => {
        throw new Error(
          `board_view_logs missing (Builder: add the migration): ${(err as Error).constructor.name}`,
        );
      });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0] as {
      normalized_board_key: string;
      scope: string;
      season: string;
      result_count: number;
    };
    // Normalization mirrors search-log: lowercase, whitespace-collapsed.
    expect(row.normalized_board_key).toBe(row.normalized_board_key.toLowerCase());
    expect(row.normalized_board_key).not.toMatch(/\s{2,}/);
    expect(row.normalized_board_key).toContain("chess");
    expect(row.scope).toBe("overall");
    expect(row.season).toBe("2026");
    expect(Number(row.result_count)).toBe(2);
    // Differently-cased requests for the same board share one normalized key.
    await get("/leaderboards/chess?scope=overall&season=2026");
    const keys = await db.execute(sql`SELECT DISTINCT normalized_board_key FROM board_view_logs`);
    expect(keys.length).toBe(1);
  });

  it("board-view rows carry no user, session or IP columns", async () => {
    await seedGame(91, "chess", 2026, MEMBER_A);
    const res = await get("/leaderboards");
    expect(res.status).toBe(200);
    const cols = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'board_view_logs'`,
    );
    const names = (cols as unknown as { column_name: string }[]).map((c) => c.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "normalized_board_key",
        "scope",
        "season",
        "result_count",
        "occurred_at",
      ]),
    );
    for (const forbidden of ["user_id", "session_id", "ip_address", "ip", "discord_id"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("stays fail-open: the board serves 200 while the analytics table is locked", async () => {
    await seedGame(101, "chess", 2026, MEMBER_A);
    const safe = testDatabaseUrl(process.env.DATABASE_URL!);
    const locker = postgres(safe.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => safe.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    try {
      // Pre-implementation the table is missing and this throws; the GET below
      // still proves the point by returning 404 instead of 200.
      await locker.unsafe("BEGIN; LOCK TABLE board_view_logs IN ACCESS EXCLUSIVE MODE");
    } catch {
      // Table missing: fall through to the status assertion, which fails.
    }
    try {
      const t0 = Date.now();
      const res = await get("/leaderboards");
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(res.status).toBe(200);
    } finally {
      await locker.unsafe("ROLLBACK").catch(() => {});
      await locker.end({ timeout: 1 });
    }
  });

  it("ships no third-party trackers on board pages", async () => {
    await seedGame(111, "chess", 2026, MEMBER_A);
    for (const path of ["/leaderboards", "/leaderboards/chess"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toMatch(/<script[^>]+src="https?:\/\//i);
      expect(html).not.toContain("<iframe");
    }
  });
});
