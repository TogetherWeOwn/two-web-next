// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only) for hot-zone peak callouts + honest unavailable reads.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// T2 from the roadmap (M191): both twins promise "When {signal} activity peaks,
// by hour and weekday" in signal meta but compute no peak; and
// `loadJoinsGrid(null)` yields zeros rendered unconditionally (Kit 503s only on
// throw), where the leaderboards `available` flag is the proven pattern.
//
// Required build contract:
//
// 1. Framework-free `peakCell(cells)` in `src/hotzones/aggregates.ts`:
//    `export function peakCell(cells: HeatGrid): { weekday: number; hour: number;
//    count: number } | null`. Weekday 0..6 matches WEEKDAY_NAMES order
//    (Sunday=0, Postgres dow); hour 0..23 UTC; count is the max cell value.
//    Tie-break is deterministic: earliest weekday wins, then earliest hour
//    (scan weekday 0..6 outer, hour 0..23 inner, strict `>` keeps the first
//    max). Empty/all-zero grids (no cell > 0) return null and render no
//    callout. Pure function of cells; no reads, no dates, no seasons.
//
// 2. One peak summary line per grid on index + signal pages, both twins,
//    computed from the already-loaded cells (no new reads or collection):
//    - Joins peak `<p>` contains `Peak:` (capital P, colon), the full weekday
//      name, the zero-padded `HH:00` hour, and the peak count; it never
//      contains `estimat` (any case) because joins are real data.
//    - Voice/games peak `<p>` contains `Estimated peak:` (capital E, lowercase
//      p, colon), the weekday, the `HH:00` hour, and the count. The
//      `Estimated` qualifier is required on every voice/games peak line.
//    - Index shows three peak lines (one per section) when all grids are
//      non-empty; each signal page shows one. Null peaks render no line:
//      `<main>` contains no `peak` (any case) when every grid is empty.
//    - Hono pages compute peaks inline from the cells they receive. Kit Svelte
//      cannot read HTML grids, so the Kit helper returns peak objects and the
//      server bindings pass them through (see 3); Svelte formats them with
//      WEEKDAY_NAMES from the client-safe weekday-names module.
//
// 3. Joins `available` threading (leaderboards pattern):
//    - Hono `HotzonesIndexPage`/`HotzoneSignalPage` accept `available?: boolean`
//      (omitted means available, so existing callers keep working). Routes pass
//      `available={db !== null}`.
//    - `loadHotzonesIndexData` returns `available: boolean` (db !== null) plus
//      `peaks: { joins, voice, games }` (each `Peak | null`); the joins peak is
//      null when unavailable or empty, voice/games peaks come from the priors.
//      `loadHotzoneSignalData` returns `available: boolean` (joins: db !== null;
//      voice/games: always true) plus `peak: Peak | null`.
//    - Kit `+page.server.ts` bindings pass `available` and the peaks through;
//      Svelte props are `available` + `joinsPeak`/`voicePeak`/`gamesPeak`
//      (index) and `available` + `peak` (signal). Peak objects are
//      `{ weekday, hour, count } | null`.
//    - Helper peak computation calls `peakCell` once per grid on already-loaded
//      cells: `loadJoinsGridFn` is still called exactly once per load.
//
// 4. Outage line (joins section only, both twins):
//    - Exact copy: `Join activity is temporarily unavailable.` in a
//      `<p role="status">`, same shape as the leaderboards outage line.
//    - Rendered only when the joins read has no database (`available` false).
//      The joins grid table is hidden then (no silent zeros); priors still
//      render their tables, copy, and peaks.
//    - Genuine-empty (zeros with a database, `available` true) keeps current
//      copy (`0 joins across 0 scheduled gatherings`, success-only note),
//      keeps its grid table, shows no outage line and no joins peak.
//
// How this fails before the Builder lands: `peakCell` is missing so every unit
// case fails; Hono/Kit renders contain no `Peak:`/`Estimated peak:` lines and
// no outage line; Kit helpers return no `available`/`peaks`; source pins for
// `available=`/`available:`/`peakCell`/`Join activity is temporarily
// unavailable.` fail. Positive controls already pass and must keep passing:
// empty grids render no peak, genuine-empty keeps current copy with tables and
// no outage line (hermetic + live-DB), and the 200/400/404 grammar behaviour is
// unchanged (pinned by the locked seasonal file, never edited here).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import * as aggregates from "../src/hotzones/aggregates";
import { emptyGrid, type HeatGrid } from "../src/hotzones/aggregates";
import { HotzoneSignalPage, HotzonesIndexPage, renderHotzoneGrid } from "../src/hotzones/pages";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import type { Env } from "../src/env";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { createMemorySessionStore } from "../src/sessions";
import { text } from "./helpers/hotzone-period-picker";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const OUTAGE_LINE = "Join activity is temporarily unavailable.";

