// Exercise real Hono routes and compiled Kit loaders with fixture-only database
// reads and audit writes. Date-sensitive rows guard all four renderDate bindings.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { PublicEvent } from "../src/events/reads";
import { cancellationEvent } from "./helpers/calendar-cancellation";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_URL = "http://127.0.0.1:8788";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WALLS = ["2026-11-07T12:00:00Z", "2031-01-01T00:00:00Z"];
const ONGOING = "Happening now";
const FIXED_TITLE = "Fixed cutoff archive row";
const CONTROL_TITLE = "Control past archive row";

// Spans the fixed capture instant (2098-12-31T20:00:00Z) and no live wall time.
const detailEvent = (): PublicEvent =>
  cancellationEvent({
    id: 7,
    eventKey: KEY,
    title: "Fixed clock detail night",
    status: "published",
    capacity: null,
    startsAt: new Date("2098-12-31T19:00:00Z"),
    endsAt: new Date("2098-12-31T21:00:00Z"),
    goingCount: 0,
    goingOccupancy: 0,
  });

// The published row ended an hour before the fixed instant: it is archived only
// when the route supplies the fixed cutoff. The past row is always archived.
const archiveRows = (): PublicEvent[] => [
  cancellationEvent({
    id: 2,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    title: FIXED_TITLE,
    status: "published",
    capacity: null,
    startsAt: new Date("2098-12-31T17:00:00Z"),
    endsAt: new Date("2098-12-31T19:00:00Z"),
  }),
  cancellationEvent({
    id: 1,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    title: CONTROL_TITLE,
    status: "past",
    capacity: null,
    startsAt: new Date("2020-01-01T20:00:00Z"),
    endsAt: new Date("2020-01-01T22:00:00Z"),
  }),
];

const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
const tuple = (row: PublicEvent) =>
  columns.map((key) => (row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]));

// Answers reads from the supplied cutoff parameter, so the rendered archive
// depends on the Date the route passed to listPast.
function fakeDb(): Db {
  return drizzle(async (sql, params) => {
    if (!sql.startsWith("select ") || sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      const event = detailEvent();
      return { rows: params.includes(event.eventKey) ? [tuple(event)] : [] };
    }
    if (!params.includes("past")) return { rows: [] };
    const cutoff = params.find(
      (p): p is string => typeof p === "string" && /^\d{4}-\d\d-\d\dT/.test(p),
    );
    const selected = archiveRows()
      .filter(
        (row) =>
          row.status === "past" ||
          (row.status === "published" &&
            cutoff !== undefined &&
            row.endsAt.getTime() < new Date(cutoff).getTime()),
      )
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id - a.id);
    if (sql.startsWith("select count(*)")) return { rows: [[selected.length]] };
    const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
    return { rows: selected.slice(offset, offset + limit).map(tuple) };
  }) as unknown as Db;
}

let app: typeof import("../src/index").default;
let clock: typeof import("../src/render-clock");
let cache: typeof import("../src/events/anon-cache");
let access: typeof import("../src/admin/store-access");
let makeEnv: (flag: "true" | "false") => Env;

type Kit = {
  bind: (env: Env) => void;
  memberReadResponse: (...args: unknown[]) => Promise<Response>;
  detailLoad: (event: unknown) => Promise<{ model: { isOngoing: boolean } }>;
  pastLoad: (event: unknown) => Promise<{ rows: { title: string }[] }>;
};
let kit: Kit;
let scratch = "";

beforeAll(async () => {
  vi.stubGlobal("__TWO_LOCAL_CAPTURE__", true);
  clock = await import("../src/render-clock");
  app = (await import("../src/index")).default;
  cache = await import("../src/events/anon-cache");
  access = await import("../src/admin/store-access");
  const { createMemorySessionStore } = await import("../src/sessions");
  makeEnv = (flag) =>
    ({
      APP_URL,
      SSR_CAPTURE_FIXTURE: flag,
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      SESSION_STORE: createMemorySessionStore(),
      ADMIN_DB: fakeDb(),
      DISCORD_INVITE_URL: "https://discord.gg/example",
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    }) as unknown as Env;

  // The real loaders, bundled with the generated build's constant defined true.
  // Only the Workers env binding is adapted; dbFor, the read model and the
  // route bindings under test stay real.
  scratch = mkdtempSync(join(tmpdir(), "render-clock-routes-"));
  const outfile = join(scratch, "kit.mjs");
  await build({
    stdin: {
      contents: `
        export { bind } from "cloudflare:workers";
        export { memberReadResponse } from ${JSON.stringify(join(root, "src/member-reads.ts"))};
        export { load as detailLoad } from ${JSON.stringify(join(root, "web/src/routes/e/[key]/+page.server.ts"))};
        export { load as pastLoad } from ${JSON.stringify(join(root, "web/src/routes/events/past/+page.server.ts"))};
      `,
      resolveDir: root,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "warning",
    absWorkingDir: root,
    define: { __TWO_LOCAL_CAPTURE__: "true" },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    plugins: [
      {
        name: "render-clock-routes-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "render-clock-routes",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "render-clock-routes" }, () => ({
            contents: "export let env; export function bind(value) { env = value; }",
            loader: "js",
          }));
        },
      },
    ],
  });
  kit = (await import(pathToFileURL(outfile).href)) as Kit;
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  cache.__resetAnonEventCacheForTests();
  // Only the external audit write is faked; reads and rendering stay real.
  vi.spyOn(access, "recordAccess").mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cache.__resetAnonEventCacheForTests();
});

