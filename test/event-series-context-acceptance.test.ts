// route-inventory: GET /e/:key
// Acceptance: series context on event detail (S1). Paired Test-Author handoff:
// RED-first tests only, no src/ or web/ changes in this file's commit. The
// builder (paired build card) builds on this branch and never edits this file.
//
// Locked contract (builder must satisfy without editing this file):
// - Series hosts line in <dl class="event-meta">, after Hosted-by when present:
//   <div><dt>Series hosts</dt><dd><p data-testid="event-series-hosts">Jo, Riley, Sam</p></dd></div>.
//   Each distinct non-blank organizer across the published series run, current
//   host first, the rest in ascending series-index order (parent index 1, first
//   child 2, ...). Duplicates collapsed. Null/blank organizers omitted; when no
//   published sibling (including current) has a non-blank organizer, the hosts
//   line is omitted but prev/next still render.
// - Series navigation in <div class="event-discovery">, alongside (never instead
//   of) the existing global event-pagination:
//   <nav aria-label="Series events" data-testid="event-series-nav"> with
//   <a href="/e/<prevKey>" rel="prev" data-testid="event-series-previous">← Previous in series: {title}</a>
//   and <a href="/e/<nextKey>" rel="next" data-testid="event-series-next">Next in series: {title} →</a>.
//   Previous/next are the adjacent published siblings by recurrenceIndex (past
//   rows are not excluded by status here: the fixture run is future-dated, and
//   the contract pins published-only like the neighbors read). Draft and
//   cancelled siblings are excluded from hosts and navigation entirely. First
//   published sibling omits previous, last omits next; a standalone event (no
//   published siblings) renders no series markup at all (byte-identical to today).
// - Same block, copy and testids on Hono detail and Kit detail. Kit model gains
//   `series: { hosts: string[]; previous: KitEventDetailLink | null; next: KitEventDetailLink | null } | null`
//   (null for standalone); EventDetail.svelte renders the block above from it.
//   Organizer names are escaped (no arbitrary HTML); hostile names render as text.
// - Bounded single series read: one SQL query mentioning parent_event_id per
//   detail render for series events (no per-sibling event_key lookups); at most
//   one for standalone (zero preferred, one empty read allowed). Anonymous-safe
//   (organizer names are already public on detail); private/no-store, Vary:
//   Cookie and audit behavior unchanged (guests audit nothing).
//
// Hermetic only: pg-proxy fixtures through the real Hono route, the production
// Kit store through resolveKitEventDetail, and the real Svelte SSR bundle. No
// DATABASE_URL, no network, no production/staging data.
//
// RED expectations on the base head: every test marked RED fails (missing
// series block/read); tests marked CONTROL pass before and after (regression
// pins). The suite as a whole is red until the builder lands.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  kitEventDetailStore,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const NOW = new Date("2030-01-10T20:00:00Z");
const key = (id: number) => String(id).padStart(26, "0");

type EventRow = typeof events.$inferSelect;

const HOSTILE = '<img src=x onerror="alert(1)">';

// Six-row published run plus draft/cancelled siblings: parent 10 (Riley),
// 11 (Jo), 12 (Riley again: dedupe pin), 13 (Sam), 14 (draft Drafty),
// 15 (cancelled Canny). IDs 30/31 are global (non-series) neighbors for the
// coexistence pin; 20 is standalone (Solo).
function row(id: number, over: Partial<EventRow> = {}): EventRow {
  const week = Math.max(0, id - 10);
  const startsAt = new Date(Date.UTC(2030, 0, 10 + week * 7, 20, 0, 0));
  return {
    id,
    icsSequence: 1894305600n,
    eventKey: key(id),
    title: `Game night ${id}`,
    game: "Chess",
    description: null,
    accessibilityNotes: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 3600_000),
    timezone: "Europe/London",
    location: "Voice",
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as EventRow;
}

