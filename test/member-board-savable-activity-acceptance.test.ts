// route-inventory: GET /leaderboards/members
// Acceptance: savable game names are admitted in the member-board activity filter.
//
// Locked contract (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// A game name the event form saves (up to 100 characters, no control or
// invisible characters) must be askable on the board: `?activity=D&D`,
// `?activity=Catan: Cities` and `?activity=Apex / Legends` normalize like any
// other game (trimmed, lowercased) and, when no event carries that game,
// render the valid empty board — 200 with zero rows — instead of the 400 the
// current `[a-z0-9 _-]` grammar answers.
//
// What stays refused (guards against over-widening, folded into the same red
// tests below): names over the board's 64-character limit and names carrying
// control or invisible characters still get the branded 400 recovery page on
// Hono (member shell, recovery actions, zero database work) and a 400 before
// any read on the Kit load. The 64-character ceiling and the `!` rejection
// stay exactly as the sibling bad-filter and seasonal-relative suites pin
// them; this file requires only `&`, `:` and `/` beyond the current alphabet.
//
// Hono and Kit enforce identically through the shared parser: both layers
// import `parseActivityParam` from `src/leaderboards/members.ts`, and the
// agreement test below pins the same admit/refuse answer from the parser,
// the Hono status and the Kit outcome across one input matrix.
//
// Red-first shape: every `it` below asserts an admission the base grammar
// rejects, so every test fails on the base HEAD. The refusal assertions ride
// in the same tests because a pure-refusal test would already pass on the
// base grammar; they turn green-with-the-fix guards against a fix that admits
// too much.
//
// Hermetic only: memory sessions plus a recording pg-proxy double (the
// page-shells fixture pattern), and the Kit load seam from
// test/kit-members.test.ts. No live database.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const OUTAGE_COPY = [
  "temporarily unavailable",
  "Something broke on our side",
  "logged the failure",
];

/** Savable names the base grammar refuses: input as typed, game as normalized. */
const SAVABLE: [input: string, game: string][] = [
  ["D&D", "d&d"],
  ["Catan: Cities", "catan: cities"],
  ["Apex / Legends", "apex / legends"],
];

/** Still refused after the fix: over the 64-character ceiling, or carrying
 * control/invisible characters the event form itself refuses. */
const STILL_REFUSED: [label: string, input: string][] = [
  ["overlong", "a".repeat(65)],
  ["overlong savable-style", `D&D ${"x".repeat(61)}`],
  ["BEL control character", "chess\u0007"],
  ["NUL control character", "d&d\u0000"],
  ["zero-width space", "a\u200bb"],
];

type Actor = { userId: string; username: string; member: boolean };
const MEMBER: Actor = { userId: VIEWER_ID, username: VIEWER_NAME, member: true };

/**
 * Recording database double where the ranking aggregate answers zero rows:
 * every savable name below is unmatched, so the served board is the valid
 * empty board. A refused filter must record zero statements.
 */