const envNoDb: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path: string) => readFileSync(resolve(root, path), "utf8");

type Peak = { weekday: number; hour: number; count: number };

// peakCell is missing before the Builder lands: resolve it through the module
// namespace so the file loads and every unit case fails (not errors) with the
// same existence assertion.
const getPeakCell = (): ((cells: HeatGrid) => Peak | null) => {
  const fn = (aggregates as unknown as Record<string, unknown>).peakCell;
  expect(typeof fn, "peakCell helper exists in src/hotzones/aggregates.ts").toBe("function");
  return fn as (cells: HeatGrid) => Peak | null;
};

const gridWith = (entries: Array<[number, number, number]>): HeatGrid => {
  const cells = emptyGrid();
  for (const [dow, hr, n] of entries) cells[dow]![hr]! = n;
  return cells;
};

// Known peaks: Monday 20:00 (8 joins), Tuesday 19:00 (15 voice),
// Friday 21:00 (12 games). Sunday=0 matches WEEKDAY_NAMES/Postgres dow.
const JOINS_GRID = () =>
  gridWith([
    [1, 20, 8],
    [2, 10, 3],
  ]);
const VOICE_GRID = () =>
  gridWith([
    [2, 19, 15],
    [0, 8, 4],
  ]);
const GAMES_GRID = () =>
  gridWith([
    [5, 21, 12],
    [4, 12, 6],
  ]);

const mainOf = (html: string): string => {
  const start = html.indexOf("<main");
  const end = html.indexOf("</main>");
  if (start < 0 || end < 0) return html;
  return html.slice(start, end + "</main>".length);
};