const SERIES_ROWS: EventRow[] = [
  row(10, {
    organizer_name: "Riley",
    recurrenceFrequency: "weekly",
    recurrenceCount: 6,
    recurrenceIndex: 1,
  }),
  row(11, { organizer_name: "Jo", parentEventId: 10, recurrenceIndex: 2 }),
  row(12, { organizer_name: "Riley", parentEventId: 10, recurrenceIndex: 3 }),
  row(13, { organizer_name: "Sam", parentEventId: 10, recurrenceIndex: 4 }),
  row(14, { organizer_name: "Drafty", status: "draft", parentEventId: 10, recurrenceIndex: 5 }),
  row(15, {
    organizer_name: "Canny",
    status: "cancelled",
    parentEventId: 10,
    recurrenceIndex: 6,
  }),
];

const STANDALONE_ROW = row(20, { organizer_name: "Solo" });
const GLOBAL_PREVIOUS = row(30, { title: "Global prev" });
const GLOBAL_NEXT = row(31, { title: "Global next" });

const linkValues = (
  e: Pick<EventRow, "id" | "eventKey" | "title" | "startsAt" | "timezone" | "location">,
) => [e.id, e.eventKey, e.title, e.startsAt.toISOString(), e.timezone, e.location];

interface SeriesFixtureOpts {
  /** Current event id (10-15 series, 20 standalone). */
  currentId: number;
  /** Override organizers by id (e.g. hostile names). */
  organizers?: Record<number, string | null>;
  /** Global neighbors (default none, so only series nav renders). */
  globalNeighbors?: { previous: EventRow | null; next: EventRow | null };
}

function seriesFixture(opts: SeriesFixtureOpts) {
  const { currentId, organizers = {}, globalNeighbors = { previous: null, next: null } } = opts;
  const byId = new Map<number, EventRow>();
  for (const base of [...SERIES_ROWS, STANDALONE_ROW, GLOBAL_PREVIOUS, GLOBAL_NEXT]) {
    const over = base.id in organizers ? { organizer_name: organizers[base.id] ?? null } : {};
    byId.set(base.id, { ...base, ...over });
  }
  const current = byId.get(currentId)!;
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const toRow = (r: EventRow) =>
    columns.map((k) => (r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]));

  // A series read filters on the parent pointer; the plain event lookup only
  // selects the column (SELECT list), so the predicate requires the WHERE
  // operator, never a bare column mention.
  const isSeriesRead = (sql: string) =>
    sql.includes('"parent_event_id" =') || sql.toLowerCase().includes('"parent_event_id" in');

  const db = drizzle(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('from "rsvps"') || sql.includes("from rsvps")) return { rows: [] };
    if (sql.includes('"event_key" =')) return { rows: [toRow(current)] };
    // Future series read: full event rows for the run. Mimic correct SQL
    // filtering: when the query constrains status, honor published-only (the
    // contract); when it does not, return the whole run so a missing filter
    // (SQL or code) surfaces in the render.
    if (isSeriesRead(sql)) {
      const publishedOnly = sql.includes('"status"') || sql.includes("status");
      const siblings = SERIES_ROWS.map((s) => byId.get(s.id)!).filter(
        (s) => !publishedOnly || s.status === "published",
      );
      return { rows: siblings.map(toRow) };
    }
    // Neighbor reads carry starts_at comparisons; related carries ends_at.
    if (sql.includes('"starts_at" <') || sql.includes('"starts_at" >')) {
      const neighbor = sql.includes('"starts_at" desc')
        ? globalNeighbors.previous
        : globalNeighbors.next;
      return { rows: neighbor ? [linkValues(neighbor)] : [] };
    }
    if (sql.includes('"ends_at" >=')) return { rows: [] };
    const neighbor = sql.includes('"starts_at" desc')
      ? globalNeighbors.previous
      : globalNeighbors.next;
    return { rows: neighbor ? [linkValues(neighbor)] : [] };
  }) as unknown as Db;

  const sessions: SessionStore = createMemorySessionStore();
  const env = {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: sessions,
    ADMIN_DB: db,
  } as unknown as Env;

  return {
    db,
    env,
    queries,
    current,
    seriesQueries: () => queries.filter((q) => isSeriesRead(q.sql)),
    eventKeyQueries: () => queries.filter((q) => q.sql.includes('"event_key" =')),
    request: () => app.request(`/e/${current.eventKey}`, {}, env),
  };
}

