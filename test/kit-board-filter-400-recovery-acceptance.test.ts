// route-inventory: GET /leaderboards/members
// Acceptance: a signed-in Kit member who follows a stale board bookmark with
// a bad filter gets the board-specific 400 in context — never the generic
// error shell, never outage copy — with the same recovery Hono serves.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Bad `season`, `scope` (including the deferred `friends`) and `activity`
//   on the Kit board load answer status 400 with a board-specific page that
//   names the refused filter in the parse message's own words ("Unknown
//   season", "Unknown scope", the friends deferral, "Unknown activity"), with
//   `Show the board` (/leaderboards/members, data-testid="error-board") and
//   homepage (data-testid="error-home") recovery. Heading mirrors Hono's
//   "Check the board filters"; theme, active nav and noindex match the board.
// - A refused filter does no ranking work at all: no dbFor, no ranking read,
//   no board-view queue; it sets private, no-store exactly once.
// - Gating precedes grammar: guests bounce 302 and signed-in non-members get
//   403 before any filter is parsed, on helper and binding alike.
// - Grammar, valid rendering and relative scope unchanged; the generic Kit 400
//   copy stays for other callers (hot-zone seasons) unless a shared counterpart
//   is intentionally introduced with all callers covered.
// - The route boundary falls back to the shared ErrorShell for non-400s; the
//   400 branch never renders the generic shell.
//
// How this fails before the builder lands: the route has no +error.svelte, so
// every boundary case fails on the missing file; the load throws bare
// error(400, message) into the root boundary, which renders the generic 400
// shell ("Check your request" + Browse all events) with guest chrome. The
// load/gating/grammar/generic-copy controls below stay green throughout.
//
// Hermetic only: mocked ranking/queue/headers plus the real +page.server.ts
// bundled with stubbed SvelteKit/cloudflare imports (the binding pattern),
// the real +error.svelte SSR-rendered per refused filter with stubbed
// $app/state (the error-shell render precedent), and source-text pins for
// the boundary's import/branch contract. No live database, no network, no
// member PII.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isKitErrorStatus, kitErrorCopy } from "../src/kit-errors";
import { loadMembersBoardData } from "../src/kit-members";

// Minimal real catalog fixture: empty pg-proxy answers the published-games
// read with no games; ranking stays stubbed, gates still fire before any read.
const emptyCatalogDb = () => drizzle(async () => ({ rows: [] }));
import { MemberBoardFilterErrorPage } from "../src/leaderboards/pages";
import { parseActivityParam, parseScopeParam } from "../src/leaderboards/members";
import { parseSeasonParam } from "../src/hotzones/season";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_ERROR_PATH = "web/src/routes/leaderboards/members/+error.svelte";

const OUTAGE_COPY = [
  "temporarily unavailable",
  "Something broke on our side",
  "logged the failure",
  "We will be right back",
];

const MEMBER = { status: "authenticated" as const, userId: "100000000000000231", member: true };
const MEMBER_NAME = "zxq-kit-board-member";

type BadFilter = {
  label: string;
  overrides: Record<string, string>;
  problem: RegExp;
  problemText: string;
};

const BAD_FILTERS: BadFilter[] = [
  {
    label: "season",
    overrides: { seasonParam: "bogus" },
    problem: /Unknown season/,
    problemText: "Unknown season",
  },
  {
    label: "scope",
    overrides: { scopeParam: "bogus" },
    problem: /Unknown scope/,
    problemText: "Unknown scope",
  },
  {
    label: "scope friends deferral",
    overrides: { scopeParam: "friends" },
    problem: /deferred|friend graph/,
    problemText: "The friends scope is deferred: there is no friend graph yet.",
  },
  {
    label: "activity",
    overrides: { activityParam: "chess\u0000" },
    problem: /Unknown activity/,
    problemText: "Unknown activity",
  },
];

const kitArgs = (overrides: Record<string, unknown> = {}) => ({
  env: { APP_URL: "https://example.test" } as never,
  session: { ...MEMBER, username: MEMBER_NAME },
  seasonParam: null,
  scopeParam: null,
  activityParam: null,
  setHeaders: vi.fn((_headers: Record<string, string>) => {}),
  dbForFn: async () => emptyCatalogDb() as never,
  loadRankingFn: async () => [],
  queueBoardViewFn: () => {},
  ...overrides,
});

/**
 * The route boundary source plus every lib component it imports: the builder
 * may inline the board markup in +error.svelte or factor it into a lib
 * component, so pins run against the combined text. Fails while the route has
 * no error boundary at all.
 */