// Inner text of every <p> in <main> mentioning peak (any case). Scoped to
// <main> so the signal meta ("activity peaks,") in <head> never matches.
const peakParasOf = (html: string): string[] => {
  const main = mainOf(html);
  const paras = [...main.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
  return paras.filter((t) => /peak/i.test(t));
};

const tablesIn = (html: string): number => html.match(/<table>/g)?.length ?? 0;

// Svelte SSR inserts comment markers between text nodes; compare paragraph
// text, not markup, so a silent-zero summary cannot hide behind those markers.
const paragraphTextsOf = (html: string): string[] =>
  [...mainOf(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) => text(match[1]!));

// Index section slice by its heading id (joins/voice/games).
const sectionOf = (html: string, headingId: string): string => {
  const head = html.indexOf(`id="${headingId}"`);
  expect(head, `section ${headingId} present`).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<section", head);
  const close = html.indexOf("</section>", head);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return html.slice(open, close + "</section>".length);
};

const honoIndex = (overrides: Record<string, unknown> = {}): string =>
  String(
    (HotzonesIndexPage as (props: unknown) => unknown)({
      appUrl: APP_URL,
      season: "all",
      joins: JOINS_GRID(),
      joinsTotal: 11,
      eventCount: 1,
      voice: VOICE_GRID(),
      games: GAMES_GRID(),
      retentionNote: null,
      ...overrides,
    } as never),
  );

const honoSignal = (
  signal: "joins" | "voice" | "games",
  overrides: Record<string, unknown> = {},
): string => {
  const cells =
    signal === "joins" ? JOINS_GRID() : signal === "voice" ? VOICE_GRID() : GAMES_GRID();
  const total = signal === "joins" ? 11 : signal === "voice" ? 19 : 18;
  return String(
    (HotzoneSignalPage as (props: unknown) => unknown)({
      appUrl: APP_URL,
      signal,
      season: "all",
      cells,
      total,
      eventCount: signal === "joins" ? 1 : undefined,
      retentionNote: null,
      ...overrides,
    } as never),
  );
};

describe("peakCell peak math", () => {
  it("returns the weekday, hour and count of the max cell", () => {
    expect(getPeakCell()(JOINS_GRID())).toEqual({ weekday: 1, hour: 20, count: 8 });
    expect(getPeakCell()(VOICE_GRID())).toEqual({ weekday: 2, hour: 19, count: 15 });
    expect(getPeakCell()(GAMES_GRID())).toEqual({ weekday: 5, hour: 21, count: 12 });
  });

  it("breaks ties by earliest weekday, then earliest hour", () => {
    // Same max on Wednesday 10:00 and Monday 20:00: Monday wins (weekday first).
    expect(
      getPeakCell()(
        gridWith([
          [3, 10, 5],
          [1, 20, 5],
        ]),
      ),
    ).toEqual({ weekday: 1, hour: 20, count: 5 });
    // Same max twice on Tuesday: 10:00 wins over 19:00 (hour second).
    expect(
      getPeakCell()(
        gridWith([
          [2, 19, 7],
          [2, 10, 7],
        ]),
      ),
    ).toEqual({ weekday: 2, hour: 10, count: 7 });
    // A later larger cell still wins over an earlier smaller one.
    expect(
      getPeakCell()(
        gridWith([
          [0, 0, 1],
          [6, 23, 9],
        ]),
      ),
    ).toEqual({
      weekday: 6,
      hour: 23,
      count: 9,
    });
  });

  it("returns null for empty and all-zero grids, with no callout data", () => {
    expect(getPeakCell()(emptyGrid())).toBeNull();
    expect(getPeakCell()(gridWith([]))).toBeNull();
    expect(
      getPeakCell()(
        gridWith([
          [0, 0, 0],
          [6, 23, 0],
        ]),
      ),
    ).toBeNull();
    // A single positive cell still peaks (zeros elsewhere are not a tie).
    expect(getPeakCell()(gridWith([[4, 3, 1]]))).toEqual({ weekday: 4, hour: 3, count: 1 });
  });
});

describe("Hono peak summary lines", () => {
  it("index renders one peak line per grid with the estimated qualifier on voice/games", () => {
    const html = honoIndex({ available: true });
    const peaks = peakParasOf(html);
    expect(peaks, "one peak line per grid").toHaveLength(3);

    const joinsSection = sectionOf(html, "hotzones-joins-heading");
    const joinsPeaks = peakParasOf(joinsSection);
    expect(joinsPeaks).toHaveLength(1);
    expect(joinsPeaks[0]).toContain("Peak:");
    expect(joinsPeaks[0]).toContain("Monday");
    expect(joinsPeaks[0]).toContain("20:00");
    expect(joinsPeaks[0]).toContain("8");
    expect(joinsPeaks[0]).not.toMatch(/estimat/i);

    for (const [headingId, weekday, hour, count] of [
      ["hotzones-voice-heading", "Tuesday", "19:00", "15"],
      ["hotzones-games-heading", "Friday", "21:00", "12"],
    ] as const) {
      const section = sectionOf(html, headingId);
      const sectionPeaks = peakParasOf(section);
      expect(sectionPeaks, `${headingId} peak`).toHaveLength(1);
      expect(sectionPeaks[0]).toContain("Estimated peak:");
      expect(sectionPeaks[0]).toContain(weekday);
      expect(sectionPeaks[0]).toContain(hour);
      expect(sectionPeaks[0]).toContain(count);
    }
  });

  it.each([
    ["joins", "Monday", "20:00", "8", false],
    ["voice", "Tuesday", "19:00", "15", true],
    ["games", "Friday", "21:00", "12", true],
  ] as const)("%s signal page renders its peak line", (signal, weekday, hour, count, estimated) => {
    const html = honoSignal(signal, { available: true });
    const peaks = peakParasOf(html);
    expect(peaks, `${signal} peak count`).toHaveLength(1);
    expect(peaks[0]).toContain(weekday);
    expect(peaks[0]).toContain(hour);
    expect(peaks[0]).toContain(count);
    if (estimated) {
      expect(peaks[0]).toContain("Estimated peak:");
    } else {
      expect(peaks[0]).toContain("Peak:");
      expect(peaks[0]).not.toMatch(/estimat/i);
    }
  });

  it("renders no peak callout when every grid is empty (positive control)", () => {
    const index = honoIndex({
      joins: emptyGrid(),
      joinsTotal: 0,
      eventCount: 0,
      voice: emptyGrid(),
      games: emptyGrid(),
      available: true,
    });
    expect(peakParasOf(index)).toHaveLength(0);
    expect(mainOf(index)).not.toMatch(/peak/i);

    const signal = honoSignal("joins", {
      cells: emptyGrid(),
      total: 0,
      eventCount: 0,
      available: true,
    });
    expect(peakParasOf(signal)).toHaveLength(0);
    expect(mainOf(signal)).not.toMatch(/peak/i);
  });
});

describe("Hono joins unavailable vs genuine-empty", () => {
  it("renders the outage line with no joins table when available is false; priors still render", () => {
    const html = honoIndex({
      joins: emptyGrid(),
      joinsTotal: 0,
      eventCount: 0,
      available: false,
    });
    expect(paragraphTextsOf(html)).toContain(
      "Aggregate activity by hour and weekday for season all.",
    );
    expect(text(mainOf(html))).not.toContain("0 joins");
    expect(html).toContain(OUTAGE_LINE);
    expect(html).toContain('role="status"');

    const joinsSection = sectionOf(html, "hotzones-joins-heading");
    expect(joinsSection).toContain(OUTAGE_LINE);
    expect(tablesIn(joinsSection), "no silent-zero joins grid").toBe(0);
    expect(peakParasOf(joinsSection)).toHaveLength(0);

    // Priors still render their tables, copy, and peaks.
    for (const headingId of ["hotzones-voice-heading", "hotzones-games-heading"] as const) {
      const section = sectionOf(html, headingId);
      expect(section).not.toContain(OUTAGE_LINE);
      expect(tablesIn(section), `${headingId} table`).toBe(1);
      expect(peakParasOf(section), `${headingId} peak`).toHaveLength(1);
      expect(peakParasOf(section)[0]).toContain("Estimated peak:");
    }
    expect(tablesIn(html), "priors only").toBe(2);
  });

  it("joins signal page renders the outage line with no grid when available is false", () => {
    const html = honoSignal("joins", {
      cells: emptyGrid(),
      total: 0,
      eventCount: 0,
      available: false,
    });
    expect(paragraphTextsOf(html)).toContain("Join activity for season all.");
    expect(text(mainOf(html))).not.toContain("0 joins");
    expect(html).toContain(OUTAGE_LINE);
    expect(html).toContain('role="status"');
    expect(tablesIn(html)).toBe(0);
    expect(peakParasOf(html)).toHaveLength(0);
  });

  it("genuine-empty keeps current copy with its table and no outage line (positive control)", () => {
    const index = honoIndex({
      joins: emptyGrid(),
      joinsTotal: 0,
      eventCount: 0,
      voice: emptyGrid(),
      games: emptyGrid(),
      available: true,
    });
    expect(index).not.toContain(OUTAGE_LINE);
    expect(index).toContain("0 joins across 0 scheduled gatherings");
    expect(tablesIn(index)).toBe(3);

    const signal = honoSignal("joins", {
      cells: emptyGrid(),
      total: 0,
      eventCount: 0,
      available: true,
    });
    expect(signal).not.toContain(OUTAGE_LINE);
    expect(signal).toContain("0 joins");
    expect(tablesIn(signal)).toBe(1);
  });
});

describe("Hono hot-zone routes without a database", () => {
  it("index says unavailable for joins only; priors still render with peaks", async () => {
    const res = await app.request("/hotzones", {}, envNoDb);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(paragraphTextsOf(html)).toContain(
      "Aggregate activity by hour and weekday for season all.",
    );
    expect(text(mainOf(html))).not.toContain("0 joins");
    expect(html).toContain(OUTAGE_LINE);
    const joinsSection = sectionOf(html, "hotzones-joins-heading");
    expect(tablesIn(joinsSection)).toBe(0);
    expect(peakParasOf(joinsSection)).toHaveLength(0);
    for (const headingId of ["hotzones-voice-heading", "hotzones-games-heading"] as const) {
      const section = sectionOf(html, headingId);
      expect(section).not.toContain(OUTAGE_LINE);
      expect(tablesIn(section)).toBe(1);
      expect(peakParasOf(section)).toHaveLength(1);
    }
  });

  it("joins signal says unavailable with no grid; voice/games signals stay available", async () => {
    const joins = await app.request("/hotzones/joins", {}, envNoDb);
    expect(joins.status).toBe(200);
    const joinsHtml = await joins.text();
    expect(paragraphTextsOf(joinsHtml)).toContain("Join activity for season all.");
    expect(text(mainOf(joinsHtml))).not.toContain("0 joins");
    expect(joinsHtml).toContain(OUTAGE_LINE);
    expect(tablesIn(joinsHtml)).toBe(0);

    for (const signal of ["voice", "games"] as const) {
      const res = await app.request(`/hotzones/${signal}`, {}, envNoDb);
      expect(res.status, signal).toBe(200);
      const html = await res.text();
      expect(html, `${signal} no outage`).not.toContain(OUTAGE_LINE);
      expect(tablesIn(html), `${signal} table`).toBe(1);
      expect(peakParasOf(html), `${signal} peak`).toHaveLength(1);
      expect(peakParasOf(html)[0]).toContain("Estimated peak:");
    }
  });
});

describe("Kit helper available + peaks", () => {
  const kitEnv = { APP_URL } as never;
  const headers = () => vi.fn((_headers: Record<string, string>) => {});

  it("index threads available=false with no joins peak when the joins read has no database", async () => {
    const loadJoinsGridFn = vi.fn(async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }));
    const data = await loadHotzonesIndexData({
      env: kitEnv,
      seasonParam: null,
      setHeaders: headers(),
      dbForFn: async () => null,
      loadJoinsGridFn,
      recordBoardViewFn: async () => {},
    });
    const shaped = data as unknown as Record<string, unknown>;
    expect(shaped.available).toBe(false);
    const peaks = shaped.peaks as Record<string, Peak | null> | undefined;
    expect(peaks, "peaks object present").toBeDefined();
    expect(peaks!.joins).toBeNull();
    expect(peaks!.voice, "voice prior still peaks").not.toBeNull();
    expect(peaks!.games, "games prior still peaks").not.toBeNull();
  });

  it("index returns the joins peak from the loaded cells with no new reads", async () => {
    const cells = JOINS_GRID();
    const loadJoinsGridFn = vi.fn(async () => ({ cells, total: 11, eventCount: 1 }));
    const data = await loadHotzonesIndexData({
      env: kitEnv,
      seasonParam: null,
      setHeaders: headers(),
      dbForFn: async () => ({}) as never,
      loadJoinsGridFn,
      recordBoardViewFn: async () => {},
    });
    const shaped = data as unknown as Record<string, unknown>;
    expect(shaped.available).toBe(true);
    expect((shaped.peaks as Record<string, Peak | null>).joins).toEqual({
      weekday: 1,
      hour: 20,
      count: 8,
    });
    expect(loadJoinsGridFn, "peaks reuse the loaded cells").toHaveBeenCalledTimes(1);
  });

  it("joins signal threads available with its peak; voice stays available without a database", async () => {
    const cells = JOINS_GRID();
    const unavailable = await loadHotzoneSignalData({
      env: kitEnv,
      seasonParam: null,
      signalParam: "joins",
      setHeaders: headers(),
      dbForFn: async () => null,
      loadJoinsGridFn: async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }),
      recordBoardViewFn: async () => {},
    });
    const unavailableShaped = unavailable as unknown as Record<string, unknown>;
    expect(unavailableShaped.available).toBe(false);
    expect(unavailableShaped.peak).toBeNull();

    const loadJoinsGridFn = vi.fn(async () => ({ cells, total: 11, eventCount: 1 }));
    const available = await loadHotzoneSignalData({
      env: kitEnv,
      seasonParam: null,
      signalParam: "joins",
      setHeaders: headers(),
      dbForFn: async () => ({}) as never,
      loadJoinsGridFn,
      recordBoardViewFn: async () => {},
    });
    const availableShaped = available as unknown as Record<string, unknown>;
    expect(availableShaped.available).toBe(true);
    expect(availableShaped.peak).toEqual({ weekday: 1, hour: 20, count: 8 });
    expect(loadJoinsGridFn).toHaveBeenCalledTimes(1);

    const voice = await loadHotzoneSignalData({
      env: kitEnv,
      seasonParam: null,
      signalParam: "voice",
      setHeaders: headers(),
      dbForFn: async () => null,
      loadJoinsGridFn: async () => {
        throw new Error("voice never reads the joins aggregate");
      },
      recordBoardViewFn: async () => {},
    });
    const voiceShaped = voice as unknown as Record<string, unknown>;
    expect(voiceShaped.available).toBe(true);
    expect(voiceShaped.peak, "voice prior peaks without a database").not.toBeNull();
  });
});

