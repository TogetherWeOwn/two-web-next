// route-inventory: GET /leaderboards/members
// Acceptance: savable game names admitted in the activity filter.
//
// Locked contract (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// The defect: `parseActivityParam` admits only `[a-z0-9 _-]{1,64}`
// (src/leaderboards/members.ts), while the event form saves any <=100-char
// text minus control characters (src/admin/validation-event-form.ts). A `D&D`,
// `Catan: Cities` or `Apex / Legends` gathering saves fine, then its own
// board filter 400s with "Unknown activity".
//
// The fix (build card): the `?activity=` grammar admits every game name the
// event form can save (<=100 chars, no control characters) on both twins —
// Hono GET /leaderboards/members and the Kit member-board load — through the
// single shared parser. Trim/lowercase normalization and blank/`all` handling
// are unchanged; `season`/`scope` grammars, ranking, windows, opt-outs and
// erasure are unchanged. Still-refused input (overlong, control-bearing) keeps
// the branded 400 recovery UX with zero database work (Hono) / 400 before any
// read (Kit), never outage copy.
//
// Coverage:
// - Parser: the three named savable names, the `& : / . ' -` punctuation
//   matrix, the 100/101 length edge, blank/`all` handling, control refusal.
// - Hono: each savable name serves a valid 200 board (ranking read bound to
//   the normalized game, reads + logs written); an unmatched savable name
//   renders the valid empty board, never a 400.
// - Kit: the same inputs resolve through loadMembersBoardData with the
//   normalized game passed to the ranking read; unmatched resolves empty.
// - Parity: Hono and Kit agree with the parser on every matrix row, proving
//   the single-parser wiring (fixing one twin but not the other fails).
//
// Hermetic only: memory sessions plus a recording pg-proxy double (the
// bad-filter fixture pattern), and the Kit load seam from
// test/kit-members.test.ts. No live database.
//
// RED proof: every test below fails on base HEAD (the admit assertions 400 or
// reject under the old `[a-z0-9 _-]{1,64}` grammar) and passes with a correct
// fix. Refusal assertions (overlong/control) already hold on base; each test
// pairs them with at least one admit assertion so the test as a whole is red
// until the grammar widens. No production code in this file.

import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { loadMembersBoardData } from "../src/kit-members";
import { parseActivityParam } from "../src/leaderboards/members";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const BROWSER = "text/html,application/xhtml+xml";
const VIEWER_ID = "100000000000000201";
const VIEWER_NAME = "zxq-board-member";
const OTHER_ID = "100000000000000202";
const OTHER_NAME = "zxq-board-other";

const OUTAGE_COPY = [
  "temporarily unavailable",
  "Something broke on our side",
  "logged the failure",
];

type Actor = { userId: string; username: string; member: boolean };
const MEMBER: Actor = { userId: VIEWER_ID, username: VIEWER_NAME, member: true };

/** Savable inputs the old grammar refuses, each with its normalized game. */
const SAVABLE: Array<[string, string]> = [
  ["D&D", "d&d"],
  ["Catan: Cities", "catan: cities"],
  ["Apex / Legends", "apex / legends"],
  ["R&D", "r&d"],
  ["v1.2", "v1.2"],
  ["Mick's Game", "mick's game"],
];

/** Control-bearing inputs the widened grammar must still refuse. C0 + DEL
 * only: every candidate predicate (event-form and profile) refuses these,
 * while tab/LF/CR and wider invisible sets differ between predicates and are
 * deliberately not pinned here. */
const CONTROLS = ["chess\u0000", "ch\u0001ess", "ch\u0007ess", "ch\u001bess", "ch\u007fess"];

type RankingRow = { user_id: string; username: string; count: number };

/**
 * Recording database double: every statement is captured with its bound
 * params, the ranking aggregate answers the configured rows, and everything
 * else answers empty. A refused filter must record zero statements; an
 * admitted filter must bind the normalized game to the ranking read.
 */
function boardHarness(
  rows: RankingRow[] = [
    { user_id: VIEWER_ID, username: VIEWER_NAME, count: 3 },
    { user_id: OTHER_ID, username: OTHER_NAME, count: 1 },
  ],
) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params: [...params] });
    if (sql.includes("from rsvps") && sql.includes("count(*)")) {
      return { rows: rows as unknown as unknown[][] };
    }
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;

  const cookieFor = async (actor: Actor): Promise<string> => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: actor.userId,
      username: actor.username,
      avatar: null,
      member: actor.member,
      moderator: false,
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
  };

  const request = async (path: string) =>
    app.request(
      path,
      {
        headers: {
          accept: BROWSER,
          cookie: await cookieFor(MEMBER),
        },
      },
      env,
    );

  return { statements, request };
}