function boardBoundaryText(): string {
  const boundaryFile = resolve(root, BOARD_ERROR_PATH);
  expect(
    existsSync(boundaryFile),
    `Kit board route must own its 400 recovery in ${BOARD_ERROR_PATH} (see the e/[key] route boundary precedent)`,
  ).toBe(true);
  const boundary = readFileSync(boundaryFile, "utf8");
  const imported: string[] = [];
  for (const match of boundary.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = match[1] ?? "";
    let libPath: string | null = null;
    if (spec.startsWith("#lib/"))
      libPath = resolve(root, "web/src/lib", spec.slice("#lib/".length));
    else if (spec.includes("/lib/") && spec.endsWith(".svelte"))
      libPath = resolve(root, "web/src/routes/leaderboards/members", spec);
    if (libPath && existsSync(libPath)) imported.push(readFileSync(libPath, "utf8"));
  }
  return `${boundary}\n${imported.join("\n")}`;
}

/**
 * The boundary file alone, without resolved lib imports: the shared
 * ErrorShell fallback legitimately carries its own 503 copy ("We will be
 * right back"), so the outage-copy pin scans only the route's own source.
 * Fails while the route has no error boundary at all.
 */
function boardBoundaryOwnText(): string {
  const boundaryFile = resolve(root, BOARD_ERROR_PATH);
  expect(
    existsSync(boundaryFile),
    `Kit board route must own its 400 recovery in ${BOARD_ERROR_PATH} (see the e/[key] route boundary precedent)`,
  ).toBe(true);
  return readFileSync(boundaryFile, "utf8");
}

function expectBoardRecovery(text: string, filter: BadFilter): void {
  const label = `Kit board 400 (${filter.label})`;
  // Board-specific page, mirroring Hono's MemberBoardFilterErrorPage shape.
  expect(text, `${label} names the refused filter`).toMatch(filter.problem);
  expect(text, `${label} heading`).toMatch(/Check the board filters|Board filters/);
  expect(text, `${label} Show-the-board recovery`).toContain("Show the board");
  expect(text, `${label} board href`).toContain("/leaderboards/members");
  expect(text, `${label} board testid`).toContain('data-testid="error-board"');
  expect(text, `${label} homepage recovery`).toContain("Back to the homepage");
  expect(text, `${label} homepage testid`).toContain('data-testid="error-home"');
  // Board chrome, not the generic home theme: members-only strap, leaderboard
  // nav, schedule theme, noindex.
  expect(text, `${label} members strap`).toMatch(/Members only|strap/);
  expect(text, `${label} leaderboard nav`).toMatch(/activeNav.*leaderboard|leaderboard/);
  expect(text, `${label} schedule theme`).toMatch(/schedule/);
  expect(text, `${label} noindex`).toMatch(/noindex/);
  // A signed-in member never sees guest chrome on their own board error: the
  // boundary either renders member chrome or hides the account area.
  expect(text, `${label} never guest chrome`).toMatch(
    /hideAccount|accountChrome|Signed in|memberChrome/,
  );
  // The 400 branch is board markup routed on the thrown status — never the
  // shared shell — with the shell kept as the non-400 fallback.
  expect(text, `${label} routes on 400`).toMatch(
    /page\.status\s*===\s*400|status\s*===\s*400|\b400\b/,
  );
  expect(text, `${label} reads the refused filter`).toMatch(/page\.error/);
  expect(text, `${label} falls back to the shared shell`).toContain("ErrorShell");
}

describe("Kit board-filter 400 recovery (route boundary per filter)", () => {
  it.each(BAD_FILTERS)("bad $label renders board-specific recovery naming the filter", (filter) => {
    expectBoardRecovery(boardBoundaryText(), filter);
  });

  it("keeps the 400 branch board-specific and the fallback shared", () => {
    const text = boardBoundaryText();
    const ownText = boardBoundaryOwnText();
    // The boundary handles the board 400 itself: the generic 400 title and
    // events-browse recovery belong to the shared shell (hot-zone callers),
    // not to this route's 400 branch.
    expect(text, "board heading, not generic 400 title").toMatch(
      /Check the board filters|Board filters/,
    );
    // Fallback contract mirrors the e/[key] route boundary: branded states own
    // their robots meta through Shell; only the shell fallback needs one here
    // or the shell import carries it.
    expect(text, "shell fallback with invite").toMatch(/ErrorShell|FALLBACK_INVITE|inviteUrl/);
    // No outage copy in the board 400 source itself: the copy lives in
    // kit-errors.ts data, so a literal here would be a wrong-branch leak. The
    // shared-shell fallback import is excluded because its own 503 branch
    // legitimately carries outage copy.
    for (const copy of OUTAGE_COPY)
      expect(ownText, `board 400 source (${copy})`).not.toContain(copy);
  });
});

