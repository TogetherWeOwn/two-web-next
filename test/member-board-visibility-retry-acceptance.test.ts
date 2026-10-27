// route-inventory: GET /leaderboards/members
// Acceptance (test files only) for member-board visibility discovery and
// scope-preserving retry.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass. This suite owns
// ONLY these cases; production behavior lives with the Builder.
//
// Outcome (U1/M314): members reading their board can reach their own existing
// opt-out control and retry the current rankings after an outage. No new
// setting, endpoint, preference read or profile redesign.
//
// Stable case IDs (see the builder handoff on the card for the full table):
// - HONO-MANAGE-*: Hono page-unit manage action (populated/empty/unranked/game)
// - HONO-RETRY-*: Hono route + page-unit retry (unavailable only, keeps query)
// - HONO-ROUTE-DB-*: Hono route with agent-testdb (manage/retry/gating/no-store)
// - KIT-MANAGE-* / KIT-RETRY-*: Kit SSR render twins via the real +page.svelte
// - SRC-*: source pins (existing URL helpers, no new preference projection)
// - CTRL-*: already-passing controls (gate, grammar, policy, opt-out, fragment)
//
// How this fails before the Builder lands: every MANAGE/RETRY case fails on
// the missing anchor (null link, absent copy), while every CTRL case passes.
// A green CTRL group with red MANAGE/RETRY groups is the expected pre-build
// signal; the Builder turns the red groups green without touching this file.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env, Session } from "../src/env";
import { boardPath, MemberLeaderboardPage } from "../src/leaderboards/pages";
import type { BoardRow } from "../src/leaderboards/members";
import { POLICY_FILE } from "../src/privacy";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

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

// The contract's fixed vocabulary. The manage target is the viewer's own
// profile edit section — never a listed member id, never a caller-supplied
// return URL. Both profile twins (Hono src/profiles/pages.tsx, Kit
// web/src/lib/ProfileView.svelte) already carry id="edit-heading".
const MANAGE_TEXT = "Manage leaderboard visibility";
const MANAGE_HREF = "/profile#edit-heading";
const RETRY_TEXT = "Retry rankings";

// All-digit 26-char import-shaped keys, so no secret scanner trips.
const gameKey = (n: number) => String(n).padStart(26, "0");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = (path: string) => resolve(root, path);
const readSrc = (path: string) => readFileSync(shell(path), "utf8");

type Actor = { userId: string; username: string; member: boolean; moderator: boolean };
const MEMBER: Actor = {
  userId: "100000000000000201",
  username: "zxq-vis-member",
  member: true,
  moderator: false,
};
const OUTSIDER: Actor = {
  userId: "100000000000000202",
  username: "zxq-vis-outsider",
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

const memberEnvNoDb = async (actor: Actor = MEMBER) => {
  const store = createMemorySessionStore();
  const cookie = await cookieFor(store, actor);
  return { live: { ...env, SESSION_STORE: store } as unknown as Env, cookie };
};

/** First native anchor whose exact text is the manage action; null when absent. */
function manageHref(html: string): string | null {
  const m = html.match(new RegExp(`<a\\b[^>]*href="([^"]*)"[^>]*>\\s*${MANAGE_TEXT}\\s*</a>`));
  return m ? m[1]! : null;
}

/** First native anchor whose exact text is the retry action; null when absent. */
function retryHref(html: string): string | null {
  const m = html.match(new RegExp(`<a\\b[^>]*href="([^"]*)"[^>]*>\\s*${RETRY_TEXT}\\s*</a>`));
  return m ? m[1]! : null;
}

const HREF_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
};

/** Attribute-unescaped href for comparison against boardPath output. One
 * pass, so an escaped entity (`&amp;lt;`) decodes once, never twice. */
