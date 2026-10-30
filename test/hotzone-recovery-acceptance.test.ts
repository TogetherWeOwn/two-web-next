// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only): hot-zone mistakes get a hotzone way forward,
// not a generic dead end.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Today Hono answers a bad `?season=` with the bare branded 400
// (`BadRequestPage` in src/error-pages.tsx: site chrome, recovery code, way
// home — but no season grammar and no hotzone links) on all four paths, and
// unknown signals with the framework default 404 (no shell, no recovery) in
// isolation, or the site-generic suggestions 404 in the full app — never a
// hotzone index or signal link. Kit throws `error(400, "Unknown season")`
// and `error(404, "Not found")` into the generic boundary, whose 400/404
// branches offer Browse-events/home/join recovery but no hotzone context.
// The Kit signal binding also forks its own signal list instead of importing
// the shared vocabulary.
//
// The contract, both twins:
// - Hono bad-season 400 keeps the branded shell (chrome, recovery code 400,
//   home recovery, noindex, no grid, zero throttle spend, zero board-view
//   insert) and adds hotzone recovery: the season grammar named (the default
//   plus year, month and quarter spellings) with links to the hotzone index
//   and all three signals, pinned by test id. Still 400.
// - Hono unknown-signal 404 answers a branded hotzone 404 (chrome, recovery
//   code 404, noindex, no grid) naming joins/voice/games with links plus the
//   index link, pinned by test id. Still 404. A bad season on an unknown
//   signal answers 400, never 404 (season checked first).
// - Kit bad-season 400 renders the same recovery (grammar + index + signals
//   with the same test ids) via the route model or a route-level boundary;
//   the status stays 400 and data payloads stay machine-shaped (no HTML in
//   the thrown or returned model). Kit unknown-signal 404 renders the same
//   signal list plus index link; season-before-signal order kept.
// - Valid renders, 503 behavior and admission rules stay byte-stable: valid
//   seasons/signals render cached 200 grids with no error recovery leaked
//   in, the 503 copy and shells are untouched, and the shared public-read
//   budget still guards valid paths while bad seasons skip it.
// - The shared signal vocabulary is reused: the Kit binding imports it from
//   the aggregates module instead of forking a literal list.
//
// How this fails before the Builder lands: every hotzone-recovery case fails
// — Hono bodies carry no grammar and no hotzone test ids, no Kit hotzone
// route file carries them either, and the Kit binding still forks the list.
// Representation mutants (generic shell restored; recovery test ids dropped;
// forked list restored) fail these tests. Positive controls (statuses,
// shell, order, valid/503 stability, zero spend) pass now and must stay
// green. Hermetic doubles only: no live DB, no network.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { emptyGrid } from "../src/hotzones/aggregates";
import { registerHotzoneRoutes } from "../src/hotzones/routes";
import { kitErrorCopy } from "../src/kit-errors";
import {
  dispatchHotzonesRequest,
  loadHotzoneSignalData,
  loadHotzonesIndexData,
} from "../src/kit-hotzones";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const PATHS = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];
const SIGNALS = ["joins", "voice", "games"] as const;
const IP = "192.0.2.23";
const APP_URL = "https://next.example.test";
const BAD_SEASON = "not-a-season";
const UNKNOWN_SIGNALS = ["bogus", "presence", "JOINS"];

// Pinned recovery test ids, paralleling the member-board precedent
// (`error-board` + `error-home`): the index link plus one per signal, with
// the way home kept on every error.
const INDEX_TESTID = "error-hotzones";
const SIGNAL_TESTID = (signal: string) => `error-hotzone-${signal}`;
const HOME_TESTID = "error-home";