describe("Kit board-filter 400 (executed boundary render per filter)", () => {
  let renderBoardError: (status: number, message: string | null) => { head: string; body: string };
  let scratch = "";

  beforeAll(async () => {
    const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler") as {
      compile: (
        source: string,
        options: { generate: string; dev: boolean; filename: string },
      ) => { js: { code: string } };
    };
    scratch = await mkdtemp(join(tmpdir(), "kit-board-400-render-"));
    const entry = join(scratch, "kit-board-error-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import BoardError from ${JSON.stringify(resolve(root, BOARD_ERROR_PATH))};
import { page } from "$app/state";
export function renderBoardError(status, message) {
  page.status = status;
  page.error = message === null ? null : { message };
  const { head, body } = render(BoardError);
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-board-error.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": resolve(root, "web/src/lib") },
      plugins: [
        {
          name: "kit-board-400-app-state-stub",
          setup(plugin) {
            plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
              path: "app-state",
              namespace: "test",
            }));
            plugin.onLoad({ filter: /^app-state$/, namespace: "test" }, () => ({
              contents: `export const page = { status: 500, error: null, url: new URL("https://example.test/leaderboards/members") };`,
              loader: "js",
            }));
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
    ({ renderBoardError } = (await import(pathToFileURL(outfile).href)) as {
      renderBoardError: (status: number, message: string | null) => { head: string; body: string };
    });
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it.each(BAD_FILTERS)(
    "bad $label renders the refused filter with board + homepage recovery",
    async (filter) => {
      // The real thrown message wires load to boundary: the render below must
      // name it in the parse message's own words, never a hard-coded sentence.
      const failure = await loadMembersBoardData(kitArgs({ ...filter.overrides })).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 400 });
      const message = (failure as Error).message;
      expect(message, filter.label).toMatch(filter.problem);
      const { body } = renderBoardError(400, message);
      const label = `Kit board 400 executed (${filter.label})`;
      expect(body, `${label} names the refused filter`).toContain(message);
      expect(body, `${label} heading`).toContain("Check the board filters");
      // The recovery anchors themselves: the header nav also links the board
      // when activeNav is leaderboard (and always links home), so a bare path
      // pin would pass with the wrong href on the recovery link.
      expect(body, `${label} Show-the-board anchor`).toMatch(
        /<a[^>]*href="\/leaderboards\/members"[^>]*data-testid="error-board"[^>]*>Show the board<\/a>|<a[^>]*data-testid="error-board"[^>]*href="\/leaderboards\/members"[^>]*>Show the board<\/a>/,
      );
      expect(body, `${label} homepage anchor`).toMatch(
        /<a[^>]*href="\/"[^>]*data-testid="error-home"[^>]*>Back to the homepage<\/a>|<a[^>]*data-testid="error-home"[^>]*href="\/"[^>]*>Back to the homepage<\/a>/,
      );
      // Board branch, never the generic shell or outage copy.
      expect(body, `${label} never generic 400 title`).not.toContain("Check your request");
      expect(body, `${label} never generic events recovery`).not.toContain("Browse all events");
      for (const copy of OUTAGE_COPY) expect(body, `${label} (${copy})`).not.toContain(copy);
    },
  );

  it("non-400 falls back to the shared shell with no board recovery", () => {
    const { body } = renderBoardError(500, "Something broke");
    expect(body, "fallback keeps the shared 500 copy").toContain(kitErrorCopy(500).title);
    expect(body, "fallback keeps invite recovery").toContain('data-testid="error-invite"');
    expect(body, "fallback keeps homepage recovery").toContain('data-testid="error-home"');
    expect(body, "fallback never board recovery").not.toContain('data-testid="error-board"');
    expect(body, "fallback never board heading").not.toContain("Check the board filters");
  });
});

describe("Kit board-filter 400 (status kept, no read, no log)", () => {
  it.each(BAD_FILTERS)(
    "the load refuses bad $label with the parse message before any read or log",
    async (filter) => {
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => []);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const failure = await loadMembersBoardData(
        kitArgs({ ...filter.overrides, dbForFn, loadRankingFn, queueBoardViewFn, setHeaders }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 400 });
      expect((failure as Error).message, filter.label).toMatch(filter.problem);
      const rendered = JSON.stringify(failure) ?? "";
      for (const copy of OUTAGE_COPY) expect(rendered, filter.label).not.toContain(copy);
      expect(dbForFn, filter.label).not.toHaveBeenCalled();
      expect(loadRankingFn, filter.label).not.toHaveBeenCalled();
      expect(queueBoardViewFn, filter.label).not.toHaveBeenCalled();
      expect(setHeaders, filter.label).toHaveBeenCalledTimes(1);
      expect(setHeaders, filter.label).toHaveBeenCalledWith({
        "cache-control": "private, no-store",
      });
    },
  );
});