const unescapeHref = (href: string): string =>
  href.replaceAll(/&(?:amp|lt|gt|quot|#34|#39);/g, (entity) => HREF_ENTITIES[entity]!);

/** The explanation band: from the heading to the scope nav. The manage action
 * must live alongside the privacy explanation here, above the navigation —
 * not buried under the table or behind script. */
function headSection(html: string): string {
  const h1 = html.indexOf("</h1>");
  const nav = html.indexOf('<nav aria-label="Board scope">');
  if (h1 < 0 || nav < 0 || nav <= h1) return "";
  return html.slice(h1, nav);
}

function statusParagraphs(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
}

/** Script tags on the board beyond the pre-existing footer island (auth tab
 * sync, owned elsewhere): the board must carry no script of its own. Counts
 * every `<script` opener against the allowed island tags instead of stripping,
 * so a script hidden inside or next to an island tag still counts. */
const foreignScriptCount = (html: string): number =>
  (html.match(/<script/gi) ?? []).length -
  (html.match(/<script\b[^>]*auth-status\.js[^>]*>\s*<\/script>/g) ?? []).length;

const viewerSession: Session = {
  id: MEMBER.userId,
  username: MEMBER.username,
  avatar: null,
  member: true,
  moderator: false,
};

const honoPage = (opts: {
  season?: string;
  scope?: "overall" | "relative";
  activity?: string | null;
  rows?: BoardRow[];
  available?: boolean;
}): string =>
  MemberLeaderboardPage({
    appUrl: env.APP_URL,
    session: viewerSession,
    query: {
      season: opts.season ?? "all",
      scope: opts.scope ?? "overall",
      activity: opts.activity ?? null,
    },
    rows: opts.rows ?? [],
    available: opts.available ?? true,
  })!.toString() as string;

const sampleRows: BoardRow[] = [
  { userId: "100000000000000211", username: "zxq-vis-a", count: 5, rank: 1 },
  { userId: MEMBER.userId, username: MEMBER.username, count: 3, rank: 2 },
  { userId: "100000000000000213", username: "zxq-vis-c", count: 1, rank: 3 },
];

// ---------------------------------------------------------------------------
// Hono page-unit: manage action (HONO-MANAGE-*; no DB, always runs)
// ---------------------------------------------------------------------------

describe("Hono member board manage action (page unit)", () => {
  it("HONO-MANAGE-populated: links the populated board to the own-profile edit section", () => {
    const html = honoPage({ rows: sampleRows });
    // Discriminating: no manage anchor exists before the Builder lands.
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("Manage leaderboard visibility");
    // The existing explanation and policy link stay beside the action.
    expect(html).toContain('<a href="/privacy">privacy policy</a>');
    expect(headSection(html)).toContain("/privacy");
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
  });

  it("HONO-MANAGE-empty: keeps the action and navigation on the empty board", () => {
    const html = honoPage({ rows: [] });
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("Manage leaderboard visibility");
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
    expect(html).toContain("Nobody is ranked for this season and game yet.");
    expect(html).toContain('<nav aria-label="Board scope">');
    expect(html).toContain('aria-label="Board period"');
  });

  it("HONO-MANAGE-unranked: keeps the action and navigation for an unranked viewer", () => {
    const html = honoPage({ scope: "relative", rows: [] });
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
    expect(html).toContain("You are not ranked for this season and game yet.");
    expect(html).toContain('<nav aria-label="Board scope">');
    expect(html).toContain('aria-label="Board period"');
  });

  it("HONO-MANAGE-game: keeps the action on a game-scoped board", () => {
    const html = honoPage({ activity: "chess", rows: sampleRows });
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("/privacy");
  });

  it("HONO-MANAGE-target: never points at a listed member id", () => {
    const html = honoPage({ rows: sampleRows });
    const href = manageHref(html);
    expect(href).toBe(MANAGE_HREF);
    for (const row of sampleRows) {
      expect(href).not.toContain(row.userId);
      expect(href).not.toContain(row.username);
    }
    expect(href).not.toMatch(/^\/members\//);
  });

  it("HONO-MANAGE-scope: explains Going-response ranking, not observed attendance", () => {
    const html = honoPage({ rows: sampleRows });
    const head = headSection(html);
    // Discriminating: today the band only says "answered going to".
    expect(head).toMatch(/going[\s-]*responses?/i);
    expect(head).toMatch(/not\s+observed attendance/i);
  });

  it("HONO-MANAGE-share: share metadata describes Going-response ranking", () => {
    const html = honoPage({ rows: sampleRows });
    expect(html).toMatch(
      /<meta\b[^>]*name="description"[^>]*content="Members ranked by their Going responses to events\."/,
    );
    expect(html).toMatch(
      /<meta\b[^>]*property="og:description"[^>]*content="Members ranked by their Going responses to events\."/,
    );
  });

  it("HONO-MANAGE-no-inference: absent rows never claim opt-out, state or inactivity", () => {
    for (const html of [
      honoPage({ rows: [] }),
      honoPage({ scope: "relative", rows: [] }),
      honoPage({ rows: sampleRows }),
    ]) {
      for (const status of statusParagraphs(html)) {
        expect(status).not.toMatch(
          /opted?\s?-?\s?out|inactive|hidden from|didn.?t\s+(rsvp|respond)/i,
        );
      }
      expect(html).not.toMatch(/you\s+are\s+(currently\s+)?(opted|hidden)/i);
      expect(html).not.toMatch(/currently\s+(shown|visible|hidden|opted)/i);
    }
  });

  it("HONO-MANAGE-native: the action is a plain anchor, usable with no script", () => {
    const html = honoPage({ rows: sampleRows });
    expect(html).toMatch(
      /<a\b[^>]*href="\/profile#edit-heading"[^>]*>\s*Manage leaderboard visibility\s*<\/a>/,
    );
    expect(foreignScriptCount(html)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hono page-unit + route: retry (HONO-RETRY-*; unavailable state only)
// ---------------------------------------------------------------------------

describe("Hono member board retry (unavailable state only)", () => {
  it("HONO-RETRY-unit: links the unavailable page back to the same normalized board", () => {
    const html = honoPage({
      season: "2026-09",
      scope: "relative",
      activity: "chess",
      rows: [],
      available: false,
    });
    expect(html).toContain("Rankings are temporarily unavailable.");
    // Discriminating: no retry anchor exists before the Builder lands.
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "2026-09", scope: "relative", activity: "chess" }),
    );
  });

  it("HONO-RETRY-unit-defaults: the default board retries to the bare path", () => {
    const html = honoPage({ rows: [], available: false });
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe("/leaderboards/members");
  });

  it.each(["populated", "empty", "unranked"] as const)(
    "HONO-RETRY-absent-%s: no retry anchor outside the unavailable state",
    (state) => {
      const html =
        state === "populated"
          ? honoPage({ rows: sampleRows })
          : state === "empty"
            ? honoPage({ rows: [] })
            : honoPage({ scope: "relative", rows: [] });
      expect(html).not.toContain("Retry rankings");
      expect(retryHref(html)).toBeNull();
    },
  );

  it("HONO-RETRY-route: the no-database board retries with scope, season and game kept", async () => {
    const { live, cookie } = await memberEnvNoDb();
    const res = await app.request(
      "/leaderboards/members?season=2026-09&scope=relative&activity=Chess",
      { headers: { cookie } },
      live,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Rankings are temporarily unavailable.");
    const href = retryHref(html);
    expect(href).not.toBeNull();
    // Normalized through the existing grammar: the game lowercases, every
    // dimension survives.
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "2026-09", scope: "relative", activity: "chess" }),
    );
  });

  it("HONO-RETRY-escape: the retry href escapes multi-param queries", async () => {
    const { live, cookie } = await memberEnvNoDb();
    const res = await app.request(
      "/leaderboards/members?season=2026-09&activity=rock+%26+roll",
      { headers: { cookie } },
      live,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "2026-09", scope: "overall", activity: "rock & roll" }),
    );
    // The raw markup carries the escaped form, never a bare & separator.
    expect(href!).toContain("&amp;");
  });

  it("HONO-RETRY-hostile: a markup-shaped game stays escaped in the retry href", async () => {
    const { live, cookie } = await memberEnvNoDb();
    const res = await app.request(
      "/leaderboards/members?activity=%3Cimg%3E",
      {
        headers: { cookie },
      },
      live,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "all", scope: "overall", activity: "<img>" }),
    );
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
  });

  it("HONO-RETRY-manual: the outage never retries itself", async () => {
    const { live, cookie } = await memberEnvNoDb();
    const res = await app.request(
      "/leaderboards/members?season=2026-09",
      {
        headers: { cookie },
      },
      live,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Rankings are temporarily unavailable.");
    expect(foreignScriptCount(html)).toBe(0);
    expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(html).not.toMatch(/setTimeout|setInterval|location\.reload|\.fetch\(/);
    // The recovery is one plain anchor: a GET the member chooses.
    expect(html).toMatch(/<a\b[^>]*href="[^"]*"[^>]*>\s*Retry rankings\s*<\/a>/);
  });
});

// ---------------------------------------------------------------------------
// Hono route with agent-testdb (HONO-ROUTE-DB-*; skips without DATABASE_URL)
// ---------------------------------------------------------------------------

describe("Hono member board route (agent-testdb)", () => {
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

  it("HONO-ROUTE-DB-populated: the served board links its own visibility control", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [3, 2, 1], keyBase: 410 });
    const res = await board("?season=2026-09");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("zxq-100000000000000-m00");
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("/privacy");
    expect(html).not.toContain("Retry rankings");
  });

  it("HONO-ROUTE-DB-empty: the empty board keeps action, policy link and navigation", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 420 });
    const res = await board("?season=2026-09&activity=checkers");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nobody is ranked for this season and game yet.");
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(html).toContain('<nav aria-label="Board scope">');
    expect(html).not.toContain("Retry rankings");
  });

  it("HONO-ROUTE-DB-unranked: the unranked relative board keeps action and copy", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 430 });
    // MEMBER sent no going RSVP, so the relative scope has no window for them.
    const res = await board("?season=2026-09&scope=relative");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You are not ranked for this season and game yet.");
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(html).not.toContain("Retry rankings");
  });

  it("HONO-ROUTE-DB-game: the game-scoped board keeps the own-profile action", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 440, game: "Chess" });
    await seedBoard({ prefix: "100000000000001", goings: [1], keyBase: 450, game: "Go" });
    const res = await board("?season=2026-09&activity=chess");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("zxq-100000000000000-m00");
    expect(html).not.toContain("zxq-100000000000001-m00");
    expect(manageHref(html)).toBe(MANAGE_HREF);
  });

  it("HONO-ROUTE-DB-fixed-target: hostile return URLs never reach the manage href", async () => {
    await fixture.reset();
    const ids = await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 460 });
    const res = await board(
      "?season=2026-09&return=https%3A%2F%2Fevil.test%2Fsteal&next=%2Fevil&returnTo=%2Fevil",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain("/evil");
    for (const id of ids) expect(manageHref(html)).not.toContain(id);
  });

  it("HONO-ROUTE-DB-scope: the served board explains Going-response ranking", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [3, 2, 1], keyBase: 470 });
    const res = await board("?season=2026-09");
    expect(res.status).toBe(200);
    const html = await res.text();
    const head = headSection(html);
    expect(head).toContain("Manage leaderboard visibility");
    expect(head).toMatch(/going[\s-]*responses?/i);
    expect(head).toMatch(/not\s+observed attendance/i);
  });

  it("HONO-ROUTE-DB-hostile-label: a markup-shaped game stays escaped on the served board", async () => {
    await fixture.reset();
    await seedBoard({ prefix: "100000000000000", goings: [2, 1], keyBase: 480 });
    const res = await board("?season=2026-09&activity=%3Cimg%3E");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Valid filter, unmatched game: an available empty board, not an outage.
    expect(html).toContain("Nobody is ranked for this season and game yet.");
    expect(html).not.toContain("Retry rankings");
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
  });
});

