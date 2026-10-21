// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only): selected seasons survive navigation, and
// voice/games grids are labeled as the season-independent seeded estimates
// they are.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// - Links: every existing index nav, section-heading, signal-switch and back
//   link carries the selected `?season=` on Hono and Kit; absent/all stays
//   canonical with no query outside the picker. The native period-picker form
//   and its This month / This quarter shortcut anchors are exempt from the
//   page-wide and every-href scans: those scans run on markup outside the
//   `#hotzone-period-heading` picker section (reconciled 2026-10-21; every
//   nav/heading/switch/back pin stays semantically intact).
// - Honesty: voice/games descriptions and grid captions name season-independent
//   seeded estimates (estimate + season-independent + seeded); joins labels
//   keep `for season <label>`. The deterministic prior cells and totals do
//   not move.
// - Windows: pure date coverage lives in test/hotzone-season-window.test.ts.
// - No aggregation, opt-out, throttle, telemetry, privacy or cache changes.
//
// Intentional contract replacement: test/hotzones-grid-scroll-region.test.ts
// pins the misleading `Estimated {voice,games} activity for season all`
// captions. The Builder updates those two caption strings to the honest
// wording (keeping the scroll-region structure and the joins captions);
// this file is the new caption contract.
//
// How this fails before the Builder lands: every selected-season link case
// fails (hrefs are bare `/hotzones/<signal>`), every voice/games honesty
// case fails (captions say `for season <label>`, descriptions lack
// season-independent/seeded), and the Kit loader source still carries the
// misleading caption templates. Absent/all canonical cases, joins labels,
// prior snapshots, cache headers and grammar controls stay green.
// Hermetic doubles only: no live DB, no network.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { emptyGrid, priorGrid } from "../src/hotzones/aggregates";
import { renderHotzoneGrid } from "../src/hotzones/pages";
import { registerHotzoneRoutes } from "../src/hotzones/routes";
import { loadHotzonesIndexData } from "../src/kit-hotzones";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const APP_URL = "https://next.example.test";
const IP = "192.0.2.24";
const SIGNALS = ["joins", "voice", "games"] as const;
const SEASONS = ["2026", "2026-09", "2026-Q3", "0099"] as const;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, opts: Record<string, unknown>) => { js: { code: string } };
};
type RenderKit = (signal: string | null, data: Record<string, unknown>) => string;
let renderKit: RenderKit;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Index from "./web/src/routes/hotzones/+page.svelte";
        import Signal from "./web/src/routes/hotzones/[signal]/+page.svelte";
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
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "kit-season-continuity-ssr",
        setup(plugin) {
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
  ({ renderKit } = (await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  )) as { renderKit: RenderKit });
});

// Null-DB Hono fixture: joins grids render empty, priors render seeded, no
// board-view writes (routes guard on db), throttle double admits one read.
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
  const app = new Hono<{ Bindings: Env }>();
  registerHotzoneRoutes(app);
  const env = {
    APP_URL,
    THROTTLE_STORE: async () => sql as unknown as Sql,
    get ADMIN_DB() {
      return null;
    },
  } as unknown as EnvWithThrottle;
  const request = (path: string) => app.request(path, { headers: { "cf-connecting-ip": IP } }, env);
  return { request };
}

const hotzoneHrefs = (html: string) =>
  [...html.matchAll(/href="(\/hotzones[^"]*)"/g)].map((m) => m[1]!);

// The native period picker (GET form + server-derived This month / This
// quarter shortcuts) lives in its own labelled section; its shortcut anchors
// necessarily carry `?season=` state that differs from the committed season.
// Continuity pins the existing nav, heading, switch and back links outside
// that section, so every scan below runs on picker-stripped markup.
const stripPeriodPicker = (html: string) =>
  html.replace(
    /<section\b[^>]*aria-labelledby="hotzone-period-heading"[^>]*>[\s\S]*?<\/section>/g,
    "",
  );

const continuityHrefs = (html: string) => hotzoneHrefs(stripPeriodPicker(html));

const captions = (html: string) =>
  [...html.matchAll(/<caption>([^<]+)<\/caption>/g)].map((m) => m[1]!);

const paragraphs = (html: string) => [...html.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => m[1]!);

const gridCells = (html: string) => [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => m[1]!);

// Honest estimate copy names all three: estimate, season-independent, seeded.
// It never claims `for season <label>` the way the joins labels do.
function expectHonestEstimate(copy: string, label: string) {
  expect(copy, `${label} names estimates`).toMatch(/estimat/i);
  expect(copy, `${label} names season-independence`).toMatch(/season-independent/i);
  expect(copy, `${label} names seeded priors`).toMatch(/seed/i);
  expect(copy, `${label} never claims a season`).not.toContain("for season");
}