// Mirrors the statement-double fixture in the bad-season acceptance suite:
// the real admission transaction runs against local doubles so a throttle
// spend is observable, and every ADMIN_DB reach is counted — a board-view
// insert cannot happen without one.
function fixture() {
  let now = Date.now();
  const hits: { bucket: string; at: number }[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
        return [
          {
            n: rows.length,
            wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
          },
        ];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) {
        hits.push({ bucket: String(values[0]), at: now });
        return [];
      }
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  const throttleStore = vi.fn(async () => sql as unknown as Sql);
  const transaction = vi.fn(async () => {
    throw new Error("hot-zone DB touched on an error answer");
  });
  const poisonDb = { transaction } as unknown as Db;
  let currentDb: Db | null = null;
  const eventStore = vi.fn(() => currentDb);
  const app = new Hono<{ Bindings: Env }>();
  registerHotzoneRoutes(app);
  const env = {
    APP_URL,
    THROTTLE_STORE: throttleStore,
    get ADMIN_DB() {
      return eventStore();
    },
  } as unknown as EnvWithThrottle;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": IP, ...init.headers } }, env);
  return {
    request,
    hits,
    throttleStore,
    eventStore,
    transaction,
    // Opt in only for healthy-grid controls; the default stays null and the
    // poison DB still proves error routes never reach an aggregate read.
    healthyEmpty: () => {
      const whereResult = Object.assign(Promise.resolve([{ n: 0 }]), {
        groupBy: async () => [],
      });
      const tx = {
        execute: async () => [],
        select: () => ({
          from: () => ({
            where: () => whereResult,
            leftJoin: () => ({ where: () => whereResult }),
          }),
        }),
        insert: () => ({ values: async () => [] }),
      };
      currentDb = {
        transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
      } as unknown as Db;
    },
    poison: () => {
      currentDb = poisonDb;
    },
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");

// The branded-shell body contract for hotzone errors: site chrome, the
// decorative recovery code, noindex, the way home, and no board leaked in.
function expectBrandedShell(body: string, code: "400" | "404", label: string) {
  expect(body, label).toContain("<html");
  expect(body, label).toContain("Together We Own");
  expect(body, label).toContain('href="/about"');
  expect(body, label).toMatch(
    new RegExp(`class="recovery-code(?:\\s[^"]*)?"[^>]*>\\s*${code}\\s*<`),
  );
  expect(body, label).toContain("noindex");
  expect(body, label).toContain(`data-testid="${HOME_TESTID}"`);
  expect(body, label).toContain("Back to the homepage");
  expect(body, label).not.toContain("<table");
}

// Hotzone recovery links: the index plus all three signals, each pinned by
// test id with its href on the same anchor (attribute order free).
function expectHotzoneLinks(body: string, label: string) {
  const anchorWith = (testid: string, href: string) =>
    new RegExp(
      `<a\\b[^>]*data-testid="${testid}"[^>]*href="${href}"[^>]*>` +
        `|<a\\b[^>]*href="${href}"[^>]*data-testid="${testid}"[^>]*>`,
    );
  expect(body, `${label} index link`).toMatch(anchorWith(INDEX_TESTID, "/hotzones"));
  for (const signal of SIGNALS) {
    expect(body, `${label} ${signal} link`).toMatch(
      anchorWith(SIGNAL_TESTID(signal), `/hotzones/${signal}`),
    );
  }
}

// The season grammar named: the refused filter plus the accepted spellings —
// the default, a year, a month and a quarter — in numeric or pattern form.
function expectSeasonGrammar(body: string, label: string) {
  expect(body, `${label} names the season filter`).toMatch(/season/i);
  expect(body, `${label} names a year spelling`).toMatch(/2026|YYYY/);
  expect(body, `${label} names a month spelling`).toMatch(/2026-09|YYYY-MM/);
  expect(body, `${label} names a quarter spelling`).toMatch(/2026-Q|quarter|YYYY-Q/);
}

function expectSignalNames(body: string, label: string) {
  for (const signal of SIGNALS) expect(body, `${label} names ${signal}`).toContain(signal);
}

// Kit hotzone route sources carrying recovery: the happy-path pages plus any
// route-level boundary or hotzone library component the Builder adds. The
// generic root boundary is excluded: hotzone recovery must live on hotzone
// routes, never pollute the site-generic shell.
function kitHotzoneSources(): { path: string; body: string }[] {
  const fixed = [
    "web/src/routes/hotzones/+page.svelte",
    "web/src/routes/hotzones/[signal]/+page.svelte",
    "web/src/routes/hotzones/+error.svelte",
    "web/src/routes/hotzones/[signal]/+error.svelte",
  ];
  const out: { path: string; body: string }[] = [];
  for (const path of fixed) {
    const abs = resolve(root, path);
    if (existsSync(abs)) out.push({ path, body: readFileSync(abs, "utf8") });
  }
  const lib = resolve(root, "web/src/lib");
  if (existsSync(lib)) {
    for (const name of readdirSync(lib)) {
      if (/hotzone/i.test(name) && name.endsWith(".svelte")) {
        const path = `web/src/lib/${name}`;
        out.push({ path, body: readFileSync(resolve(root, path), "utf8") });
      }
    }
  }
  return out;
}

// At least one hotzone route file carries the recovery itself, or imports the
// library component that does — dead library code with no route import fails.
function expectKitRecoveryWired(sources: { path: string; body: string }[], label: string) {
  const carriers = sources.filter((s) => s.body.includes(`data-testid="${INDEX_TESTID}"`));
  expect(
    carriers.map((c) => c.path),
    `${label} recovery exists`,
  ).not.toHaveLength(0);
  const routePaths = sources.filter((s) => s.path.startsWith("web/src/routes/hotzones/"));
  const direct = carriers.some((c) => c.path.startsWith("web/src/routes/hotzones/"));
  const imported = carriers.some(
    (c) =>
      !c.path.startsWith("web/src/routes/hotzones/") &&
      routePaths.some((r) => r.body.includes(c.path) || r.body.includes(c.path.split("/").pop()!)),
  );
  expect(direct || imported, `${label} recovery wired to a hotzone route`).toBe(true);
}

// Executed Kit boundary pins: the real hotzones +error.svelte SSR-rendered
// per status with a mocked $app/state page, in the style of the kit-home and
// kit-event-states harnesses. Source greps alone keep the suite green when the
// 400 predicate drifts to 418, when 503 joins the recovery condition, or when
// the season/signal branches swap their content — the concatenated sources
// still contain every test id and grammar string. These renders assert
// boundary-specific markers (hotzone test ids plus the 400 grammar lead versus
// the 404 signal lead), never the generic recovery-code/error-home markers the
// shared ErrorShell also renders, so each mutant turns the suite red.
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileHotzoneBoundary } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderHotzoneBoundary = (status: number) => string;

let renderHotzoneBoundary: RenderHotzoneBoundary;
let hotzoneBoundaryScratch = "";

beforeAll(async () => {
  hotzoneBoundaryScratch = mkdtempSync(join(tmpdir(), "hotzone-boundary-"));
  const mockState = join(hotzoneBoundaryScratch, "mock-app-state.mjs");
  writeFileSync(
    mockState,
    "export const page = globalThis.__HOTZONE_BOUNDARY_PAGE__ ??= { status: 400 };\n",
  );
  (globalThis as { __HOTZONE_BOUNDARY_PAGE__?: { status: number } }).__HOTZONE_BOUNDARY_PAGE__ = {
    status: 400,
  };
  const entry = join(hotzoneBoundaryScratch, "hotzone-boundary-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import HotzoneError from ${JSON.stringify(join(root, "web/src/routes/hotzones/+error.svelte"))};
export function renderHotzoneBoundary(status) {
  globalThis.__HOTZONE_BOUNDARY_PAGE__.status = status;
  const { head, body } = render(HotzoneError);
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(hotzoneBoundaryScratch, "hotzone-boundary-bundle.mjs");
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
        name: "hotzone-boundary-mock-app-state",
        setup(plugin) {
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({ path: mockState }));
        },
      },
      {
        name: "hotzone-boundary-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compileHotzoneBoundary(source, {
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
  ({ renderHotzoneBoundary } = (await import(pathToFileURL(outfile).href)) as unknown as {
    renderHotzoneBoundary: RenderHotzoneBoundary;
  });
}, 60000);

afterAll(() => {
  if (hotzoneBoundaryScratch) rmSync(hotzoneBoundaryScratch, { recursive: true, force: true });
});

describe("hotzone bad-season recovery (Hono 400)", () => {
  it.each(PATHS)("answers %s with grammar plus index and signal links", async (path) => {
    const f = fixture();
    f.poison();
    const response = await f.request(`${path}?season=${BAD_SEASON}`, {
      headers: { accept: "text/html" },
    });
    expect(response.status, path).toBe(400);
    expect(response.headers.get("content-type"), path).toContain("text/html");
    expect(response.headers.get("cache-control"), path).toBe("no-store, private");
    const body = await response.text();
    expectBrandedShell(body, "400", path);
    expectSeasonGrammar(body, path);
    expectHotzoneLinks(body, path);
    // Grammar first: zero throttle spend, zero DB opens, zero transactions.
    expect(f.hits, path).toHaveLength(0);
    expect(f.throttleStore, path).not.toHaveBeenCalled();
    expect(f.eventStore, path).not.toHaveBeenCalled();
    expect(f.transaction, path).not.toHaveBeenCalled();
    // No tracker-style id leak in the refusal (pattern, not a literal id).
    expect(body, path).not.toMatch(/[A-Z]{3}-\d{2,}/);
  });

  it.each(["2026-13", "2026-Q5", ""])(
    "names the grammar for every bad-season spelling (%j)",
    async (season) => {
      const f = fixture();
      f.poison();
      for (const path of ["/hotzones", "/hotzones/joins"]) {
        const response = await f.request(`${path}?season=${encodeURIComponent(season)}`);
        expect(response.status, `${path} season=${season}`).toBe(400);
        const body = await response.text();
        expectSeasonGrammar(body, `${path} season=${season}`);
        expectHotzoneLinks(body, `${path} season=${season}`);
      }
      expect(f.hits).toHaveLength(0);
      expect(f.throttleStore).not.toHaveBeenCalled();
      expect(f.eventStore).not.toHaveBeenCalled();
    },
  );
});

describe("hotzone unknown-signal recovery (Hono 404)", () => {
  it.each(UNKNOWN_SIGNALS)(
    "answers /hotzones/%s with the signal list plus index link",
    async (unknown) => {
      const f = fixture();
      f.poison();
      const response = await f.request(`/hotzones/${unknown}?season=2026`, {
        headers: { accept: "text/html" },
      });
      expect(response.status, unknown).toBe(404);
      expect(response.headers.get("content-type"), unknown).toContain("text/html");
      expect(response.headers.get("cache-control"), unknown).toBe("no-store, private");
      const body = await response.text();
      expectBrandedShell(body, "404", unknown);
      expectSignalNames(body, unknown);
      expectHotzoneLinks(body, unknown);
      // Unknown signals never spend: zero throttle, zero DB opens.
      expect(f.hits, unknown).toHaveLength(0);
      expect(f.throttleStore, unknown).not.toHaveBeenCalled();
      expect(f.eventStore, unknown).not.toHaveBeenCalled();
      expect(f.transaction, unknown).not.toHaveBeenCalled();
      expect(body, unknown).not.toMatch(/[A-Z]{3}-\d{2,}/);
    },
  );

  it("answers an unknown signal without a season the same way", async () => {
    const f = fixture();
    f.poison();
    const response = await f.request("/hotzones/bogus");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const body = await response.text();
    expectSignalNames(body, "absent season");
    expectHotzoneLinks(body, "absent season");
  });

  it("checks the season before the signal: a bad season on an unknown signal is 400", async () => {
    const f = fixture();
    f.poison();
    const response = await f.request(`/hotzones/bogus?season=${BAD_SEASON}`);
    expect(response.status).toBe(400);
    const body = await response.text();
    expectSeasonGrammar(body, "season-first");
    expectHotzoneLinks(body, "season-first");
    expect(f.hits).toHaveLength(0);
    expect(f.throttleStore).not.toHaveBeenCalled();
    expect(f.eventStore).not.toHaveBeenCalled();
  });
});

describe("hotzone bad-season recovery (Kit 400)", () => {
  it("keeps the Kit load rejecting a bad season with 400 before any database work", async () => {
    const dbForFn = vi.fn(async () => null);
    const loadJoinsGridFn = vi.fn(async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }));
    const recordBoardViewFn = vi.fn(async () => {});
    await expect(
      loadHotzonesIndexData({
        env: { APP_URL } as never,
        seasonParam: BAD_SEASON,
        setHeaders: vi.fn(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(loadJoinsGridFn).not.toHaveBeenCalled();
    expect(recordBoardViewFn).not.toHaveBeenCalled();
  });

  it("renders the same grammar plus index and signal links from a hotzone route", () => {
    const sources = kitHotzoneSources();
    expect(sources.map((s) => s.path)).toContain("web/src/routes/hotzones/+page.svelte");
    const combined = sources.map((s) => s.body).join("\n");
    expect(combined, "Kit index link").toContain(`data-testid="${INDEX_TESTID}"`);
    for (const signal of SIGNALS) {
      expect(combined, `Kit ${signal} link`).toContain(`data-testid="${SIGNAL_TESTID(signal)}"`);
    }
    for (const signal of SIGNALS)
      expect(combined, `Kit ${signal} href`).toContain(`/hotzones/${signal}`);
    expect(combined, "Kit grammar year").toMatch(/2026|YYYY/);
    expect(combined, "Kit grammar month").toMatch(/2026-09|YYYY-MM/);
    expect(combined, "Kit grammar quarter").toMatch(/2026-Q|quarter|YYYY-Q/);
    expectKitRecoveryWired(sources, "Kit bad-season");
  });

  it("keeps the bad-season data payload machine-shaped: no HTML in the thrown model", () => {
    for (const path of [
      "web/src/routes/hotzones/+page.server.ts",
      "web/src/routes/hotzones/[signal]/+page.server.ts",
    ]) {
      const source = readSource(path);
      expect(source, `${path} keeps a 400 mapping`).toContain("400");
      // The binding throws a status with a plain message or a plain-data
      // model; recovery HTML is rendered by Svelte, never serialized into
      // the data payload.
      expect(source, `${path} throws no anchor`).not.toContain("<a");
      expect(source, `${path} throws no document`).not.toContain("<html");
    }
  });

  it("leaves the site-generic 400 shell without hotzone links", () => {
    const page = readSource("web/src/routes/+error.svelte");
    expect(page).not.toContain(INDEX_TESTID);
    for (const signal of SIGNALS) expect(page).not.toContain(SIGNAL_TESTID(signal));
  });
});

describe("hotzone unknown-signal recovery (Kit 404)", () => {
  it("keeps the Kit helper rejecting an unknown signal with 404 before any database work", async () => {
    const dbForFn = vi.fn(async () => null);
    const loadJoinsGridFn = vi.fn(async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }));
    const recordBoardViewFn = vi.fn(async () => {});
    await expect(
      loadHotzoneSignalData({
        env: { APP_URL } as never,
        seasonParam: "2026",
        signalParam: "bogus",
        setHeaders: vi.fn(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(loadJoinsGridFn).not.toHaveBeenCalled();
    expect(recordBoardViewFn).not.toHaveBeenCalled();
  });

  it("renders the same signal list plus index link from a hotzone route", () => {
    const sources = kitHotzoneSources();
    const combined = sources.map((s) => s.body).join("\n");
    for (const signal of SIGNALS) expect(combined, `Kit names ${signal}`).toContain(signal);
    expect(combined, "Kit index link").toContain(`data-testid="${INDEX_TESTID}"`);
    for (const signal of SIGNALS) {
      expect(combined, `Kit ${signal} link`).toContain(`data-testid="${SIGNAL_TESTID(signal)}"`);
    }
    expectKitRecoveryWired(sources, "Kit unknown-signal");
  });

  it("keeps season-before-signal order in the helper and the binding", async () => {
    const dbForFn = vi.fn(async () => null);
    await expect(
      loadHotzoneSignalData({
        env: { APP_URL } as never,
        seasonParam: BAD_SEASON,
        signalParam: "bogus",
        setHeaders: vi.fn(),
        dbForFn,
        loadJoinsGridFn: async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }),
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
    // The binding mirrors the Hono order whatever vocabulary it uses: the
    // season parse precedes every signal check and every 404 mapping.
    const source = readSource("web/src/routes/hotzones/[signal]/+page.server.ts");
    const seasonPos = source.indexOf("parseSeasonParam");
    const signalPositions = ["SIGNALS", "isHotzoneSignal", "HOTZONE_SIGNALS", "error(404"]
      .map((needle) => source.indexOf(needle))
      .filter((pos) => pos >= 0);
    expect(seasonPos).toBeGreaterThanOrEqual(0);
    expect(signalPositions).not.toHaveLength(0);
    for (const pos of signalPositions) expect(seasonPos).toBeLessThan(pos);
  });

  it("leaves the site-generic 404 shell without hotzone links", () => {
    const page = readSource("web/src/routes/+error.svelte");
    expect(page).not.toContain(INDEX_TESTID);
    for (const signal of SIGNALS) expect(page).not.toContain(SIGNAL_TESTID(signal));
  });
});

describe("hotzone Kit boundary executed branches", () => {
  it("renders 400 with the season grammar plus hotzone recovery, never signal content", () => {
    const html = renderHotzoneBoundary(400);
    // Boundary-specific: the grammar lead plus the hotzone index and signals.
    expect(html).toContain("That season did not match");
    expect(html).toContain("2026");
    expect(html).toContain("2026-09");
    expect(html).toContain("2026-Q3");
    expect(html).toContain("Browse all hot zones");
    expect(html).toContain(`data-testid="${INDEX_TESTID}"`);
    for (const signal of SIGNALS) {
      expect(html).toContain(`data-testid="${SIGNAL_TESTID(signal)}"`);
    }
    // A swapped branch would serve the signal lead here instead of grammar.
    expect(html).not.toContain("Unknown hot zone signal");
    // A drifted predicate (400 to 418) would delegate to the generic 400
    // shell: Browse-events recovery, never hotzone links.
    expect(html).not.toContain('data-testid="error-events"');
    expect(html).not.toContain('data-testid="error-join"');
    expect(html).not.toContain('data-testid="error-invite"');
    expect(html).not.toContain('data-testid="error-retry"');
  });

  it("renders 404 with the signal list plus hotzone recovery, never grammar", () => {
    const html = renderHotzoneBoundary(404);
    expect(html).toContain("Unknown hot zone signal");
    expect(html).toContain("Browse all hot zones");
    expect(html).toContain(`data-testid="${INDEX_TESTID}"`);
    for (const signal of SIGNALS) {
      expect(html).toContain(`data-testid="${SIGNAL_TESTID(signal)}"`);
      expect(html).toContain(`/hotzones/${signal}`);
    }
    // A swapped branch would serve the season grammar here instead.
    expect(html).not.toContain("That season did not match");
    // The generic 404 shell offers join/events recovery, never hotzone links.
    expect(html).not.toContain('data-testid="error-join"');
    expect(html).not.toContain('data-testid="error-all-events"');
    expect(html).not.toContain('data-testid="error-events"');
    expect(html).not.toContain('data-testid="error-invite"');
    expect(html).not.toContain('data-testid="error-retry"');
  });

  it("delegates 503 to the shared shell with no hotzone recovery", () => {
    const html = renderHotzoneBoundary(503);
    // Adding 503 to the recovery condition would render hotzone links and
    // signal content here; the outage must keep the shared shell instead.
    expect(html).not.toContain(INDEX_TESTID);
    for (const signal of SIGNALS) expect(html).not.toContain(SIGNAL_TESTID(signal));
    expect(html).not.toContain("That season did not match");
    expect(html).not.toContain("Unknown hot zone signal");
    expect(html).not.toContain("Browse all hot zones");
    expect(html).not.toContain(`data-testid="${HOME_TESTID}"`);
    // The shared 503 branch: invite plus retry, exactly as the root boundary.
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain('data-testid="error-retry"');
  });

  it("delegates 418 to the shared shell with no hotzone recovery", () => {
    const html = renderHotzoneBoundary(418);
    // A drifted 400 predicate (400 to 418) would render hotzone recovery for
    // this status; unknown statuses must fall back to the shared 500 shell.
    expect(html).not.toContain(INDEX_TESTID);
    for (const signal of SIGNALS) expect(html).not.toContain(SIGNAL_TESTID(signal));
    expect(html).not.toContain("That season did not match");
    expect(html).not.toContain("Unknown hot zone signal");
    expect(html).not.toContain("Browse all hot zones");
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain(`data-testid="${HOME_TESTID}"`);
  });

  it("checks the season before the signal in the binding load body", () => {
    // The import-order pin above keeps passing when the two load lines swap;
    // this pin reads the executed load body top to bottom so swapping
    // +page.server.ts:30-31 (season no longer first at the binding) fails.
    const source = readSource("web/src/routes/hotzones/[signal]/+page.server.ts");
    const loadBody = source.slice(source.indexOf("export const load"));
    expect(loadBody).toContain("parseSeasonParam");
    expect(loadBody).toContain("isHotzoneSignal");
    const seasonPos = loadBody.indexOf("parseSeasonParam");
    const signalPos = loadBody.indexOf("isHotzoneSignal");
    expect(seasonPos).toBeGreaterThanOrEqual(0);
    expect(signalPos).toBeGreaterThanOrEqual(0);
    expect(seasonPos).toBeLessThan(signalPos);
    const err400 = loadBody.indexOf("error(400");
    const err404 = loadBody.indexOf("error(404");
    expect(err400).toBeGreaterThanOrEqual(0);
    expect(err404).toBeGreaterThanOrEqual(0);
    expect(err400).toBeLessThan(err404);
  });
});

describe("hotzone valid and outage stability", () => {
  it.each(["all", "2026", "2026-09", "2026-Q3"])(
    "still renders a valid ?season=%s as a cached 200 board with no error recovery",
    async (season) => {
      const f = fixture();
      f.healthyEmpty();
      const response = await f.request(`/hotzones?season=${season}`);
      expect(response.status, season).toBe(200);
      expect(response.headers.get("cache-control"), season).toBe("public, max-age=300");
      expect(response.headers.get("vary"), season).toBe("Cookie");
      const body = await response.text();
      expect(body, season).toContain("<table");
      expect(body.match(/<table\b/g), season).toHaveLength(3);
      expect(body, season).toContain("0 joins across 0 scheduled gatherings");
      expect(body, season).not.toContain("Join activity is temporarily unavailable.");
      for (const signal of SIGNALS) expect(body, season).toContain(`/hotzones/${signal}`);
      expect(body, season).not.toContain(INDEX_TESTID);
      for (const signal of SIGNALS) expect(body, season).not.toContain(SIGNAL_TESTID(signal));
      expect(body, season).not.toContain("We will be right back");
      expect(body, season).not.toContain("broke on our side");
    },
  );

  it.each([...SIGNALS])(
    "still renders the valid %s signal with no error recovery",
    async (signal) => {
      const f = fixture();
      f.healthyEmpty();
      const response = await f.request(`/hotzones/${signal}?season=2026`);
      expect(response.status, signal).toBe(200);
      expect(response.headers.get("cache-control"), signal).toBe("public, max-age=300");
      expect(response.headers.get("vary"), signal).toBe("Cookie");
      const body = await response.text();
      expect(body, signal).toContain("<table");
      expect(body, signal).not.toContain("Join activity is temporarily unavailable.");
      if (signal === "joins") expect(body, signal).toContain("0 joins");
      expect(body, signal).not.toContain(INDEX_TESTID);
      for (const other of SIGNALS) expect(body, signal).not.toContain(SIGNAL_TESTID(other));
    },
  );

  it.each(PATHS)(
    "keeps null-DB %s a cached 200 with honest joins unavailability and no error recovery",
    async (path) => {
      const f = fixture();
      const response = await f.request(`${path}?season=2026`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("public, max-age=300");
      expect(response.headers.get("vary"), path).toBe("Cookie");
      const body = await response.text();
      expect(body, path).not.toContain(INDEX_TESTID);
      for (const signal of SIGNALS) expect(body, path).not.toContain(SIGNAL_TESTID(signal));
      expect(body, path).not.toContain("We will be right back");
      expect(body, path).not.toContain("broke on our side");
      expect(body, path).not.toContain("0 joins");
      if (path === "/hotzones" || path === "/hotzones/joins") {
        expect(body, path).toMatch(
          /<p\b[^>]*role="status"[^>]*>Join activity is temporarily unavailable\.<\/p>/,
        );
        const joins =
          path === "/hotzones"
            ? body.match(
                /<section\b[^>]*aria-labelledby="hotzones-joins-heading"[^>]*>[\s\S]*?<\/section>/,
              )?.[0]
            : body;
        expect(joins, path).toBeDefined();
        expect(joins, path).not.toContain("<table");
        expect(joins, path).not.toContain("Peak:");
      } else {
        expect(body, path).not.toContain("Join activity is temporarily unavailable.");
        expect(body, path).toContain("<table");
        expect(body, path).toContain("Estimated peak:");
      }
      if (path === "/hotzones") {
        for (const signal of ["voice", "games"]) {
          const prior = body.match(
            new RegExp(
              `<section\\b[^>]*aria-labelledby="hotzones-${signal}-heading"[^>]*>[\\s\\S]*?<\\/section>`,
            ),
          )?.[0];
          expect(prior, signal).toBeDefined();
          expect(prior, signal).toContain("<table");
          expect(prior, signal).toContain("Estimated peak:");
          expect(prior, signal).not.toContain("Join activity is temporarily unavailable.");
        }
        expect(body.match(/<table\b/g), path).toHaveLength(2);
      }
    },
  );

  it("still serves Kit valid loads with the public cache policy", async () => {
    const setHeaders = vi.fn();
    const data = await loadHotzonesIndexData({
      env: { APP_URL } as never,
      seasonParam: "2026",
      setHeaders,
      dbForFn: async () => null,
      loadJoinsGridFn: async () => ({ cells: emptyGrid(), total: 3, eventCount: 2 }),
      recordBoardViewFn: async () => {},
    });
    expect(data.season).toBe("2026");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({
      "cache-control": "public, max-age=300",
      vary: "Cookie",
    });
    const signal = await loadHotzoneSignalData({
      env: { APP_URL } as never,
      seasonParam: "2026",
      signalParam: "joins",
      setHeaders: vi.fn(),
      dbForFn: async () => null,
      loadJoinsGridFn: async () => ({ cells: emptyGrid(), total: 3, eventCount: 2 }),
      recordBoardViewFn: async () => {},
    });
    expect(signal.signal).toBe("joins");
  });

  it("still maps a refused aggregate read to a branded 503 with no hotzone recovery", async () => {
    const setHeaders = vi.fn();
    const recordBoardViewFn = vi.fn(async () => {});
    await expect(
      loadHotzonesIndexData({
        env: { APP_URL } as never,
        seasonParam: null,
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        recordBoardViewFn,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(recordBoardViewFn).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
    // The 503 copy is untouched by this slice.
    expect(kitErrorCopy(503)).toEqual({
      code: "503",
      title: "We will be right back",
      lead: "The site is temporarily unavailable. You can use the Discord invite or return to the homepage.",
    });
    const shell = readSource("web/src/lib/ErrorShell.svelte");
    const outageBranch = shell.slice(shell.lastIndexOf("{:else}"));
    expect(outageBranch).not.toContain(INDEX_TESTID);
    for (const signal of SIGNALS) expect(outageBranch).not.toContain(SIGNAL_TESTID(signal));
    const maintenance = readSource("src/error-pages.tsx");
    const maintenanceBranch = maintenance.slice(maintenance.indexOf("MaintenancePage"));
    expect(maintenanceBranch).not.toContain(INDEX_TESTID);
  });

  it("still guards valid Kit paths and skips the guard for a bad season", async () => {
    const render = vi.fn(async () => new Response("kit"));
    const guard = vi.fn(async () => null);
    const valid = await dispatchHotzonesRequest(
      new Request("https://next.example.test/hotzones", { method: "GET" }),
      { APP_URL } as never,
      render,
      guard,
    );
    expect(valid.status).toBe(200);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    guard.mockClear();
    render.mockClear();
    const bad = await dispatchHotzonesRequest(
      new Request(`https://next.example.test/hotzones?season=${BAD_SEASON}`, { method: "GET" }),
      { APP_URL } as never,
      render,
      guard,
    );
    expect(bad.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(1);
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("hotzone shared signal vocabulary", () => {
  it("reuses the shared vocabulary in the Kit signal binding instead of a forked list", () => {
    const source = readSource("web/src/routes/hotzones/[signal]/+page.server.ts");
    expect(source).toMatch(
      /\b(HOTZONE_SIGNALS|isHotzoneSignal)\b[^;]*from\s+["'][^"']*hotzones\/aggregates["']/,
    );
    expect(source).not.toContain('["joins", "voice", "games"]');
    expect(source).not.toContain("['joins', 'voice', 'games']");
  });

  it("keeps the helpers and Hono on the shared predicate", () => {
    expect(readSource("src/kit-hotzones.ts")).toContain("isHotzoneSignal");
    expect(readSource("src/hotzones/routes.tsx")).toContain("isHotzoneSignal");
    expect(readSource("src/hotzones/aggregates.ts")).toContain("HOTZONE_SIGNALS");
  });
});

describe("hotzone recovery twin parity", () => {
  it("pins the same recovery test ids on both twins", async () => {
    const f = fixture();
    const hono = await (
      await f.request(`/hotzones?season=${BAD_SEASON}`, { headers: { accept: "text/html" } })
    ).text();
    const kit = kitHotzoneSources()
      .map((s) => s.body)
      .join("\n");
    for (const testid of [INDEX_TESTID, ...SIGNALS.map(SIGNAL_TESTID), HOME_TESTID]) {
      const inHono = hono.includes(`data-testid="${testid}"`);
      const inKit = testid === HOME_TESTID ? true : kit.includes(`data-testid="${testid}"`);
      // The home recovery lives in the shared Kit shell, not the hotzone
      // route files; the hotzone test ids must match on both twins.
      expect(inHono, `Hono carries ${testid}`).toBe(true);
      expect(inKit, `Kit carries ${testid}`).toBe(true);
    }
  });
});