function seriesHostsText(html: string): string {
  const match = html.match(/<p[^>]*data-testid="event-series-hosts"[^>]*>([\s\S]*?)<\/p>/);
  if (!match) throw new Error("expected the series-hosts line in the detail HTML");
  return match[1]!;
}

function seriesNavSection(html: string): string {
  const match = html.match(/<nav[^>]*data-testid="event-series-nav"[^>]*>([\s\S]*?)<\/nav>/);
  if (!match) throw new Error("expected the series nav in the detail HTML");
  return match[0];
}

describe("series context on Hono event detail (hermetic)", () => {
  it("RED: renders the series-hosts line with the current host first", async () => {
    const f = seriesFixture({ currentId: 11 });
    const response = await f.request();
    expect(response.status).toBe(200);
    const html = await response.text();
    // Hosted-by (existing) still renders the current host alone.
    expect(html).toContain('data-testid="event-organizer">Jo');
    expect(html).toContain("Series hosts");
    // Current host first, then distinct others in index order (Riley deduped).
    expect(seriesHostsText(html)).toBe("Jo, Riley, Sam");
  });

  it("RED: links series previous/next by index alongside the global rail", async () => {
    const f = seriesFixture({
      currentId: 11,
      globalNeighbors: { previous: GLOBAL_PREVIOUS, next: GLOBAL_NEXT },
    });
    const html = await (await f.request()).text();
    // Global rail untouched...
    expect(html).toContain('data-testid="event-pagination"');
    expect(html).toContain(`href="/e/${key(30)}" rel="prev" data-testid="event-previous"`);
    expect(html).toContain(`href="/e/${key(31)}" rel="next" data-testid="event-next"`);
    // ...and the series rail renders with its own testids, labels and hrefs.
    const nav = seriesNavSection(html);
    expect(nav).toContain('aria-label="Series events"');
    expect(nav).toContain(`href="/e/${key(10)}"`);
    expect(nav).toContain('data-testid="event-series-previous"');
    expect(nav).toContain("Previous in series: Game night 10");
    expect(nav).toContain(`href="/e/${key(12)}"`);
    expect(nav).toContain('data-testid="event-series-next"');
    expect(nav).toContain("Next in series: Game night 12");
  });

  it("RED: excludes draft and cancelled siblings from hosts and navigation", async () => {
    // Current index 3: next must skip draft 14/cancelled 15 and land on 13.
    const f = seriesFixture({ currentId: 12 });
    const html = await (await f.request()).text();
    const hosts = seriesHostsText(html);
    expect(hosts).toBe("Riley, Jo, Sam");
    expect(hosts).not.toContain("Drafty");
    expect(hosts).not.toContain("Canny");
    const nav = seriesNavSection(html);
    expect(nav).toContain(`href="/e/${key(11)}"`);
    expect(nav).toContain(`href="/e/${key(13)}"`);
    expect(nav).not.toContain(key(14));
    expect(nav).not.toContain(key(15));
    expect(nav).not.toContain("Drafty");
    expect(nav).not.toContain("Canny");
  });

  it.each([
    ["first", 10, "event-series-next", "event-series-previous"],
    ["last", 13, "event-series-previous", "event-series-next"],
  ])(
    "RED: omits the missing link at the %s published sibling",
    async (_pos, currentId, present, absent) => {
      const f = seriesFixture({ currentId: currentId as number });
      const html = await (await f.request()).text();
      // Block present (fails before the builder), exactly one directional link.
      const nav = seriesNavSection(html);
      expect(nav).toContain(`data-testid="${present}"`);
      expect(nav).not.toContain(`data-testid="${absent}"`);
    },
  );

  it("CONTROL: standalone events render no series markup and keep Hosted-by", async () => {
    const f = seriesFixture({ currentId: 20 });
    const response = await f.request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="event-organizer">Solo');
    expect(html).not.toContain("event-series-hosts");
    expect(html).not.toContain("event-series-nav");
    expect(html).not.toContain("event-series-previous");
    expect(html).not.toContain("event-series-next");
    expect(html).not.toContain("Series hosts");
    expect(html).not.toContain("Series events");
  });

  it("RED: escapes hostile organizer names in the series-hosts line", async () => {
    const f = seriesFixture({
      currentId: 11,
      organizers: { 11: HOSTILE, 10: "Riley", 12: "Riley", 13: "Sam" },
    });
    const html = await (await f.request()).text();
    // Existing Hosted-by escaping (control pin, passes today).
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    // Series-hosts line escapes the same hostile current host first.
    const hosts = seriesHostsText(html);
    expect(hosts).toContain("&lt;img");
    expect(hosts).not.toContain("<img src=x");
    expect(hosts.startsWith("&lt;img")).toBe(true);
  });

  it("RED: issues a single bounded series read, never per-sibling lookups", async () => {
    const f = seriesFixture({ currentId: 11 });
    const response = await f.request();
    expect(response.status).toBe(200);
    // Exactly one series read for the six-row run...
    expect(f.seriesQueries()).toHaveLength(1);
    // ...and no per-sibling event_key lookups beyond the initial page read.
    expect(f.eventKeyQueries()).toHaveLength(1);
  });

  it("CONTROL: keeps private/no-store, Vary and guest audit silence on series pages", async () => {
    const f = seriesFixture({ currentId: 11 });
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(f.queries.filter((q) => q.sql.includes("member_data_access_logs"))).toHaveLength(0);
  });
});