function kitFixture(signal: string | null, season: string) {
  const cells = emptyGrid();
  const gridHtml = renderHotzoneGrid(cells, `Activity for season ${season}`);
  return {
    appUrl: APP_URL,
    season,
    signal,
    joins: cells,
    voice: cells,
    games: cells,
    cells,
    total: 0,
    joinsTotal: 0,
    eventCount: 0,
    retentionNote: null,
    estimated: signal !== null && signal !== "joins",
    gridHtml,
    joinsHtml: gridHtml,
    voiceHtml: gridHtml,
    gamesHtml: gridHtml,
  };
}

describe("hot-zone season continuity (Hono index links)", () => {
  it.each([...SEASONS])("index keeps ?season=%s on nav and heading links", async (season) => {
    const { request } = fixture();
    const res = await request(`/hotzones?season=${season}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const signal of SIGNALS) {
      const href = `/hotzones/${signal}?season=${season}`;
      // Nav link plus section-heading link: the seasoned href appears twice.
      expect(html.split(`href="${href}"`).length - 1, href).toBe(2);
    }
    for (const href of continuityHrefs(html)) {
      expect(href, `index link ${href}`).toContain(`season=${season}`);
    }
  });

  it("index stays canonical with no query when season is absent", async () => {
    const { request } = fixture();
    const html = await (await request("/hotzones")).text();
    for (const signal of SIGNALS) expect(html).toContain(`href="/hotzones/${signal}"`);
    expect(stripPeriodPicker(html)).not.toContain("?season=");
    expect(continuityHrefs(html)).not.toHaveLength(0);
  });

  it("index stays canonical with no ?season=all when season is all", async () => {
    const { request } = fixture();
    const html = await (await request("/hotzones?season=all")).text();
    for (const signal of SIGNALS) expect(html).toContain(`href="/hotzones/${signal}"`);
    expect(stripPeriodPicker(html)).not.toContain("?season=");
  });
});

describe("hot-zone season continuity (Hono signal links)", () => {
  const cases = SIGNALS.flatMap((signal) => SEASONS.map((season) => ({ signal, season })));

  it.each(cases)(
    "…/$signal keeps ?season=$season on back and switch links",
    async ({ signal, season }) => {
      const { request } = fixture();
      const res = await request(`/hotzones/${signal}?season=${season}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`href="/hotzones?season=${season}"`);
      for (const other of SIGNALS) {
        expect(html).toContain(`href="/hotzones/${other}?season=${season}"`);
      }
      for (const href of continuityHrefs(html)) {
        expect(href, `${signal} link ${href}`).toContain(`season=${season}`);
      }
    },
  );

  it.each([...SIGNALS])(
    "…/%s stays canonical with no query when season is absent",
    async (signal) => {
      const { request } = fixture();
      const html = await (await request(`/hotzones/${signal}`)).text();
      expect(html).toContain('href="/hotzones"');
      expect(stripPeriodPicker(html)).not.toContain("?season=");
    },
  );

  it.each([...SIGNALS])(
    "…/%s stays canonical with no ?season=all when season is all",
    async (signal) => {
      const { request } = fixture();
      const html = await (await request(`/hotzones/${signal}?season=all`)).text();
      expect(html).toContain('href="/hotzones"');
      expect(stripPeriodPicker(html)).not.toContain("?season=");
    },
  );
});

describe("hot-zone season continuity (Kit index + signal links)", () => {
  it.each([...SEASONS])("Kit index keeps ?season=%s on nav and heading links", (season) => {
    const html = renderKit(null, kitFixture(null, season));
    for (const signal of SIGNALS) {
      const href = `/hotzones/${signal}?season=${season}`;
      expect(html.split(`href="${href}"`).length - 1, href).toBe(2);
    }
    for (const href of continuityHrefs(html)) {
      expect(href, `Kit index link ${href}`).toContain(`season=${season}`);
    }
  });

  it("Kit index stays canonical with no query when season is absent or all", () => {
    for (const season of ["all"] as const) {
      const html = renderKit(null, kitFixture(null, season));
      for (const signal of SIGNALS) expect(html).toContain(`href="/hotzones/${signal}"`);
      expect(stripPeriodPicker(html)).not.toContain("?season=");
    }
  });

  const cases = SIGNALS.flatMap((signal) => SEASONS.map((season) => ({ signal, season })));

  it.each(cases)(
    "Kit …/$signal keeps ?season=$season on back and switch links",
    ({ signal, season }) => {
      const html = renderKit(signal, kitFixture(signal, season));
      expect(html).toContain(`href="/hotzones?season=${season}"`);
      for (const other of SIGNALS) {
        expect(html).toContain(`href="/hotzones/${other}?season=${season}"`);
      }
      for (const href of continuityHrefs(html)) {
        expect(href, `Kit ${signal} link ${href}`).toContain(`season=${season}`);
      }
    },
  );

  it.each([...SIGNALS])("Kit …/%s stays canonical with no query when season is all", (signal) => {
    const html = renderKit(signal, kitFixture(signal, "all"));
    expect(html).toContain('href="/hotzones"');
    expect(stripPeriodPicker(html)).not.toContain("?season=");
  });
});