function boardHarness() {
  const statements: string[] = [];
  const db = drizzle(async (sql) => {
    statements.push(sql);
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

  const request = async (path: string) => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: MEMBER.userId,
      username: MEMBER.username,
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
    return app.request(path, { headers: { accept: BROWSER, cookie } }, env);
  };

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

const kitArgs = (overrides: Record<string, unknown> = {}) => ({
  env: { APP_URL: "https://example.test" } as never,
  session: {
    status: "authenticated" as const,
    userId: "u-viewer",
    username: "zxq-kit-viewer",
    member: true,
  },
  seasonParam: null,
  scopeParam: null,
  activityParam: null,
  setHeaders: vi.fn((_headers: Record<string, string>) => {}),
  dbForFn: async () => ({}) as never,
  loadRankingFn: async () => [],
  queueBoardViewFn: () => {},
  ...overrides,
});

async function kitOutcome(
  activityParam: string,
): Promise<
  | { admitted: true; activity: string | null; resultCount: number }
  | { admitted: false; status: number }
> {
  const loadRankingFn = vi.fn(async () => []);
  const queueBoardViewFn = vi.fn(() => {});
  try {
    const data = await loadMembersBoardData(
      kitArgs({ activityParam, loadRankingFn, queueBoardViewFn }),
    );
    return { admitted: true, activity: data.activity, resultCount: data.rows.length };
  } catch (error: unknown) {
    return { admitted: false, status: (error as { status?: number }).status ?? -1 };
  }
}

describe("savable activity names (shared parser)", () => {
  it("admits D&D, Catan: Cities and Apex / Legends normalized, and still refuses overlong and control-char input", () => {
    for (const [input, game] of SAVABLE) {
      expect(parseActivityParam(input)).toEqual({ ok: true, game });
      // Normalization matches the existing grammar: trim + lowercase.
      expect(parseActivityParam(`  ${input} `)).toEqual({ ok: true, game });
      expect(parseActivityParam(input.toUpperCase())).toEqual({ ok: true, game });
    }
    for (const [label, input] of STILL_REFUSED) {
      const parsed = parseActivityParam(input);
      expect(parsed.ok, label).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/activity/i);
    }
    // The sibling suites' pins are unchanged by this widening.
    expect(parseActivityParam("chess!").ok).toBe(false);
    expect(parseActivityParam(null)).toEqual({ ok: true, game: null });
    expect(parseActivityParam("all")).toEqual({ ok: true, game: null });
  });
});

describe("savable activity names (Hono board)", () => {
  it("serves the valid empty board for unmatched savable names and keeps the branded 400 for overlong and control-char filters", async () => {
    for (const [input, game] of SAVABLE) {
      const label = `?activity=${input}`;
      const { statements, request } = boardHarness();
      const res = await request(`/leaderboards/members?activity=${encodeURIComponent(input)}`);
      expect(res.status, label).toBe(200);
      expectPrivateNoStore(res, label);
      expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
      const body = await res.text();
      expect(body.trimStart().toLowerCase().startsWith("<!doctype html"), label).toBe(true);
      // The member shell survives: this is a served board, not a refusal.
      expect(body, label).toContain('<span class="account-caption">Signed in</span>');
      expect(body, label).toContain(`<span class="who">${VIEWER_NAME}</span>`);
      // The valid empty board: zero rows, the empty-board status, the
      // normalized game named (HTML-escaped) — never the every-game board.
      expect(body, label).toContain("Nobody is ranked for this season and game yet.");
      const escaped = game.replace(/&/g, "&amp;");
      expect(body, label).toContain(escaped);
      expect(body, label).not.toContain("for season all and every game");
      expect(body, label).not.toContain("<tbody>");
      // A served board did its reads and logged its anonymous view.
      const sql = statements.join("\n");
      expect(sql, `${label} statements: ${sql}`).toContain("from rsvps");
      expect(sql, `${label} statements: ${sql}`).toContain('insert into "board_view_logs"');
      for (const copy of OUTAGE_COPY) expect(body, label).not.toContain(copy);
    }
    for (const [refusal, input] of STILL_REFUSED) {
      const label = `refused ${refusal} (${JSON.stringify(input)})`;
      const { statements, request } = boardHarness();
      const res = await request(`/leaderboards/members?activity=${encodeURIComponent(input)}`);
      expect(res.status, label).toBe(400);
      expectPrivateNoStore(res, label);
      expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
      expect(res.headers.get("location"), label).toBeNull();
      const body = await res.text();
      expect(body.trimStart().toLowerCase().startsWith("<!doctype html"), label).toBe(true);
      expect(body, label).toContain('class="skip-link" href="#main"');
      expect(body, label).toContain('<span class="account-caption">Signed in</span>');
      expect(body, label).toContain(`<span class="who">${VIEWER_NAME}</span>`);
      expect(body, label).toContain("Show the board");
      expect(body, label).toContain('data-testid="error-home"');
      expect(body, label).toMatch(/activity|game/i);
      for (const copy of OUTAGE_COPY) expect(body, label).not.toContain(copy);
      // No ranking read, no access-log write, no board-view write.
      expect(statements, `${label} statements: ${statements.join(" | ")}`).toEqual([]);
    }
  });
});

describe("savable activity names (Kit load)", () => {
  it("resolves unmatched savable names to the normalized game with zero rows and refuses overlong and control-char filters with 400 before any read", async () => {
    for (const [input, game] of SAVABLE) {
      const label = `Kit activityParam=${JSON.stringify(input)}`;
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => []);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const data = await loadMembersBoardData(
        kitArgs({ activityParam: input, dbForFn, loadRankingFn, queueBoardViewFn, setHeaders }),
      );
      expect(data.activity, label).toBe(game);
      expect(data.rows, label).toEqual([]);
      expect(loadRankingFn, label).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        game,
        "overall",
        "u-viewer",
      );
      expect(queueBoardViewFn, label).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ boardKey: "members", resultCount: 0 }),
      );
      expect(setHeaders, label).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
    }
    for (const [refusal, input] of STILL_REFUSED) {
      const label = `Kit refused ${refusal} (${JSON.stringify(input)})`;
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => []);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const failure = await loadMembersBoardData(
        kitArgs({ activityParam: input, dbForFn, loadRankingFn, queueBoardViewFn, setHeaders }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, label).toMatchObject({ status: 400 });
      const rendered = JSON.stringify(failure) ?? "";
      for (const copy of OUTAGE_COPY) expect(rendered, label).not.toContain(copy);
      expect(dbForFn, label).not.toHaveBeenCalled();
      expect(loadRankingFn, label).not.toHaveBeenCalled();
      expect(queueBoardViewFn, label).not.toHaveBeenCalled();
      expect(setHeaders, label).not.toHaveBeenCalled();
    }
  });
});