describe("Kit board binding (400 + message reach the boundary)", () => {
  let kitLoad: (event: unknown) => Promise<unknown>;
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "kit-board-400-recovery-"));
    const entry = resolve("web/src/routes/leaderboards/members/+page.server.ts");
    const outfile = join(scratch, "board-load.mjs");
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      treeShaking: true,
      tsconfigRaw: { compilerOptions: { target: "ES2022", module: "ESNext" } },
      plugins: [
        {
          name: "kit-board-400-test-runtime",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "workers",
              namespace: "test",
            }));
            plugin.onLoad({ filter: /^workers$/, namespace: "test" }, () => ({
              contents: `export const env = ${JSON.stringify({ APP_URL: "https://example.test" })};`,
              loader: "js",
            }));
            plugin.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: "sveltekit",
              namespace: "test",
            }));
            plugin.onLoad({ filter: /^sveltekit$/, namespace: "test" }, () => ({
              contents: `export function redirect(status, location) { throw Object.assign(new Error("redirect"), { status, location }); } export function error(status, body) { throw Object.assign(new Error(typeof body === "string" ? body : body?.message ?? "error"), { status, body }); }`,
              loader: "js",
            }));
          },
        },
      ],
    });
    ({ load: kitLoad } = (await import(pathToFileURL(outfile).href)) as {
      load: (event: unknown) => Promise<unknown>;
    });
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  const memberEvent = (params: string) => ({
    url: new URL(`https://example.test/leaderboards/members${params}`),
    locals: {
      status: "authenticated",
      session: { userId: MEMBER.userId, username: MEMBER_NAME, member: true },
    },
    cookies: { set: () => {}, delete: () => {} },
    setHeaders: () => {},
  });

  it.each([
    ["season", "?season=bogus", /Unknown season/],
    ["scope", "?scope=bogus", /Unknown scope/],
    ["scope friends", "?scope=friends", /deferred|friend graph/],
    ["activity", "?activity=chess%00", /Unknown activity/],
  ] as const)(
    "bad %s throws 400 carrying the parse message (%s)",
    async (_label, params, problem) => {
      const failure = await kitLoad(memberEvent(params)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 400 });
      const body = (failure as { body?: unknown; message?: string })?.body;
      const text =
        typeof body === "string"
          ? body
          : JSON.stringify(body ?? "") + ((failure as Error)?.message ?? "");
      expect(text, params).toMatch(problem);
    },
  );

  it("keeps guest 302 and non-member 403 ahead of grammar", async () => {
    const headers = new Headers();
    const guest = {
      url: new URL("https://example.test/leaderboards/members?season=bogus"),
      locals: { status: "guest", session: null },
      cookies: { set: () => {}, delete: () => {} },
      setHeaders: (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) headers.set(name, value);
      },
    };
    await expect(kitLoad(guest)).rejects.toMatchObject({ status: 302, location: "/auth/discord" });

    const outsider = {
      url: new URL("https://example.test/leaderboards/members?season=bogus"),
      locals: {
        status: "authenticated",
        session: {
          userId: "100000000000000232",
          username: "zxq-kit-board-outsider",
          member: false,
        },
      },
      cookies: { set: () => {}, delete: () => {} },
      setHeaders: () => {},
    };
    await expect(kitLoad(outsider)).rejects.toMatchObject({ status: 403 });
  });
});