describe("hot-zone honest estimates (Hono captions + descriptions)", () => {
  it.each([...SEASONS])(
    "index labels joins for season %s and priors as season-independent",
    async (season) => {
      const { request } = fixture();
      const html = await (await request(`/hotzones?season=${season}`)).text();
      const [joins, voice, games] = captions(html);
      expect(joins, "joins caption").toContain(`for season ${season}`);
      expectHonestEstimate(voice!, `voice caption ${season}`);
      expectHonestEstimate(games!, `games caption ${season}`);
      const voicePara = paragraphs(html).find((p) => /voice/i.test(p));
      const gamesPara = paragraphs(html).find((p) => /games/i.test(p));
      expectHonestEstimate(voicePara!, `voice description ${season}`);
      expectHonestEstimate(gamesPara!, `games description ${season}`);
    },
  );

  it("index keeps honest priors even for season all", async () => {
    const { request } = fixture();
    const html = await (await request("/hotzones")).text();
    const [, voice, games] = captions(html);
    expectHonestEstimate(voice!, "voice caption all");
    expectHonestEstimate(games!, "games caption all");
  });

  it.each([...SEASONS])("joins signal keeps its selected-season label for %s", async (season) => {
    const { request } = fixture();
    const html = await (await request(`/hotzones/joins?season=${season}`)).text();
    expect(captions(html)[0], "joins caption").toContain(`for season ${season}`);
    expect(html).toContain(`Join activity for season ${season}`);
  });

  it.each(["voice", "games"] as const)(
    "%s signal labels its prior season-independent",
    async (signal) => {
      const { request } = fixture();
      for (const season of SEASONS) {
        const html = await (await request(`/hotzones/${signal}?season=${season}`)).text();
        expectHonestEstimate(captions(html)[0]!, `${signal} caption ${season}`);
        const description = paragraphs(html).find((p) => new RegExp(signal, "i").test(p));
        expectHonestEstimate(description!, `${signal} description ${season}`);
      }
    },
  );
});

describe("hot-zone honest estimates (Kit render + loader)", () => {
  it.each([...SEASONS])("Kit index describes priors as season-independent for %s", (season) => {
    const html = renderKit(null, kitFixture(null, season));
    const voicePara = paragraphs(html).find((p) => /voice/i.test(p));
    const gamesPara = paragraphs(html).find((p) => /games/i.test(p));
    expectHonestEstimate(voicePara!, `Kit voice description ${season}`);
    expectHonestEstimate(gamesPara!, `Kit games description ${season}`);
    // Joins intro keeps its selected-season label.
    expect(html).toContain(`for season ${season}`);
  });

  it.each(["voice", "games"] as const)(
    "Kit %s signal describes its prior season-independent",
    (signal) => {
      for (const season of SEASONS) {
        const html = renderKit(signal, kitFixture(signal, season));
        const description = paragraphs(html).find((p) => new RegExp(signal, "i").test(p));
        expectHonestEstimate(description!, `Kit ${signal} description ${season}`);
      }
    },
  );

  it("Kit joins signal keeps its selected-season label", () => {
    const html = renderKit("joins", kitFixture("joins", "2026-09"));
    expect(html).toContain("Join activity for season 2026-09");
  });

  it("Kit index loader captions priors as season-independent seeded estimates", () => {
    const source = readFileSync(resolve(root, "web/src/routes/hotzones/+page.server.ts"), "utf8");
    expect(source).toContain("Join activity for season");
    expect(source).not.toContain("Estimated voice activity for season");
    expect(source).not.toContain("Estimated games activity for season");
    expect(source).toMatch(/season-independent/i);
    expect(source).toMatch(/seed/i);
  });

  it("Kit signal loader captions priors as season-independent seeded estimates", () => {
    const source = readFileSync(
      resolve(root, "web/src/routes/hotzones/[signal]/+page.server.ts"),
      "utf8",
    );
    expect(source).toContain("Join activity for season");
    expect(source).not.toContain("Estimated ${data.signal} activity for season");
    expect(source).toMatch(/season-independent/i);
    expect(source).toMatch(/seed/i);
  });
});

