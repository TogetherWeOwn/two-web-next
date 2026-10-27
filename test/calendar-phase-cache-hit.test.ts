// Implementation-owned pin for the staging cache-hit guard + render_cache phases.
// The frozen acceptance suite only asserts public_read_guard via toMatchObject
// on a cache hit, so a revert of the cache-hit measure wrap stays green there.
// This file drives held anonymous staging cache hits and asserts the exact
// final calendar_phase_ms, in the same exact-equality style as the miss path.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as adminDb from "../src/admin/db";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import * as reads from "../src/events/reads";
import { registerCalendarRoutes } from "../src/events/routes-calendar";
import * as shared from "../src/events/routes-shared";
import * as requestLogging from "../src/request-log";
import { __resetReleaseForTests } from "../src/release-tag";

const PHASES = [
  "public_read_guard",
  "calendar_model",
  "canonical_read",
  "discord_snapshot",
  "discord_dedupe",
  "render_cache",
] as const;
type Phase = (typeof PHASES)[number];
type Times = Partial<Record<Phase, number>>;

const STAGING = "https://next.togetherweown.com"; // Env discriminator, never fetched.
const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const RAY_A = "0123456789abcdef-DFW";
const RAY_B = "fedcba9876543210-DFW";
const BASE_ENV: Env = {
  APP_URL: STAGING,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "fixture-only-session-secret-longer-than-32-bytes",
  CF_VERSION_METADATA: { tag: RELEASE },
};
type Step = "guard" | "games" | "upcoming" | "past" | "discord" | "dedupe" | "render" | "settle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function gate() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return { entered, released };
}
type Scenario = {
  db: Db;
  source: DiscordEventsSource;
  bindings: Env & { ADMIN_DB: Db; DISCORD_EVENTS: DiscordEventsSource };
  steps: string[];
  holds: Partial<Record<Step, ReturnType<typeof gate>>>;
  limited: boolean;
  session: Session | null;
  clones: number;
  bodyReads: number;
};
let now = 0;
let scenarios: Map<Db, Scenario>;
let router: Hono<{ Bindings: Env }>;
let log: MockInstance<typeof console.log>;
let requests: Promise<Response>[];

async function step(s: Scenario, name: Step) {
  s.steps.push(name);
  const hold = s.holds[name];
  if (hold) {
    hold.entered.resolve();
    await hold.released.promise;
  }
}
function scenario(appUrl = STAGING): Scenario {
  const db = {} as Db;
  const s: Scenario = {
    db,
    source: {
      upcoming: async () => {
        await step(s, "discord");
        return [];
      },
      lastReadFailed: () => false,
    },
    bindings: {} as Scenario["bindings"],
    steps: [],
    holds: {},
    limited: false,
    session: null,
    clones: 0,
    bodyReads: 0,
  };
  s.bindings = { ...BASE_ENV, APP_URL: appUrl, ADMIN_DB: db, DISCORD_EVENTS: s.source };
  scenarios.set(db, s);
  return s;
}
function hold(s: Scenario, name: Step) {
  const g = gate();
  s.holds[name] = g;
  return g;
}
function forDb(db: Db): Scenario {
  const s = scenarios.get(db);
  if (!s) throw new Error("unexpected database: cache-hit pin must stay fixture-only");
  return s;
}
function forEnv(env: Env): Scenario {
  return forDb((env as Scenario["bindings"]).ADMIN_DB);
}
function get(s: Scenario, path = "/events", ray = RAY_A, init: RequestInit = {}) {
  const pending = Promise.resolve(
    router.request(
      `https://calendar.example.test${path}`,
      { ...init, headers: { "cf-ray": ray, ...init.headers } },
      s.bindings,
    ),
  );
  requests.push(pending);
  return pending;
}
function entries() {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}
function requestEntry(ray = RAY_A) {
  const matching = entries().filter(
    (entry) => entry.event === "http.request" && entry.request_id === ray,
  );
  expect(matching).toHaveLength(1);
  return matching[0]!;
}
function finalEntry(ray: string, duration: number, times: Times, status = 200) {
  const entry = requestEntry(ray);
  expect(entry).toEqual({
    event: "http.request",
    request_id: ray,
    method: "GET",
    route: "/events",
    status,
    duration_ms: duration,
    colo: null,
    error_class: null,
    build_sha: RELEASE,
    release: RELEASE,
    calendar_phase_ms: times,
  });
}