describe("savable activity names (Hono and Kit agree through the shared parser)", () => {
  it("answers the same admit/refuse from the parser, the Hono status and the Kit outcome across the matrix", async () => {
    // Both layers import the one shared grammar: no forked copy may drift.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const honoRoute = readFileSync(resolve(root, "src/leaderboards/routes.tsx"), "utf8");
    const kitCore = readFileSync(resolve(root, "src/kit-members.ts"), "utf8");
    expect(honoRoute).toContain("parseActivityParam");
    expect(honoRoute).toMatch(/from "\.\/members"/);
    expect(kitCore).toContain("parseActivityParam");
    expect(kitCore).toMatch(/from "\.\/leaderboards\/members"/);
    // Agreement across the matrix: admitted on one layer means admitted on all.
    const matrix: [input: string, admitted: boolean][] = [
      ...SAVABLE.map(([input]): [string, boolean] => [input, true]),
      ...STILL_REFUSED.map(([, input]): [string, boolean] => [input, false]),
    ];
    for (const [input, admitted] of matrix) {
      const label = `agreement for ${JSON.stringify(input)}`;
      expect(parseActivityParam(input).ok, `parser ${label}`).toBe(admitted);
      const { request } = boardHarness();
      const res = await request(`/leaderboards/members?activity=${encodeURIComponent(input)}`);
      expect(res.status, `Hono ${label}`).toBe(admitted ? 200 : 400);
      const outcome = await kitOutcome(input);
      expect(outcome.admitted, `Kit ${label}`).toBe(admitted);
      if (admitted && outcome.admitted) {
        const game = SAVABLE.find(([name]) => name === input)![1];
        expect(outcome.activity, `Kit game ${label}`).toBe(game);
        expect(outcome.resultCount, `Kit rows ${label}`).toBe(0);
      } else if (!admitted && !outcome.admitted) {
        expect(outcome.status, `Kit status ${label}`).toBe(400);
      }
    }
  });
});