// ---------------------------------------------------------------------------
// Kit SSR render twins (KIT-*; the real +page.svelte, hermetic fake load data)
// ---------------------------------------------------------------------------

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type BoardData = Record<string, unknown>;
let renderPage: (data: BoardData) => string;
let kitScratch = "";

function baseData(overrides: BoardData = {}): BoardData {
  return {
    season: "all",
    scope: "overall",
    activity: null,
    rows: [{ username: "Vic", count: 3, rank: 1, isViewer: true }],
    viewerUsername: "Vic",
    available: true,
    appUrl: "https://example.test",
    ...overrides,
  };
}

beforeAll(async () => {
  kitScratch = mkdtempSync(join(tmpdir(), "kit-board-visibility-"));
  const entry = join(kitScratch, "kit-board-visibility-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(kitScratch, "kit-board-visibility.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-board-visibility-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  ({ renderPage } = (await import(pathToFileURL(outfile).href)) as {
    renderPage: (data: BoardData) => string;
  });
});

afterAll(() => {
  rmSync(kitScratch, { recursive: true, force: true });
});

describe("Kit member board visibility action (SSR render)", () => {
  it("KIT-MANAGE-populated: links the populated board to the own-profile edit section", () => {
    const html = renderPage(baseData());
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("Manage leaderboard visibility");
    expect(html).toContain('<a href="/privacy">privacy policy</a>');
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
  });

  it("KIT-MANAGE-empty: keeps the action and navigation on the empty board", () => {
    const html = renderPage(baseData({ rows: [] }));
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
    expect(html).toContain("Nobody is ranked for this season and game yet.");
    expect(html).toContain('<nav aria-label="Board scope">');
    expect(html).toContain('aria-label="Board period"');
  });

  it("KIT-MANAGE-unranked: keeps the action for an unranked viewer", () => {
    const html = renderPage(baseData({ scope: "relative", rows: [] }));
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toMatch(
      /Hiding yourself removes you from every board and every count/,
    );
    expect(html).toContain("You are not ranked for this season and game yet.");
    expect(html).toContain('<nav aria-label="Board scope">');
  });

  it("KIT-MANAGE-game: keeps the action on a game-scoped board", () => {
    const html = renderPage(baseData({ activity: "chess" }));
    expect(manageHref(html)).toBe(MANAGE_HREF);
    expect(headSection(html)).toContain("/privacy");
  });

  it("KIT-MANAGE-target: never points at a listed member or a caller URL", () => {
    const html = renderPage(
      baseData({
        rows: [
          { username: "Vic", count: 3, rank: 1, isViewer: true },
          { username: "Ash", count: 2, rank: 2, isViewer: false },
        ],
      }),
    );
    const href = manageHref(html);
    expect(href).toBe(MANAGE_HREF);
    expect(href).not.toContain("Vic");
    expect(href).not.toContain("Ash");
    expect(href).not.toMatch(/^\/members\//);
  });

  it("KIT-MANAGE-scope: explains Going-response ranking, not observed attendance", () => {
    const head = headSection(renderPage(baseData()));
    expect(head).toMatch(/going[\s-]*responses?/i);
    expect(head).toMatch(/not\s+observed attendance/i);
  });

  it("KIT-MANAGE-share: share metadata describes Going-response ranking", () => {
    const html = renderPage(baseData());
    expect(html).toMatch(
      /<meta\b[^>]*name="description"[^>]*content="Members ranked by their Going responses to events\."/,
    );
    expect(html).toMatch(
      /<meta\b[^>]*property="og:description"[^>]*content="Members ranked by their Going responses to events\."/,
    );
  });

  it("KIT-MANAGE-no-inference: absent rows never claim opt-out, state or inactivity", () => {
    for (const html of [
      renderPage(baseData({ rows: [] })),
      renderPage(baseData({ scope: "relative", rows: [] })),
      renderPage(baseData()),
    ]) {
      for (const status of statusParagraphs(html)) {
        expect(status).not.toMatch(
          /opted?\s?-?\s?out|inactive|hidden from|didn.?t\s+(rsvp|respond)/i,
        );
      }
      expect(html).not.toMatch(/you\s+are\s+(currently\s+)?(opted|hidden)/i);
      expect(html).not.toMatch(/currently\s+(shown|visible|hidden|opted)/i);
    }
  });

  it("KIT-MANAGE-native: the action is a plain anchor, usable with no script", () => {
    const html = renderPage(baseData());
    expect(html).toMatch(
      /<a\b[^>]*href="\/profile#edit-heading"[^>]*>\s*Manage leaderboard visibility\s*<\/a>/,
    );
  });
});

describe("Kit member board retry (SSR render)", () => {
  it("KIT-RETRY-unavailable: links the outage back to the same normalized board", () => {
    const html = renderPage(
      baseData({
        season: "2026-09",
        scope: "relative",
        activity: "chess",
        rows: [],
        available: false,
      }),
    );
    expect(html).toContain("Rankings are temporarily unavailable.");
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "2026-09", scope: "relative", activity: "chess" }),
    );
  });

  it("KIT-RETRY-escape: the retry href escapes multi-param queries", () => {
    const html = renderPage(
      baseData({ season: "2026-09", activity: "rock & roll", rows: [], available: false }),
    );
    const href = retryHref(html);
    expect(href).not.toBeNull();
    expect(unescapeHref(href!)).toBe(
      boardPath({ season: "2026-09", scope: "overall", activity: "rock & roll" }),
    );
    expect(href!).toContain("&amp;");
  });

  it.each(["populated", "empty", "unranked"] as const)(
    "KIT-RETRY-absent-%s: no retry anchor outside the unavailable state",
    (state) => {
      const html =
        state === "populated"
          ? renderPage(baseData())
          : state === "empty"
            ? renderPage(baseData({ rows: [] }))
            : renderPage(baseData({ scope: "relative", rows: [] }));
      expect(html).not.toContain("Retry rankings");
      expect(retryHref(html)).toBeNull();
    },
  );

  it("KIT-RETRY-manual: the outage never retries itself", () => {
    const html = renderPage(baseData({ rows: [], available: false }));
    expect(html).toContain("Rankings are temporarily unavailable.");
    expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(html).not.toMatch(/setTimeout|setInterval|location\.reload|\.fetch\(/);
    expect(html).toMatch(/<a\b[^>]*href="[^"]*"[^>]*>\s*Retry rankings\s*<\/a>/);
    const source = readSrc("web/src/routes/leaderboards/members/+page.svelte");
    expect(source).not.toMatch(/onMount|setTimeout|setInterval|goto\(|fetch\(/);
  });
});

// ---------------------------------------------------------------------------
// Source pins (SRC-*): existing URL helpers in, new projections out
// ---------------------------------------------------------------------------

describe("Member board visibility source pins", () => {
  it("SRC-hono-retry-helper: the Hono retry keeps the query through boardPath", () => {
    const source = readSrc("src/leaderboards/pages.tsx");
    // Discriminating: no retry anchor exists before the Builder lands.
    expect(source).toContain("Retry rankings");
    const at = source.indexOf("Retry rankings");
    expect(source.slice(Math.max(0, at - 600), at)).toContain("boardPath(");
  });

  it("SRC-kit-retry-helper: the Kit retry keeps the query through destination", () => {
    const source = readSrc("web/src/routes/leaderboards/members/+page.svelte");
    expect(source).toContain("Retry rankings");
    const at = source.indexOf("Retry rankings");
    expect(source.slice(Math.max(0, at - 600), at)).toContain("destination(");
  });

  it("SRC-manage-present: both renderers name the fixed own-profile action", () => {
    expect(readSrc("src/leaderboards/pages.tsx")).toContain("Manage leaderboard visibility");
    expect(readSrc("src/leaderboards/pages.tsx")).toContain("/profile#edit-heading");
    expect(readSrc("web/src/routes/leaderboards/members/+page.svelte")).toContain(
      "Manage leaderboard visibility",
    );
    expect(readSrc("web/src/routes/leaderboards/members/+page.svelte")).toContain(
      "/profile#edit-heading",
    );
  });

  it("SRC-no-preference-read: no board renderer fetches a preference projection", () => {
    // Passes today; fails if the Builder reads opt-out state to label the
    // action. The ranking filter in members.ts is the only admitted touch.
    for (const file of [
      "src/leaderboards/pages.tsx",
      "src/leaderboards/routes.tsx",
      "src/kit-members.ts",
      "web/src/routes/leaderboards/members/+page.svelte",
      "web/src/routes/leaderboards/members/+page.server.ts",
    ]) {
      const source = readSrc(file);
      expect(source, file).not.toContain("leaderboard_opt_out");
      expect(source, file).not.toContain("leaderboardOptOut");
      expect(source, file).not.toContain("loadProfile");
    }
  });

  it("SRC-ranking-untouched: the opt-out filter keeps its three ranking reads", () => {
    // Three ranking reads (overall, relative rank lookup, relative window);
    // each names the column twice (null-or-false), so six touches total.
    const hits = readSrc("src/leaderboards/members.ts").match(/leaderboard_opt_out/g) ?? [];
    expect(hits).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Already-passing controls (CTRL-*): the Builder must keep every one green
// ---------------------------------------------------------------------------

describe("Member board preserved controls", () => {
  it("CTRL-guest: a guest still bounces to sign-in, never the board", async () => {
    for (const path of ["/leaderboards/members", "/leaderboards/members?scope=relative"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/auth/discord");
    }
  });

  it("CTRL-nonmember: a signed-in non-member still gets 403, never the board", async () => {
    const { live, cookie } = await memberEnvNoDb(OUTSIDER);
    const res = await app.request("/leaderboards/members", { headers: { cookie } }, live);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Member leaderboard");
  });

  it("CTRL-grammar: a bad season still 400s before any read", async () => {
    const { live, cookie } = await memberEnvNoDb();
    const res = await app.request(
      "/leaderboards/members?season=bogus",
      {
        headers: { cookie },
      },
      live,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown season");
  });

  it("CTRL-nostore: served and unavailable boards stay no-store", async () => {
    const { live, cookie } = await memberEnvNoDb();
    for (const path of ["/leaderboards/members", "/leaderboards/members?season=2026-09"]) {
      const res = await app.request(path, { headers: { cookie } }, live);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
  });

  it("CTRL-policy: the privacy policy still versions the opt-out paragraph", () => {
    const policy = readFileSync(shell(POLICY_FILE), "utf8");
    expect(policy).toMatch(/leaderboard/i);
    expect(policy).toMatch(/opt.?out/i);
  });

  it("CTRL-fragment: the own-profile edit fragment still exists on both twins", () => {
    const hono = readSrc("src/profiles/pages.tsx");
    expect(hono).toContain('id="edit-heading"');
    expect(hono).toContain("tabindex={-1}");
    const kit = readSrc("web/src/lib/ProfileView.svelte");
    expect(kit).toContain('id="edit-heading"');
    expect(kit).toContain('tabindex="-1"');
  });

  it("CTRL-optout-owned: the profile opt-out control stays put, not redesigned", () => {
    expect(readSrc("src/profiles/pages.tsx")).toContain("Hide me from the member leaderboard");
    expect(readSrc("web/src/lib/ProfileView.svelte")).toContain(
      "Hide me from the member leaderboard",
    );
  });

  it("CTRL-kit-shell: the Kit board stays server-rendered with the locked grammar", () => {
    const server = readSrc("web/src/routes/leaderboards/members/+page.server.ts");
    expect(server).toContain("csr = false");
    for (const token of ["overall", "relative", "season", "activity"]) {
      expect(server).toContain(token);
    }
  });
});