describe("hot-zone priors (deterministic cells + totals unchanged)", () => {
  const VOICE_TOTAL = 702;
  const GAMES_TOTAL = 697;
  const VOICE_ROW0 = [3, 4, 3, 4, 3, 3, 4, 3, 3, 3, 4, 3, 4, 3, 3, 4, 4, 5, 5, 7, 6, 7, 7, 5];
  const VOICE_ROW3 = [3, 3, 4, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 5, 5, 6, 7, 7, 7, 7, 5];
  const VOICE_ROW6 = [3, 3, 3, 4, 3, 3, 3, 3, 4, 3, 3, 3, 3, 4, 4, 4, 4, 5, 6, 7, 6, 7, 6, 5];
  const GAMES_ROW0 = [3, 3, 4, 3, 3, 3, 3, 3, 4, 3, 3, 4, 4, 3, 4, 4, 5, 6, 6, 6, 6, 6, 6, 6];
  const GAMES_ROW3 = [3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 7, 7, 5, 5];
  const GAMES_ROW6 = [3, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 4, 4, 5, 5, 6, 6, 7, 6, 6, 5];

  it("keeps the voice/games totals and sampled cells byte-equal", () => {
    const voice = priorGrid("voice");
    const games = priorGrid("games");
    expect(voice.total).toBe(VOICE_TOTAL);
    expect(games.total).toBe(GAMES_TOTAL);
    expect(voice.cells).toHaveLength(7);
    expect(games.cells).toHaveLength(7);
    for (const row of [...voice.cells, ...games.cells]) {
      expect(row).toHaveLength(24);
      for (const cell of row!) expect(cell).toBeGreaterThanOrEqual(1);
    }
    expect(voice.cells[0]).toEqual(VOICE_ROW0);
    expect(voice.cells[3]).toEqual(VOICE_ROW3);
    expect(voice.cells[6]).toEqual(VOICE_ROW6);
    expect(games.cells[0]).toEqual(GAMES_ROW0);
    expect(games.cells[3]).toEqual(GAMES_ROW3);
    expect(games.cells[6]).toEqual(GAMES_ROW6);
  });

  it("stays deterministic across calls", () => {
    expect(priorGrid("voice")).toEqual(priorGrid("voice"));
    expect(priorGrid("games")).toEqual(priorGrid("games"));
  });

  it.each(["voice", "games"] as const)(
    "renders identical %s cells across seasons",
    async (signal) => {
      const { request } = fixture();
      const sept = gridCells(await (await request(`/hotzones/${signal}?season=2026-09`)).text());
      const jan = gridCells(await (await request(`/hotzones/${signal}?season=2025-01`)).text());
      expect(sept.length).toBe(168);
      expect(sept).toEqual(jan);
    },
  );
});

describe("hot-zone continuity controls (cache, grammar, privacy)", () => {
  it.each(["all", "2026", "2026-09", "2026-Q3", "0099"])(
    "still renders ?season=%s as a cached 200 board",
    async (season) => {
      const { request } = fixture();
      const res = await request(`/hotzones?season=${season}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<table");
    },
  );

  it("keeps Kit loads serving a selected season with the public cache policy", async () => {
    const setHeaders = vi.fn();
    const data = await loadHotzonesIndexData({
      env: { APP_URL } as never,
      seasonParam: "2026-09",
      setHeaders,
      dbForFn: async () => null,
      loadJoinsGridFn: async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }),
      recordBoardViewFn: async () => {},
    });
    expect(data.season).toBe("2026-09");
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "public, max-age=300" });
  });

  it.each(["presence", "2026-13", "2026-Q5", ""])(
    "still rejects ?season=%j with 400",
    async (season) => {
      const { request } = fixture();
      const res = await request(`/hotzones?season=${encodeURIComponent(season)}`);
      expect(res.status).toBe(400);
    },
  );

  it("still answers an unknown signal with 404", async () => {
    const { request } = fixture();
    expect((await request("/hotzones/bogus?season=2026")).status).toBe(404);
  });

  it("keeps grids aggregate-only with no per-user strings", async () => {
    const { request } = fixture();
    for (const path of ["/hotzones?season=2026-09", "/hotzones/voice?season=2026-09"]) {
      const html = await (await request(path)).text();
      expect(html).not.toMatch(/20\d\d-\d\d-\d\dT\d\d:/);
      expect(html).not.toContain("discord_id");
      expect(html).not.toContain("created_at");
    }
  });
});
