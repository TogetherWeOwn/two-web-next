// route-inventory: ALL /leaderboards/members
// Unit and gate coverage for the member leaderboard beside its acceptance
// file: the grammar and relative-window functions, the member gate on the
// scoped ALL registration, and the board pages' Primary nav and refusal copy.
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env, Session } from "../src/env";
import {
  type RankedMember,
  boardRows,
  parseActivityParam,
  parseScopeParam,
  RELATIVE_NEIGHBORS,
} from "../src/leaderboards/members";
import { MemberBoardFilterErrorPage, MemberLeaderboardPage } from "../src/leaderboards/pages";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

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

const ranked = (n: number): RankedMember[] =>
  Array.from({ length: n }, (_, i) => ({
    userId: `1000000000000003${String(i).padStart(2, "0")}`,
    username: `member-${i}`,
    count: n - i,
  }));

describe("member leaderboard grammar", () => {
  it("defaults scope to overall and accepts relative", () => {
    expect(parseScopeParam(null)).toEqual({ ok: true, scope: "overall" });
    expect(parseScopeParam("overall")).toEqual({ ok: true, scope: "overall" });
    expect(parseScopeParam("relative")).toEqual({ ok: true, scope: "relative" });
  });

  it("names the friends deferral and rejects everything else", () => {
    const friends = parseScopeParam("friends");
    expect(friends.ok).toBe(false);
    if (!friends.ok) expect(friends.message).toMatch(/deferred/);
    for (const raw of ["", "ALL", "neighbors"]) expect(parseScopeParam(raw).ok).toBe(false);
  });

  it("normalizes one game and treats absent or blank as every game", () => {
    expect(parseActivityParam(null)).toEqual({ ok: true, game: null });
    expect(parseActivityParam("all")).toEqual({ ok: true, game: "all" });
    expect(parseActivityParam("")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("   ")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("  Chess ")).toEqual({ ok: true, game: "chess" });
    expect(parseActivityParam("a".repeat(100))).toEqual({ ok: true, game: "a".repeat(100) });
  });

  it("rejects over-long and control-bearing names", () => {
    for (const raw of ["a".repeat(101), "chess\u0000", "ch\u0007ess"])
      expect(parseActivityParam(raw).ok).toBe(false);
  });
});

describe("member leaderboard rows", () => {
  it("returns the whole ranking, numbered, for the overall scope", () => {
    const rows = boardRows(ranked(30), "overall", "x");
    expect(rows).toHaveLength(30);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[29]!.rank).toBe(30);
  });

  it("centers the relative window on the viewer, at most 11 rows", () => {
    const board = ranked(30);
    const rows = boardRows(board, "relative", board[15]!.userId);
    expect(rows).toHaveLength(2 * RELATIVE_NEIGHBORS + 1);
    expect(rows.map((r) => r.rank)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it("clamps the relative window at both edges instead of shifting it", () => {
    const board = ranked(30);
    expect(boardRows(board, "relative", board[0]!.userId).map((r) => r.rank)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(boardRows(board, "relative", board[29]!.userId).map((r) => r.rank)).toEqual([
      25, 26, 27, 28, 29, 30,
    ]);
  });

  it("gives an unranked viewer no relative rows", () => {
    expect(boardRows(ranked(5), "relative", "100000000000000999")).toEqual([]);
  });
});

describe("member leaderboard gate on the scoped ALL registration", () => {
  it("does not let a guest write verb reach the board", async () => {
    const res = await app.request("/leaderboards/members", { method: "POST" }, env);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("Member leaderboard");
  });

  it("never serves the board to a member on a write verb", async () => {
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000201",
      username: "zxq-gate-member",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const res = await app.request(
      "/leaderboards/members",
      { method: "POST", headers: { cookie } },
      { ...env, SESSION_STORE: store } as unknown as Env,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("Member leaderboard");
  });
});

describe("member board pages", () => {
  const member: Session = {
    id: "100000000000000202",
    username: "zxq-nav-member",
    avatar: null,
    member: true,
    moderator: false,
  };
  const primaryNav = (html: string) => {
    const nav = html.match(/<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/);
    expect(nav).not.toBeNull();
    return nav![1]!;
  };

  it.each([
    [
      "board",
      () =>
        MemberLeaderboardPage({
          appUrl: env.APP_URL,
          session: member,
          query: { season: "all", scope: "overall", activity: null },
          rows: [],
          available: true,
        }),
    ],
    [
      "bad-filter 400",
      () => MemberBoardFilterErrorPage({ session: member, problem: "Unknown season" }),
    ],
  ])("marks Leaderboard, not Events, as the current page (%s)", (_page, page) => {
    const nav = primaryNav(page()!.toString() as string);
    expect(nav).toMatch(/<a href="\/leaderboards\/members" aria-current="page">\s*Leaderboard/);
    expect(nav).toMatch(/<a href="\/events">\s*Events/);
  });

  it.each([
    ["Unknown season", "Unknown season. Show the board"],
    [
      "The friends scope is deferred: there is no friend graph yet.",
      "there is no friend graph yet. Show the board",
    ],
  ])("ends the refused filter %j as its own sentence", (problem, lead) => {
    const html = MemberBoardFilterErrorPage({ session: member, problem })!.toString() as string;
    expect(html).toContain(lead);
    expect(html).not.toContain("..");
  });
});