function expectPrivateNoStore(res: Response, label: string) {
  const tokens = (res.headers.get("cache-control") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .sort();
  expect(tokens, label).toEqual(["no-store", "private"]);
}

async function expectBranded400(res: Response, label: string): Promise<string> {
  expect(res.status, label).toBe(400);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
  expect(res.headers.get("location"), label).toBeNull();
  const body = await res.text();
  expect(body.trimStart().toLowerCase().startsWith("<!doctype html"), label).toBe(true);
  expect(body, label).toContain('class="skip-link" href="#main"');
  expect(body, label).toContain('id="main"');
  expect(body, label).toContain('<span class="account-caption">Signed in</span>');
  expect(body, label).toContain(`<span class="who">${VIEWER_NAME}</span>`);
  expect(body, label).toContain('<form method="post" action="/logout">');
  expect(body, label).toContain('data-testid="error-home"');
  expect(body, label).toMatch(/activity|game/i);
  for (const copy of OUTAGE_COPY) expect(body, label).not.toContain(copy);
  return body;
}

async function expectValidBoard(
  res: Response,
  label: string,
  statements: Array<{ sql: string; params: unknown[] }>,
  expectedGame: string,
): Promise<string> {
  expect(res.status, label).toBe(200);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
  const body = await res.text();
  expect(body, label).toContain("Member leaderboard");
  expect(body, label).toContain(VIEWER_NAME);
  expect(body, label).toContain(OTHER_NAME);
  for (const copy of OUTAGE_COPY) expect(body, label).not.toContain(copy);
  const sql = statements.map((s) => s.sql).join("\n");
  expect(sql, `${label} runs the ranking read`).toContain("from rsvps");
  const ranking = statements.find(
    (s) => s.sql.includes("from rsvps") && s.sql.includes("count(*)"),
  );
  expect(ranking, `${label} binds the normalized game`).toBeDefined();
  expect(ranking!.params, label).toContain(expectedGame);
  expect(sql, `${label} audits the read`).toContain('insert into "member_data_access_logs"');
  expect(sql, `${label} logs the view`).toContain('insert into "board_view_logs"');
  return body;
}

describe("savable parser: admits the event-form charset", () => {
  it("admits D&D, Catan: Cities and Apex / Legends with trim/lowercase normalization", () => {
    expect(parseActivityParam("D&D")).toEqual({ ok: true, game: "d&d" });
    expect(parseActivityParam("Catan: Cities")).toEqual({ ok: true, game: "catan: cities" });
    expect(parseActivityParam("Apex / Legends")).toEqual({ ok: true, game: "apex / legends" });
    expect(parseActivityParam("  D&D  ")).toEqual({ ok: true, game: "d&d" });
    expect(parseActivityParam("  Catan: Cities  ")).toEqual({
      ok: true,
      game: "catan: cities",
    });
    // Blank/`all` handling is unchanged: still every game.
    expect(parseActivityParam(null)).toEqual({ ok: true, game: null });
    expect(parseActivityParam("")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("   ")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("all")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("ALL")).toEqual({ ok: true, game: null });
    expect(parseActivityParam("  all  ")).toEqual({ ok: true, game: null });
  });

  it("covers the savable punctuation matrix & : / . ' -", () => {
    expect(parseActivityParam("R&D")).toEqual({ ok: true, game: "r&d" });
    expect(parseActivityParam("Catan: Seafarers")).toEqual({
      ok: true,
      game: "catan: seafarers",
    });
    expect(parseActivityParam("Apex / Legends")).toEqual({ ok: true, game: "apex / legends" });
    expect(parseActivityParam("v1.2")).toEqual({ ok: true, game: "v1.2" });
    expect(parseActivityParam("Mick's Game")).toEqual({ ok: true, game: "mick's game" });
    // Already admitted under the old grammar: still admitted, unchanged.
    expect(parseActivityParam("X-Wing")).toEqual({ ok: true, game: "x-wing" });
    expect(parseActivityParam("co_op night")).toEqual({ ok: true, game: "co_op night" });
  });

  it("aligns the length cap to the saved-game max (100 admitted, 101 refused)", () => {
    expect(parseActivityParam("a".repeat(64))).toEqual({ ok: true, game: "a".repeat(64) });
    expect(parseActivityParam("a".repeat(65))).toEqual({ ok: true, game: "a".repeat(65) });
    expect(parseActivityParam("a".repeat(100))).toEqual({ ok: true, game: "a".repeat(100) });
    expect(parseActivityParam("a".repeat(101)).ok).toBe(false);
    expect(parseActivityParam("a".repeat(500)).ok).toBe(false);
  });

  it("admits savable names but refuses control-bearing input", () => {
    expect(parseActivityParam("D&D")).toEqual({ ok: true, game: "d&d" });
    expect(parseActivityParam("Catan: Cities")).toEqual({ ok: true, game: "catan: cities" });
    for (const raw of CONTROLS) expect(parseActivityParam(raw).ok, JSON.stringify(raw)).toBe(false);
    expect(parseActivityParam("D&D\u0000").ok).toBe(false);
    expect(parseActivityParam("Catan: Cities\u0007").ok).toBe(false);
  });
});

describe("savable games: Hono member board (hermetic)", () => {
  it.each(SAVABLE)(
    "GET /leaderboards/members?activity=%s serves the valid board",
    async (input, game) => {
      const { statements, request } = boardHarness();
      const res = await request(`/leaderboards/members?activity=${encodeURIComponent(input)}`);
      await expectValidBoard(res, input, statements, game);
    },
  );

  it("renders a valid empty board for an unmatched savable name, never a 400", async () => {
    const { statements, request } = boardHarness([]);
    const res = await request(
      `/leaderboards/members?activity=${encodeURIComponent("Catan: Cities")}`,
    );
    expect(res.status).toBe(200);
    expectPrivateNoStore(res, "unmatched savable");
    const body = await res.text();
    expect(body).toContain("Nobody is ranked for this season and game yet.");
    expect(body).not.toContain(OTHER_NAME);
    for (const copy of OUTAGE_COPY) expect(body).not.toContain(copy);
    const sql = statements.map((s) => s.sql).join("\n");
    expect(sql, "the ranking read ran").toContain("from rsvps");
    const ranking = statements.find(
      (s) => s.sql.includes("from rsvps") && s.sql.includes("count(*)"),
    );
    expect(ranking, "the normalized game is bound").toBeDefined();
    expect(ranking!.params).toContain("catan: cities");
  });

  it("admits 100-char names and refuses 101-char input with the branded 400", async () => {
    const admitted = boardHarness();
    const ok = await admitted.request(
      `/leaderboards/members?activity=${encodeURIComponent("a".repeat(100))}`,
    );
    await expectValidBoard(ok, "100-char", admitted.statements, "a".repeat(100));

    const refused = boardHarness();
    const res = await refused.request(
      `/leaderboards/members?activity=${encodeURIComponent("a".repeat(101))}`,
    );
    const body = await expectBranded400(res, "101-char");
    expect(body, "no rows on a refusal").not.toContain(OTHER_NAME);
    expect(refused.statements, "zero database work on a refusal").toEqual([]);
  });

  it("admits D&D but refuses control-bearing twins with the branded 400 and zero database work", async () => {
    const admitted = boardHarness();
    const ok = await admitted.request(
      `/leaderboards/members?activity=${encodeURIComponent("D&D")}`,
    );
    await expectValidBoard(ok, "D&D", admitted.statements, "d&d");

    for (const raw of CONTROLS) {
      const { statements, request } = boardHarness();
      const label = `control ${JSON.stringify(raw)}`;
      const res = await request(`/leaderboards/members?activity=${encodeURIComponent(raw)}`);
      const body = await expectBranded400(res, label);
      expect(body, label).not.toContain(OTHER_NAME);
      expect(statements, `${label} does zero database work`).toEqual([]);
    }
  });
});

describe("savable games: Kit member-board load (seam)", () => {
  const ranked = [
    { userId: "u-a", username: "Ana", count: 5 },
    { userId: "u-viewer", username: "Vic", count: 3 },
    { userId: "u-b", username: "Bo", count: 1 },
  ];

  const kitArgs = (overrides: Record<string, unknown> = {}) => ({
    env: { APP_URL: "https://example.test" } as never,
    session: { status: "authenticated" as const, userId: "u-viewer", member: true },
    seasonParam: null,
    scopeParam: null,
    activityParam: null,
    setHeaders: vi.fn((_headers: Record<string, string>) => {}),
    dbForFn: async () => ({}) as never,
    loadRankingFn: async () => ranked,
    queueBoardViewFn: () => {},
    ...overrides,
  });

  it.each(SAVABLE)(
    "loadMembersBoardData resolves activity=%s with the normalized game",
    async (input, game) => {
      const loadRankingFn = vi.fn(async () => ranked);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const data = await loadMembersBoardData(
        kitArgs({ activityParam: input, loadRankingFn, queueBoardViewFn, setHeaders }),
      );
      expect(data.activity).toBe(game);
      expect(loadRankingFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        game,
        "overall",
        "u-viewer",
      );
      expect(data.rows.map((row) => row.username)).toEqual(["Ana", "Vic", "Bo"]);
      expect(queueBoardViewFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ boardKey: "members", resultCount: 3 }),
      );
      expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
    },
  );

  it("resolves an unmatched savable name to the valid empty board", async () => {
    const loadRankingFn = vi.fn(async () => []);
    const queueBoardViewFn = vi.fn(() => {});
    const data = await loadMembersBoardData(
      kitArgs({ activityParam: "Catan: Cities", loadRankingFn, queueBoardViewFn }),
    );
    expect(data.activity).toBe("catan: cities");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "catan: cities",
      "overall",
      "u-viewer",
    );
    expect(data.rows).toEqual([]);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ boardKey: "members", resultCount: 0 }),
    );
  });

  it("admits 100-char names and refuses 101-char input with 400 before any read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const data = await loadMembersBoardData(
      kitArgs({ activityParam: "a".repeat(100), loadRankingFn }),
    );
    expect(data.activity).toBe("a".repeat(100));
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "a".repeat(100),
      "overall",
      "u-viewer",
    );

    const dbForFn = vi.fn(async () => ({}) as never);
    const refusedRanking = vi.fn(async () => ranked);
    const queueBoardViewFn = vi.fn(() => {});
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    const failure = await loadMembersBoardData(
      kitArgs({
        activityParam: "a".repeat(101),
        dbForFn,
        loadRankingFn: refusedRanking,
        queueBoardViewFn,
        setHeaders,
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(refusedRanking).not.toHaveBeenCalled();
    expect(queueBoardViewFn).not.toHaveBeenCalled();
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("admits D&D but refuses control-bearing twins with 400 before any read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const data = await loadMembersBoardData(kitArgs({ activityParam: "D&D", loadRankingFn }));
    expect(data.activity).toBe("d&d");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "d&d",
      "overall",
      "u-viewer",
    );

    for (const raw of CONTROLS) {
      const dbForFn = vi.fn(async () => ({}) as never);
      const refusedRanking = vi.fn(async () => ranked);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const failure = await loadMembersBoardData(
        kitArgs({
          activityParam: raw,
          dbForFn,
          loadRankingFn: refusedRanking,
          queueBoardViewFn,
          setHeaders,
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, JSON.stringify(raw)).toMatchObject({ status: 400 });
      expect(dbForFn, JSON.stringify(raw)).not.toHaveBeenCalled();
      expect(refusedRanking, JSON.stringify(raw)).not.toHaveBeenCalled();
      expect(queueBoardViewFn, JSON.stringify(raw)).not.toHaveBeenCalled();
      expect(setHeaders, JSON.stringify(raw)).not.toHaveBeenCalled();
    }
  });
});

describe("savable games: Hono and Kit enforce identically through the shared parser", () => {
  const MATRIX: Array<{ input: string | null; game: string | null; admitted: boolean }> = [
    ...SAVABLE.map(([input, game]) => ({ input, game, admitted: true })),
    { input: "a".repeat(100), game: "a".repeat(100), admitted: true },
    { input: "a".repeat(101), game: null, admitted: false },
    ...CONTROLS.map((input) => ({ input, game: null, admitted: false })),
    { input: null, game: null, admitted: true },
    { input: "", game: null, admitted: true },
    { input: "all", game: null, admitted: true },
  ];

  it("every matrix row agrees across parser, Hono status and Kit outcome", async () => {
    for (const { input, game, admitted } of MATRIX) {
      const label = `activity=${JSON.stringify(input)}`;
      // The shared parser is the oracle.
      expect(parseActivityParam(input), `${label} parser`).toEqual(
        admitted ? { ok: true, game } : expect.objectContaining({ ok: false }),
      );
      // Hono agrees: admitted serves the board, refused answers 400.
      const { request } = boardHarness(admitted ? undefined : []);
      const path =
        input === null
          ? "/leaderboards/members"
          : `/leaderboards/members?activity=${encodeURIComponent(input)}`;
      const res = await request(path);
      expect(res.status, `${label} Hono`).toBe(admitted ? 200 : 400);
      // Kit agrees: admitted resolves with the normalized game, refused
      // rejects 400 before any read.
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => []);
      const outcome = await loadMembersBoardData({
        env: { APP_URL: "https://example.test" } as never,
        session: { status: "authenticated" as const, userId: "u-viewer", member: true },
        seasonParam: null,
        scopeParam: null,
        activityParam: input,
        setHeaders: vi.fn((_headers: Record<string, string>) => {}),
        dbForFn,
        loadRankingFn,
        queueBoardViewFn: () => {},
      }).then(
        (data) => ({ resolved: true, data }) as const,
        (error: unknown) => ({ resolved: false, error }) as const,
      );
      if (admitted) {
        expect(outcome.resolved, `${label} Kit`).toBe(true);
        if (outcome.resolved) expect(outcome.data.activity, `${label} Kit game`).toBe(game);
      } else {
        expect(outcome.resolved, `${label} Kit`).toBe(false);
        if (!outcome.resolved)
          expect(outcome.error, `${label} Kit status`).toMatchObject({ status: 400 });
        expect(dbForFn, `${label} Kit reads nothing`).not.toHaveBeenCalled();
        expect(loadRankingFn, `${label} Kit reads nothing`).not.toHaveBeenCalled();
      }
    }
  });
});