// Kit Svelte SSR, mirroring test/kit-hotzones-header-render.test.mjs: bundle the
// two shells with esbuild + svelte/compiler and render with fixture data. New
// props below (`available`, `joinsPeak`/`voicePeak`/`gamesPeak`, `peak`) are
// required Svelte inputs in the build contract; the current shells ignore them,
// so every peak/outage case fails until the Builder lands.
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};
let renderKit: (signal: string | null, data: Record<string, unknown>) => string;
type KitIndexData = Awaited<ReturnType<typeof loadHotzonesIndexData>>;
type KitSignalData = Awaited<ReturnType<typeof loadHotzoneSignalData>>;
type KitEvent = {
  url: URL;
  params: { signal: string };
  setHeaders: (headers: Record<string, string>) => void;
};
let bindings: {
  loadIndex: (event: KitEvent) => Promise<Record<string, unknown>>;
  loadSignal: (event: KitEvent) => Promise<Record<string, unknown>>;
  setIndexData: (data: KitIndexData) => void;
  setSignalData: (data: KitSignalData) => void;
};

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Index from "./web/src/routes/hotzones/+page.svelte";
        import Signal from "./web/src/routes/hotzones/[signal]/+page.svelte";
        export { load as loadIndex } from "./web/src/routes/hotzones/+page.server.ts";
        export { load as loadSignal } from "./web/src/routes/hotzones/[signal]/+page.server.ts";
        export { setIndexData, setSignalData } from "./src/kit-hotzones";
        export function renderKit(signal, data) {
          return render(signal ? Signal : Index, { props: { data } }).body;
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    banner: {
      js: `import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(${JSON.stringify(join(root, "package.json"))});`,
    },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "kit-hotzones-peak-ssr",
        setup(plugin) {
          // Keep both load functions and grid rendering real. Replace only the
          // platform/database and helper boundary to isolate binding mappings.
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "peak-binding",
          }));
          plugin.onResolve({ filter: /\/src\/admin\/db$/ }, () => ({
            path: "db",
            namespace: "peak-binding",
          }));
          plugin.onResolve({ filter: /\/src\/kit-hotzones$/ }, () => ({
            path: "helper",
            namespace: "peak-binding",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "peak-binding" }, ({ path }) => ({
            contents:
              path === "workers"
                ? `export const env = { APP_URL: ${JSON.stringify(APP_URL)} };`
                : path === "db"
                  ? `export function dbFor() { throw new Error("unexpected direct database read"); }`
                  : `
                    let indexData, signalData;
                    export const setIndexData = (data) => { indexData = data; };
                    export const setSignalData = (data) => { signalData = data; };
                    export const loadHotzonesIndexData = async () => indexData;
                    export const loadHotzoneSignalData = async () => signalData;
                  `,
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  ({ renderKit } = compiled);
  bindings = compiled;
});

const kitIndexFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const joins = (overrides.joinsCells as HeatGrid | undefined) ?? JOINS_GRID();
  const voice = (overrides.voiceCells as HeatGrid | undefined) ?? VOICE_GRID();
  const games = (overrides.gamesCells as HeatGrid | undefined) ?? GAMES_GRID();
  return {
    appUrl: APP_URL,
    season: "all",
    joinsHtml: renderHotzoneGrid(joins, "Join activity for season all"),
    joinsTotal: 11,
    eventCount: 1,
    voiceHtml: renderHotzoneGrid(voice, "Estimated voice activity for season all"),
    gamesHtml: renderHotzoneGrid(games, "Estimated games activity for season all"),
    retentionNote: null,
    available: true,
    joinsPeak: { weekday: 1, hour: 20, count: 8 },
    voicePeak: { weekday: 2, hour: 19, count: 15 },
    gamesPeak: { weekday: 5, hour: 21, count: 12 },
    ...overrides,
  };
};

const kitSignalFixture = (
  signal: "joins" | "voice" | "games",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const cells =
    (overrides.cells as HeatGrid | undefined) ??
    (signal === "joins" ? JOINS_GRID() : signal === "voice" ? VOICE_GRID() : GAMES_GRID());
  const peak =
    signal === "joins"
      ? { weekday: 1, hour: 20, count: 8 }
      : signal === "voice"
        ? { weekday: 2, hour: 19, count: 15 }
        : { weekday: 5, hour: 21, count: 12 };
  return {
    appUrl: APP_URL,
    signal,
    season: "all",
    gridHtml: renderHotzoneGrid(
      cells,
      signal === "joins"
        ? "Join activity for season all"
        : `Estimated ${signal} activity for season all`,
    ),
    total: signal === "joins" ? 11 : signal === "voice" ? 19 : 18,
    eventCount: signal === "joins" ? 1 : 0,
    retentionNote: null,
    estimated: signal !== "joins",
    available: true,
    peak,
    ...overrides,
  };
};

describe("Kit Svelte peak summary lines", () => {
  it("index renders one peak line per grid with the estimated qualifier on voice/games", () => {
    const html = renderKit(null, kitIndexFixture());
    expect(peakParasOf(html)).toHaveLength(3);
    const joinsSection = sectionOf(html, "hotzones-joins-heading");
    const joinsPeaks = peakParasOf(joinsSection);
    expect(joinsPeaks).toHaveLength(1);
    expect(joinsPeaks[0]).toContain("Peak:");
    expect(joinsPeaks[0]).toContain("Monday");
    expect(joinsPeaks[0]).toContain("20:00");
    expect(joinsPeaks[0]).toContain("8");
    expect(joinsPeaks[0]).not.toMatch(/estimat/i);
    for (const [headingId, weekday, hour, count] of [
      ["hotzones-voice-heading", "Tuesday", "19:00", "15"],
      ["hotzones-games-heading", "Friday", "21:00", "12"],
    ] as const) {
      const section = sectionOf(html, headingId);
      const sectionPeaks = peakParasOf(section);
      expect(sectionPeaks, `${headingId} peak`).toHaveLength(1);
      expect(sectionPeaks[0]).toContain("Estimated peak:");
      expect(sectionPeaks[0]).toContain(weekday);
      expect(sectionPeaks[0]).toContain(hour);
      expect(sectionPeaks[0]).toContain(count);
    }
  });

  it.each([
    ["joins", "Monday", "20:00", "8", false],
    ["voice", "Tuesday", "19:00", "15", true],
    ["games", "Friday", "21:00", "12", true],
  ] as const)("%s signal renders its peak line", (signal, weekday, hour, count, estimated) => {
    const html = renderKit(signal, kitSignalFixture(signal));
    const peaks = peakParasOf(html);
    expect(peaks, `${signal} peak count`).toHaveLength(1);
    expect(peaks[0]).toContain(weekday);
    expect(peaks[0]).toContain(hour);
    expect(peaks[0]).toContain(count);
    if (estimated) {
      expect(peaks[0]).toContain("Estimated peak:");
    } else {
      expect(peaks[0]).toContain("Peak:");
      expect(peaks[0]).not.toMatch(/estimat/i);
    }
  });

  it("renders no peak callout when every peak is null (positive control)", () => {
    const html = renderKit(
      null,
      kitIndexFixture({ joinsPeak: null, voicePeak: null, gamesPeak: null }),
    );
    expect(peakParasOf(html)).toHaveLength(0);
    expect(mainOf(html)).not.toMatch(/peak/i);
  });
});

describe("Kit Svelte joins unavailable vs genuine-empty", () => {
  it("renders the outage line with no joins grid when available is false; priors still render", () => {
    const html = renderKit(
      null,
      kitIndexFixture({
        joinsCells: emptyGrid(),
        joinsTotal: 0,
        eventCount: 0,
        available: false,
        joinsPeak: null,
      }),
    );
    expect(paragraphTextsOf(html)).toContain(
      "Aggregate activity by hour and weekday for season all.",
    );
    expect(text(mainOf(html))).not.toContain("0 joins");
    expect(html).toContain(OUTAGE_LINE);
    const joinsSection = sectionOf(html, "hotzones-joins-heading");
    expect(joinsSection).toContain(OUTAGE_LINE);
    expect(tablesIn(joinsSection)).toBe(0);
    expect(peakParasOf(joinsSection)).toHaveLength(0);
    for (const headingId of ["hotzones-voice-heading", "hotzones-games-heading"] as const) {
      const section = sectionOf(html, headingId);
      expect(section).not.toContain(OUTAGE_LINE);
      expect(tablesIn(section)).toBe(1);
      expect(peakParasOf(section)).toHaveLength(1);
    }
  });

  it("joins signal renders the outage line with no grid when available is false", () => {
    const html = renderKit(
      "joins",
      kitSignalFixture("joins", {
        cells: emptyGrid(),
        total: 0,
        eventCount: 0,
        available: false,
        peak: null,
      }),
    );
    expect(paragraphTextsOf(html)).toContain("Join activity for season all.");
    expect(text(mainOf(html))).not.toContain("0 joins");
    expect(html).toContain(OUTAGE_LINE);
    expect(tablesIn(html)).toBe(0);
    expect(peakParasOf(html)).toHaveLength(0);
  });

  it("genuine-empty keeps current copy with its table and no outage line (positive control)", () => {
    const html = renderKit(
      null,
      kitIndexFixture({
        joinsCells: emptyGrid(),
        joinsTotal: 0,
        eventCount: 0,
        available: true,
        joinsPeak: null,
        voicePeak: null,
        gamesPeak: null,
      }),
    );
    expect(html).not.toContain(OUTAGE_LINE);
    expect(html).toContain("0 joins across 0 scheduled gatherings");
    expect(tablesIn(html)).toBe(3);

    const signal = renderKit(
      "joins",
      kitSignalFixture("joins", {
        cells: emptyGrid(),
        total: 0,
        eventCount: 0,
        available: true,
        peak: null,
      }),
    );
    expect(paragraphTextsOf(signal)).toContain(
      "Join activity for season all: 0 joins across 0 scheduled gatherings.",
    );
    expect(signal).not.toContain(OUTAGE_LINE);
    expect(tablesIn(signal)).toBe(1);
    expect(peakParasOf(signal)).toHaveLength(0);
  });
});

const bindingEvent = (signal = "joins"): KitEvent => ({
  url: new URL(`${APP_URL}/hotzones/${signal}?season=all`),
  params: { signal },
  setHeaders: () => {},
});

describe("Kit executed peak bindings", () => {
  const joinsPeak = { weekday: 1, hour: 20, count: 8 };
  const voicePeak = { weekday: 2, hour: 19, count: 15 };
  const gamesPeak = { weekday: 5, hour: 21, count: 12 };

  it.each([
    ["distinct peaks", true, joinsPeak, voicePeak, gamesPeak],
    ["unavailable joins with priors", false, null, voicePeak, gamesPeak],
    ["genuine-empty null peaks", true, null, null, null],
    ["null voice only", true, joinsPeak, null, gamesPeak],
    ["null games only", true, joinsPeak, voicePeak, null],
  ] as const)(
    "index forwards availability and each signal's own peak: %s",
    async (_label, available, joins, voice, games) => {
      bindings.setIndexData({
        season: "all",
        joins: { cells: JOINS_GRID(), total: 11, eventCount: 1 },
        voice: { cells: VOICE_GRID(), total: 19 },
        games: { cells: GAMES_GRID(), total: 18 },
        retentionNote: null,
        appUrl: APP_URL,
        available,
        peaks: { joins, voice, games },
      });
      const data = await bindings.loadIndex(bindingEvent());
      expect({
        available: data.available,
        joinsPeak: data.joinsPeak,
        voicePeak: data.voicePeak,
        gamesPeak: data.gamesPeak,
      }).toEqual({ available, joinsPeak: joins, voicePeak: voice, gamesPeak: games });
    },
  );

  it.each([
    ["joins", "non-null peak", true, joinsPeak],
    ["voice", "non-null peak", true, voicePeak],
    ["games", "non-null peak", true, gamesPeak],
    ["joins", "genuine-empty null peak", true, null],
    ["voice", "null peak", true, null],
    ["games", "null peak", true, null],
    ["joins", "unavailable null peak", false, null],
  ] as const)(
    "%s signal forwards availability and peak: %s",
    async (signal, _label, available, peak) => {
      bindings.setSignalData({
        signal,
        season: "all",
        cells: signal === "joins" ? JOINS_GRID() : signal === "voice" ? VOICE_GRID() : GAMES_GRID(),
        total: signal === "joins" ? 11 : signal === "voice" ? 19 : 18,
        eventCount: signal === "joins" ? 1 : 0,
        retentionNote: null,
        estimated: signal !== "joins",
        appUrl: APP_URL,
        available,
        peak,
      });
      const data = await bindings.loadSignal(bindingEvent(signal));
      expect({ available: data.available, peak: data.peak }).toEqual({ available, peak });
    },
  );
});

describe("peak + available wiring pins", () => {
  it("Hono routes thread available into both pages", () => {
    expect(src("src/hotzones/routes.tsx")).toContain("available=");
  });

  it("Hono pages render peak lines and the joins outage line", () => {
    const pages = src("src/hotzones/pages.tsx");
    expect(pages).toMatch(/peak:/i);
    expect(pages).toContain(OUTAGE_LINE);
    expect(pages).toContain("peakCell");
  });

  it("Kit helper returns available + peaks computed with peakCell", () => {
    const helper = src("src/kit-hotzones.ts");
    expect(helper).toMatch(/available\s*:/);
    expect(helper).toContain("peakCell");
  });

  it.each([
    "web/src/routes/hotzones/+page.server.ts",
    "web/src/routes/hotzones/[signal]/+page.server.ts",
  ])("%s passes available + peaks through", (path) => {
    expect(existsSync(resolve(root, path))).toBe(true);
    const server = src(path);
    expect(server, `${path} available`).toMatch(/available\s*:/);
    expect(server, `${path} peaks`).toMatch(/peak/i);
  });

  it.each([
    "web/src/routes/hotzones/+page.svelte",
    "web/src/routes/hotzones/[signal]/+page.svelte",
  ])("%s renders peak lines and the joins outage line", (path) => {
    const svelte = src(path);
    expect(svelte, `${path} peaks`).toMatch(/peak:/i);
    expect(svelte, `${path} outage`).toContain(OUTAGE_LINE);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Hono genuine-empty with a live database", () => {
  let fixture: MemberDataFixture;
  let live: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const store = createMemorySessionStore();
    live = {
      ...envNoDb,
      get ADMIN_DB() {
        return fixture.db;
      },
      SESSION_STORE: store,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("empty tables keep current copy with tables and no outage line (positive control)", async () => {
    await fixture.reset();
    const index = await app.request("/hotzones", {}, live);
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).not.toContain(OUTAGE_LINE);
    expect(indexHtml).toContain("0 joins across 0 scheduled gatherings");
    expect(tablesIn(indexHtml)).toBe(3);
    expect(peakParasOf(sectionOf(indexHtml, "hotzones-joins-heading"))).toHaveLength(0);

    const signal = await app.request("/hotzones/joins", {}, live);
    expect(signal.status).toBe(200);
    const signalHtml = await signal.text();
    expect(signalHtml).not.toContain(OUTAGE_LINE);
    expect(signalHtml).toContain("0 joins");
    expect(tablesIn(signalHtml)).toBe(1);
    expect(peakParasOf(signalHtml)).toHaveLength(0);
  });
});