beforeEach(() => {
  now = 0;
  scenarios = new Map();
  requests = [];
  __resetAnonEventCacheForTests();
  __resetReleaseForTests();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("cache-hit pin attempted real HTTP");
    }),
  );
  vi.spyOn(adminDb, "dbFor").mockImplementation(async (c) => {
    const s = forEnv(c.env);
    s.steps.push("db");
    return s.db;
  });
  vi.spyOn(shared, "publicReadGuard").mockImplementation(async (c) => {
    const s = forEnv(c.env);
    await step(s, "guard");
    return s.limited
      ? c.text("fixture throttled", 429, {
          "cache-control": "no-store, private",
          "retry-after": "60",
        })
      : null;
  });
  vi.spyOn(reads, "listPublishedGames").mockImplementation(async (db) => {
    await step(forDb(db), "games");
    return [];
  });
  vi.spyOn(reads, "rankUpcoming").mockImplementation(async (db) => {
    forDb(db).steps.push("rank");
    return null;
  });
  vi.spyOn(reads, "listUpcoming").mockImplementation(async (db) => {
    await step(forDb(db), "upcoming");
    return { rows: [], total: 0, totalPages: 1, hasMore: false };
  });
  vi.spyOn(reads, "listCalendarPast").mockImplementation(async (db) => {
    await step(forDb(db), "past");
    return [];
  });
  vi.spyOn(reads, "persistedDiscordIds").mockImplementation(async (db) => {
    await step(forDb(db), "dedupe");
    return new Set<string>();
  });
  vi.spyOn(reads, "listPast").mockImplementation(async (db) => {
    forDb(db).steps.push("archive");
    return { rows: [], totalPages: 1, hasMore: false };
  });
  router = new Hono<{ Bindings: Env }>();
  router.use("*", requestLogging.requestLog);
  // Preserve real HTML and cache code; the wrapper only observes the render step.
  router.use("*", async (c, next) => {
    const s = forEnv(c.env);
    const html = c.html.bind(c);
    c.html = ((...args: Parameters<typeof html>) =>
      (async () => {
        await step(s, "render");
        const response = await html(...args);
        const clone = response.clone.bind(response);
        response.clone = () => {
          s.clones++;
          const copy = clone();
          const text = copy.text.bind(copy);
          copy.text = async () => {
            s.bodyReads++;
            await step(s, "settle");
            return text();
          };
          return copy;
        };
        return response;
      })()) as typeof c.html;
    await next();
  });
  const readSession: shared.SessionReader = async (c) => {
    const s = forEnv(c.env);
    s.steps.push("session");
    return s.session;
  };
  registerCalendarRoutes(router, readSession, readSession);
});
afterEach(async () => {
  for (const s of scenarios.values()) for (const g of Object.values(s.holds)) g.released.resolve();
  await Promise.allSettled(requests);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAnonEventCacheForTests();
  __resetReleaseForTests();
});

describe("staging calendar cache-hit phase pin", () => {
  it("pins the exact cache-hit guard and render_cache phases on the final request log", async () => {
    const s = scenario();
    const first = await get(s);
    expect(first.status).toBe(200);
    const body = await first.text();
    s.steps = [];
    s.clones = 0;
    s.bodyReads = 0;
    log.mockClear();
    // The cookieless hit runs admission before serving: one guard, then
    // render, no db/session/model, and the final log carries guard + render.
    const guard = hold(s, "guard");
    const render = hold(s, "render");
    now = 100;
    const pending = get(s, "/events", RAY_B);
    const firstStep = await Promise.race([
      guard.entered.promise.then(() => "guard" as const),
      render.entered.promise.then(() => "render" as const),
    ]);
    // RED on the pre-guard cache path: the hit served render without admission.
    expect(firstStep).toBe("guard");
    expect(s.steps).toEqual(["guard"]);
    now = 105;
    guard.released.resolve();
    await render.entered.promise;
    expect(s.steps).toEqual(["guard", "render"]);
    now = 112;
    render.released.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(s.steps).toEqual(["guard", "render"]);
    expect([s.clones, s.bodyReads]).toEqual([0, 0]);
    expect(entries()).toHaveLength(1);
    finalEntry(RAY_B, 12, { public_read_guard: 5, render_cache: 7 });
  });

  it("returns 429 with guard only when the warm bucket is exhausted", async () => {
    const s = scenario();
    const first = await get(s);
    expect(first.status).toBe(200);
    const body = await first.text();
    s.steps = [];
    s.clones = 0;
    s.bodyReads = 0;
    log.mockClear();
    s.limited = true;
    // Warm but throttled: admission runs and refuses before any cache serve,
    // so no render/db/session/model steps run and only guard is observed.
    const guard = hold(s, "guard");
    const render = hold(s, "render");
    now = 100;
    const pending = get(s, "/events", RAY_B);
    const firstStep = await Promise.race([
      guard.entered.promise.then(() => "guard" as const),
      render.entered.promise.then(() => "render" as const),
    ]);
    // RED on the pre-guard cache path: the warm hit served 200 without admission.
    expect(firstStep).toBe("guard");
    expect(s.steps).toEqual(["guard"]);
    now = 109;
    guard.released.resolve();
    const response = await pending;
    expect(response.status).toBe(429);
    const throttled = await response.text();
    expect(throttled).toBe("fixture throttled");
    expect(throttled).not.toBe(body);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(s.steps).toEqual(["guard"]);
    expect([s.clones, s.bodyReads]).toEqual([0, 0]);
    expect(entries()).toHaveLength(1);
    finalEntry(RAY_B, 9, { public_read_guard: 9 }, 429);
  });
});