// Kit resolver parity: the production store through resolveKitEventDetail.
// Model shape contract: `series` is null for standalone, else
// { hosts: string[]; previous: KitEventDetailLink | null; next: ... }.
const GUEST: KitRequestSession = { status: "guest", session: null };
const kitEnv = { APP_URL } as unknown as Env;

async function resolveSeries(currentId: number, organizers: Record<number, string | null> = {}) {
  const f = seriesFixture({ currentId, organizers });
  const store: KitEventDetailStore = {
    ...kitEventDetailStore(kitEnv),
    dbForFn: async () => f.db,
  };
  const outcome = await resolveKitEventDetail({
    key: f.current.eventKey,
    search: "",
    path: `/e/${f.current.eventKey}`,
    env: kitEnv,
    session: GUEST,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return { model: outcome.model as unknown as Record<string, unknown>, fixture: f };
}

type SeriesLink = { key: string; title: string };
type SeriesModel = { hosts: string[]; previous: SeriesLink | null; next: SeriesLink | null };

function asSeries(model: Record<string, unknown>): SeriesModel {
  const series = model.series as SeriesModel | null | undefined;
  if (!series) throw new Error("expected model.series in the Kit detail model");
  return series;
}

describe("series context in the Kit detail model (hermetic)", () => {
  it("RED: carries hosts (current first) plus index neighbors in one read", async () => {
    const { model, fixture } = await resolveSeries(11);
    const series = asSeries(model);
    expect(series.hosts).toEqual(["Jo", "Riley", "Sam"]);
    expect(series.previous).toMatchObject({ key: key(10), title: "Game night 10" });
    expect(series.next).toMatchObject({ key: key(12), title: "Game night 12" });
    expect(fixture.seriesQueries()).toHaveLength(1);
    expect(fixture.eventKeyQueries()).toHaveLength(1);
  });

  it("RED: excludes draft/cancelled siblings from the Kit model", async () => {
    const { model } = await resolveSeries(12);
    const series = asSeries(model);
    expect(series.hosts).toEqual(["Riley", "Jo", "Sam"]);
    expect(series.previous).toMatchObject({ key: key(11) });
    // Skips draft 14 and cancelled 15.
    expect(series.next).toMatchObject({ key: key(13), title: "Game night 13" });
  });

  it.each([
    ["first", 10, null, key(11)],
    ["last", 13, key(12), null],
  ])(
    "RED: omits the missing Kit link at the %s published sibling",
    async (_pos, currentId, prevKey, nextKey) => {
      const { model } = await resolveSeries(currentId as number);
      const series = asSeries(model);
      expect(series.previous?.key ?? null).toBe(prevKey);
      expect(series.next?.key ?? null).toBe(nextKey);
    },
  );

  it("CONTROL: leaves model.series null for standalone events", async () => {
    const { model } = await resolveSeries(20);
    expect((model as Record<string, unknown>).series ?? null).toBeNull();
  });
});

// Kit presentation parity: the real Svelte SSR bundle, same recipe as
// test/kit-event-detail.test.ts. The model gains `series` (see above); the
// view renders the same block, copy and testids as Hono.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

let cachedRender: ((model: Record<string, unknown>) => string) | null = null;
async function renderDetail(model: Record<string, unknown>): Promise<string> {
  if (!cachedRender) {
    const worktree = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "kit-series-context-"));
    try {
      const entry = join(scratch, "entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
      );
      const outfile = join(scratch, "bundle.mjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: worktree,
        nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
        alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
        plugins: [
          {
            name: "kit-series-context-ssr",
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
      const bundle = (await import(pathToFileURL(outfile).href)) as {
        renderDetail: (model: Record<string, unknown>) => string;
      };
      cachedRender = bundle.renderDetail;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return cachedRender!(model);
}

async function baseKitModel(): Promise<Record<string, unknown>> {
  const { model } = await resolveSeries(11);
  return { ...model };
}

function kitLink(id: number): Record<string, unknown> {
  const startsAt = new Date(Date.UTC(2030, 0, 10 + Math.max(0, id - 10) * 7, 20, 0, 0));
  return {
    key: key(id),
    title: `Game night ${id}`,
    whenText: startsAt.toISOString(),
    datetime: startsAt.toISOString(),
    location: "Voice",
  };
}

describe("series context in Kit detail presentation (hermetic SSR)", () => {
  it("RED: renders the same hosts line, copy and testids as Hono", async () => {
    const html = await renderDetail({
      ...(await baseKitModel()),
      series: { hosts: ["Jo", "Riley", "Sam"], previous: kitLink(10), next: kitLink(12) },
    });
    expect(html).toContain("Series hosts");
    expect(seriesHostsText(html)).toBe("Jo, Riley, Sam");
    const nav = seriesNavSection(html);
    expect(nav).toContain('aria-label="Series events"');
    expect(nav).toContain(`href="/e/${key(10)}"`);
    expect(nav).toContain('data-testid="event-series-previous"');
    expect(nav).toContain("Previous in series: Game night 10");
    expect(nav).toContain(`href="/e/${key(12)}"`);
    expect(nav).toContain('data-testid="event-series-next"');
    expect(nav).toContain("Next in series: Game night 12");
  });

  it.each([
    ["first", null, 11, "event-series-next", "event-series-previous"],
    ["last", 12, null, "event-series-previous", "event-series-next"],
  ])(
    "RED: omits the missing Kit link at the %s sibling",
    async (_pos, prevId, nextId, present, absent) => {
      const html = await renderDetail({
        ...(await baseKitModel()),
        series: {
          hosts: ["Riley", "Jo", "Sam"],
          previous: prevId === null ? null : kitLink(prevId as number),
          next: nextId === null ? null : kitLink(nextId as number),
        },
      });
      const nav = seriesNavSection(html);
      expect(nav).toContain(`data-testid="${present}"`);
      expect(nav).not.toContain(`data-testid="${absent}"`);
    },
  );

  it("RED: escapes hostile hosts in Kit presentation", async () => {
    const html = await renderDetail({
      ...(await baseKitModel()),
      series: { hosts: [HOSTILE, "Riley"], previous: kitLink(10), next: null },
    });
    const hosts = seriesHostsText(html);
    expect(hosts).toContain("&lt;img");
    expect(hosts).not.toContain("<img src=x");
  });

  it("CONTROL: renders no series markup without model.series", async () => {
    const { series: _stripped, ...rest } = await baseKitModel();
    const html = await renderDetail(rest);
    expect(html).not.toContain("event-series-hosts");
    expect(html).not.toContain("event-series-nav");
    expect(html).not.toContain("event-series-previous");
    expect(html).not.toContain("event-series-next");
    expect(html).not.toContain("Series hosts");
  });
});
