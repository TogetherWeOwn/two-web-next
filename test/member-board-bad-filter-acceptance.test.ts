// route-inventory: GET /leaderboards/members
// route-inventory: GET /
// Acceptance: a signed-in member who follows a stale board bookmark with a
// bad filter gets the branded member error page, never bare text, and the
// board is reachable from member navigation.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Bad `season`, `scope` (including the deferred `friends`) and `activity`
//   on GET /leaderboards/members -> 400 as a full HTML document in the
//   member shell: skip link + focusable main, "Signed in" caption with the
//   viewer's name, the Sign out form, and the error-home recovery action.
//   The page still names the problem (the filter it refused) and never
//   carries outage copy. Cache-Control keeps exactly the no-store and
//   private tokens, in either order.
// - A refused filter does no database work at all: no ranking read, no
//   member-data access-log write, no board-view log write. (Zero recorded
//   statements against the recording double below proves all three.)
// - The Kit twin keeps the same answer class: the board load refuses bad
//   filters with a 400 before any read, and status 400 is a first-class
//   Kit error-shell status whose copy is a client-error answer, never the
//   500/503 outage copy it falls back to today.
// - Member navigation links the board: the Primary nav in the shared site
//   header, as rendered for a signed-in member, contains a
//   /leaderboards/members link with a leaderboard label.
// - Unchanged controls: a valid board still renders its ranking rows in
//   the member shell with its reads and logs, guests still bounce to
//   sign-in before grammar, and signed-in non-members still get 403
//   before grammar.
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
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { pageShellFixture } from "./helpers/page-shells";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const BROWSER = "text/html,application/xhtml+xml";
const VIEWER_ID = "100000000000000201";
const VIEWER_NAME = "zxq-board-member";
const OTHER_NAME = "zxq-board-other";

const OUTAGE_COPY = [
  "temporarily unavailable",
  "Something broke on our side",
  "logged the failure",
];

type Actor = { userId: string; username: string; member: boolean };
const MEMBER: Actor = { userId: VIEWER_ID, username: VIEWER_NAME, member: true };
const OUTSIDER: Actor = {
  userId: "100000000000000204",
  username: "zxq-board-outsider",
  member: false,
};

/**
 * Recording database double: every statement is captured, the ranking
 * aggregate answers two ranked rows, and everything else answers empty.
 * A refused filter must record zero statements.
 */