const atWall = (wall: string) =>
  vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date(wall));
const honoGet = (path: string, flag: "true" | "false") => {
  cache.__resetAnonEventCacheForTests();
  return app.request(new Request(APP_URL + path), undefined, makeEnv(flag));
};

async function kitDetail(flag: "true" | "false") {
  const env = makeEnv(flag);
  kit.bind(env);
  let data: { model: { isOngoing: boolean } } | undefined;
  const response = await kit.memberReadResponse(
    { method: "GET", route: "events.page" },
    { resource: "member", action: "list", route: "events.page", viewer: null },
    async () => true,
    async () => {
      data = await kit.detailLoad({
        params: { key: KEY },
        url: new URL(`${APP_URL}/e/${KEY}`),
        request: new Request(`${APP_URL}/e/${KEY}`),
        locals: { status: "guest", session: null, joinResult: null },
        cookies: { delete() {} },
        setHeaders() {},
      });
      return new Response("ok", { headers: { "content-type": "text/html" } });
    },
  );
  expect(response.status).toBe(200);
  return data!;
}

async function kitPast(flag: "true" | "false") {
  kit.bind(makeEnv(flag));
  const path = `${APP_URL}/events/past`;
  return kit.pastLoad({
    url: new URL(path),
    request: new Request(path),
    locals: {},
    setHeaders() {},
  });
}

describe("real route wiring of the fixed SSR capture clock", () => {
  it("renders Hono GET /e/:key from the fixed instant at any host wall time", async () => {
    for (const wall of WALLS) {
      atWall(wall);
      const response = await honoGet(`/e/${KEY}`, "true");
      expect(response.status).toBe(200);
      expect(response.headers.get(clock.SSR_CAPTURE_HEADER)).toBe(clock.SSR_CAPTURE_INSTANT);
      const html = await response.text();
      expect(html).toContain("Fixed clock detail night");
      expect(html).toContain(ONGOING);
    }
  });

  it("renders Hono GET /events/past against the fixed archive cutoff at any host wall time", async () => {
    for (const wall of WALLS) {
      atWall(wall);
      const response = await honoGet("/events/past", "true");
      expect(response.status).toBe(200);
      expect(response.headers.get(clock.SSR_CAPTURE_HEADER)).toBe(clock.SSR_CAPTURE_INSTANT);
      const html = await response.text();
      expect(html).toContain(CONTROL_TITLE);
      expect(html).toContain(FIXED_TITLE);
    }
  });

  it("keeps Kit e/[key] +page.server on the fixed instant at any host wall time", async () => {
    for (const wall of WALLS) {
      atWall(wall);
      expect((await kitDetail("true")).model.isOngoing).toBe(true);
    }
  });

  it("keeps Kit events/past +page.server on the fixed archive cutoff at any host wall time", async () => {
    for (const wall of WALLS) {
      atWall(wall);
      const titles = (await kitPast("true")).rows.map((row) => row.title);
      expect(titles).toContain(CONTROL_TITLE);
      expect(titles).toContain(FIXED_TITLE);
    }
  });

  it("falls back to the live clock with no marker when the runtime opt-out is false", async () => {
    for (const wall of WALLS) {
      atWall(wall);
      const detail = await honoGet(`/e/${KEY}`, "false");
      expect(detail.status).toBe(200);
      expect(detail.headers.has(clock.SSR_CAPTURE_HEADER)).toBe(false);
      expect(await detail.text()).not.toContain(ONGOING);

      const archive = await honoGet("/events/past", "false");
      expect(archive.status).toBe(200);
      expect(archive.headers.has(clock.SSR_CAPTURE_HEADER)).toBe(false);
      const html = await archive.text();
      expect(html).toContain(CONTROL_TITLE);
      expect(html).not.toContain(FIXED_TITLE);

      expect((await kitDetail("false")).model.isOngoing).toBe(false);
      const titles = (await kitPast("false")).rows.map((row) => row.title);
      expect(titles).toContain(CONTROL_TITLE);
      expect(titles).not.toContain(FIXED_TITLE);
    }
  });
});