describe("Kit board gating and grammar unchanged", () => {
  it("answers guest 302 and non-member 403 before grammar, with no reads", async () => {
    for (const session of [
      { status: "guest" as const, userId: null, member: false },
      { status: "authenticated" as const, userId: "100000000000000232", member: false },
    ]) {
      const loadRankingFn = vi.fn(async () => []);
      const setHeaders = vi.fn((_headers: Record<string, string>) => {});
      const expected = session.status === "guest" ? 302 : 403;
      await expect(
        loadMembersBoardData(kitArgs({ session, seasonParam: "bogus", loadRankingFn, setHeaders })),
      ).rejects.toMatchObject({ status: expected });
      expect(loadRankingFn).not.toHaveBeenCalled();
      if (session.status === "guest") {
        expect(setHeaders).not.toHaveBeenCalled();
      } else {
        expect(setHeaders).toHaveBeenCalledTimes(1);
        expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
      }
    }
  });

  it("keeps the filter grammar: valid spellings parse, invalid spellings refuse", () => {
    expect(parseSeasonParam(null)?.label).toBe("all");
    expect(parseSeasonParam("2026-Q3")?.label).toBe("2026-Q3");
    expect(parseSeasonParam("bogus")).toBeNull();
    expect(parseScopeParam(null)).toEqual({ ok: true, scope: "overall" });
    expect(parseScopeParam("relative")).toEqual({ ok: true, scope: "relative" });
    expect(parseScopeParam("bogus").ok).toBe(false);
    expect(parseScopeParam("friends")).toMatchObject({ ok: false });
    expect(parseActivityParam(null)).toEqual({ ok: true, game: null });
    expect(parseActivityParam("  Valheim ")).toEqual({ ok: true, game: "valheim" });
    expect(parseActivityParam("chess\u0000").ok).toBe(false);
  });

  it("still serves the valid board with rows, queue and private no-store", async () => {
    const ranked = [
      { userId: "100000000000000233", username: "zxq-kit-board-a", count: 5 },
      { userId: MEMBER.userId, username: MEMBER_NAME, count: 3 },
    ];
    const db = emptyCatalogDb() as never;
    const queueBoardViewFn = vi.fn(() => {});
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    const data = await loadMembersBoardData(
      kitArgs({
        dbForFn: async () => db,
        loadRankingFn: async () => ranked,
        queueBoardViewFn,
        setHeaders,
      }),
    );
    expect(data.rows.map((row) => row.username)).toEqual(["zxq-kit-board-a", MEMBER_NAME]);
    expect(data.rows.map((row) => row.isViewer)).toEqual([false, true]);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ boardKey: "members", resultCount: 2 }),
      undefined,
    );
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("still numbers the relative window around the viewer", async () => {
    const window = [
      { userId: "100000000000000233", username: "zxq-kit-board-a", count: 5, rank: 1 },
      { userId: MEMBER.userId, username: MEMBER_NAME, count: 3, rank: 2 },
    ];
    const loadRankingFn = vi.fn(async () => window);
    const data = await loadMembersBoardData(kitArgs({ scopeParam: "relative", loadRankingFn }));
    expect(data.scope).toBe("relative");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      "relative",
      MEMBER.userId,
    );
    expect(data.rows).toEqual([
      { rank: 1, username: "zxq-kit-board-a", count: 5, isViewer: false },
      { rank: 2, username: MEMBER_NAME, count: 3, isViewer: true },
    ]);
  });
});

describe("Kit generic 400 preserved for other callers", () => {
  it("keeps 400 a first-class client-error status, never outage copy", () => {
    expect(isKitErrorStatus(400)).toBe(true);
    const copy = kitErrorCopy(400);
    expect(copy.code).toBe("400");
    for (const outage of OUTAGE_COPY) {
      expect(copy.title, "generic 400 title").not.toContain(outage);
      expect(copy.lead, "generic 400 lead").not.toContain(outage);
    }
    expect(copy).not.toEqual(kitErrorCopy(500));
    expect(copy).not.toEqual(kitErrorCopy(503));
  });

  it("keeps the shared shell 400 branch with the homepage way home", () => {
    const shell = readFileSync(resolve(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    expect(shell).toMatch(/code === 400/);
    expect(shell.slice(shell.search(/code === 400/))).toContain('data-testid="error-home"');
    // The shared branch stays generic: board recovery lives on the board
    // route, not in the shell hot-zone 400s render through.
    expect(shell).not.toContain('data-testid="error-board"');
  });
});

describe("Hono board 400 reference (the parity target)", () => {
  it.each(BAD_FILTERS)(
    "Hono names bad $label with Show-the-board + homepage recovery",
    (filter) => {
      const html = String(
        MemberBoardFilterErrorPage({
          session: {
            id: MEMBER.userId,
            username: MEMBER_NAME,
            avatar: null,
            member: true,
            moderator: false,
          },
          problem: filter.problemText,
        }),
      );
      expect(html, filter.label).toContain("Check the board filters");
      expect(html, filter.label).toMatch(filter.problem);
      expect(html, filter.label).toContain('data-testid="error-board"');
      expect(html, filter.label).toContain('href="/leaderboards/members"');
      expect(html, filter.label).toContain("Show the board");
      expect(html, filter.label).toContain('data-testid="error-home"');
      expect(html, filter.label).toContain("Back to the homepage");
      for (const copy of OUTAGE_COPY) expect(html, filter.label).not.toContain(copy);
    },
  );
});