function boardHarness() {
  const statements: string[] = [];
  const db = drizzle(async (sql) => {
    statements.push(sql);
    if (sql.includes("from rsvps") && sql.includes("count(*)")) {
      // The ranking aggregate executes as raw SQL, so its rows arrive
      // keyed by column alias, not positionally.
      return {
        rows: [
          { user_id: VIEWER_ID, username: VIEWER_NAME, count: 3 },
          { user_id: "100000000000000202", username: OTHER_NAME, count: 1 },
        ] as unknown as unknown[][],
      };
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

  const request = async (path: string, actor: Actor | null) =>
    app.request(
      path,
      {
        headers: {
          accept: BROWSER,
          ...(actor ? { cookie: await cookieFor(actor) } : {}),
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

async function expectBranded400(res: Response, label: string, problem: RegExp): Promise<string> {
  expect(res.status, label).toBe(400);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
  expect(res.headers.get("location"), label).toBeNull();
  const body = await res.text();
  // A full branded document in the member shell, never bare text.
  expect(body.trimStart().toLowerCase().startsWith("<!doctype html"), label).toBe(true);
  expect(body, label).toContain('class="skip-link" href="#main"');
  expect(body, label).toContain('id="main"');
  expect(body, label).toContain('<span class="account-caption">Signed in</span>');
  expect(body, label).toContain(`<span class="who">${VIEWER_NAME}</span>`);
  expect(body, label).toContain('<form method="post" action="/logout">');
  expect(body, label).toContain("Sign out");
  expect(body, label).not.toContain("Welcome, guest");
  // Recovery action and the named problem survive the rebrand.
  expect(body, label).toContain('data-testid="error-home"');
  expect(body, label).toMatch(problem);
  // A client error never borrows outage copy.
  for (const copy of OUTAGE_COPY) expect(body, label).not.toContain(copy);
  return body;
}

describe("branded 400 acceptance: bad member-board filters (Hono)", () => {
  it.each([
    ["season", "/leaderboards/members?season=bogus", /season/i],
    ["season", "/leaderboards/members?season=2026-13", /season/i],
    ["scope", "/leaderboards/members?scope=bogus", /scope/i],
    ["scope", "/leaderboards/members?scope=friends", /friend|defer/i],
    ["activity", "/leaderboards/members?activity=chess!", /activity|game/i],
  ] as const)(
    "bad %s (%s) gets the branded member 400 with zero database work",
    async (_filter, path, problem) => {
      const { statements, request } = boardHarness();
      const body = await expectBranded400(await request(path, MEMBER), path, problem);
      // No ranking rows are served on a refusal.
      expect(body, path).not.toContain(OTHER_NAME);
      // No ranking read, no access-log write, no board-view write.
      expect(statements, `${path} statements: ${statements.join(" | ")}`).toEqual([]);
    },
  );

  it("control: the valid board renders ranked rows in the member shell, with its reads and logs", async () => {
    const { statements, request } = boardHarness();
    const res = await request("/leaderboards/members", MEMBER);
    expect(res.status).toBe(200);
    expectPrivateNoStore(res, "valid board");
    const body = await res.text();
    expect(body).toContain('<span class="account-caption">Signed in</span>');
    expect(body).toContain(VIEWER_NAME);
    expect(body).toContain(OTHER_NAME);
    const sql = statements.join("\n");
    expect(sql).toContain("from rsvps"); // the ranking read happened
    expect(sql).toContain('insert into "member_data_access_logs"'); // the read was audited
    expect(sql).toContain('insert into "board_view_logs"'); // the view was logged
  });

  it("controls: the gate still precedes grammar for guests and non-members", async () => {
    const guest = boardHarness();
    const bounced = await guest.request("/leaderboards/members?season=bogus", null);
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toContain("/auth/discord");
    expect(guest.statements).toEqual([]);

    const outsider = boardHarness();
    const refused = await outsider.request("/leaderboards/members?season=bogus", OUTSIDER);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(OTHER_NAME);
    expect(outsider.statements).toEqual([]);
  });
});

describe("branded 400 acceptance: bad member-board filters (Kit answer class)", () => {
  const kitArgs = (overrides: Record<string, unknown> = {}) => ({
    env: { APP_URL: "https://example.test" } as never,
    session: { status: "authenticated" as const, userId: "u-viewer", member: true },
    seasonParam: null,
    scopeParam: null,
    activityParam: null,
    setHeaders: vi.fn((_headers: Record<string, string>) => {}),
    dbForFn: async () => ({}) as never,
    loadRankingFn: async () => [],
    queueBoardViewFn: () => {},
    ...overrides,
  });

  it.each([
    { seasonParam: "bogus" },
    { scopeParam: "bogus" },
    { scopeParam: "friends" },
    { activityParam: "chess!" },
  ])(
    "the Kit load refuses %o with a 400 before any read, carrying no outage copy",
    async (overrides) => {
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => []);
      const queueBoardViewFn = vi.fn(() => {});
      const failure = await loadMembersBoardData(
        kitArgs({ ...overrides, dbForFn, loadRankingFn, queueBoardViewFn }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 400 });
      const rendered = JSON.stringify(failure) ?? "";
      for (const copy of OUTAGE_COPY) expect(rendered).not.toContain(copy);
      expect(dbForFn).not.toHaveBeenCalled();
      expect(loadRankingFn).not.toHaveBeenCalled();
      expect(queueBoardViewFn).not.toHaveBeenCalled();
    },
  );

  it("status 400 is a first-class Kit error-shell answer, never the outage fallback", async () => {
    const { isKitErrorStatus, kitErrorCopy } = await import("../src/kit-errors");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const errorPage = readFileSync(resolve(root, "web/src/routes/+error.svelte"), "utf8");
    const shell = readFileSync(resolve(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    // The 400 the load throws must render as a 400-class shell: either the
    // shared status set admits 400, or the error page/shell handle it
    // explicitly. Falling through to the 500 shell is the defect.
    const handles400 = isKitErrorStatus(400) || /\b400\b/.test(errorPage) || /\b400\b/.test(shell);
    expect(handles400, "Kit error shell must handle status 400 explicitly").toBe(true);
    if (isKitErrorStatus(400)) {
      // Status 400 joins the KitErrorStatus type only with the fix, so read
      // its copy through the numeric seam the guard just admitted.
      const copyFor = kitErrorCopy as (status: number) => {
        code: string;
        title: string;
        lead: string;
      };
      const copy = copyFor(400);
      expect(copy.code).toBe("400");
      for (const outage of OUTAGE_COPY) {
        expect(copy.title).not.toContain(outage);
        expect(copy.lead).not.toContain(outage);
      }
      expect(copy).not.toEqual(kitErrorCopy(500));
      expect(copy).not.toEqual(kitErrorCopy(503));
    }
  });
});

describe("member navigation links the board", () => {
  const primaryNav = (html: string, label: string): string => {
    const match = html.match(/<nav\b[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/);
    expect(match, `${label} renders a Primary nav`).not.toBeNull();
    return match![1]!;
  };

  it.each(["/", "/leaderboards/members"])(
    "the Primary nav on %s links the member board for a signed-in member",
    async (path) => {
      const res = await pageShellFixture().request(path);
      expect(res.status, path).toBe(200);
      const nav = primaryNav(await res.text(), path);
      expect(nav, path).toContain('href="/leaderboards/members"');
      expect(nav, path).toMatch(/leaderboard/i);
    },
  );
});
