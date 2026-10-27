// Acceptance-owned. Builder consumes this file unchanged; fixtures only.
// Breaks caught: unused recorder, wrong environment/route, flattened parallel
// timings, global request state, invented zeroes, changed awaits/cache/errors,
// unbounded labels and a failing clock that breaks otherwise successful work.
//
// Minimal new seam frozen here (no production stub in the acceptance commit):
// src/request-log.ts exports createCalendarPhaseRecorder(now: () => number),
// returning { measure(name, work): Promise<work result>, snapshot(): object }.
// measure invokes work exactly once, preserves its value/rejection, and records
// only the six names below. Invalid/unavailable readings may be omitted, never
// emitted as nonfinite/negative values. snapshot is detached from recorder state.
// Route integration uses the real route, model, renderer, cache and requestLog;
// only external reads/admission/session and elapsed time are controlled here.
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
type Recorder = {
  measure<T>(name: string, work: () => T | Promise<T>): Promise<T>;
  snapshot(): Times;
};

function recorder(now: () => number): Recorder {
  // Namespace lookup keeps baseline RED an explicit missing-behavior assertion,
  // not a missing-module/export crash that prevents the route controls running.
  const create = Reflect.get(requestLogging, "createCalendarPhaseRecorder");
  expect(create, "missing injectable calendar phase recorder").toBeTypeOf("function");
  return create(now) as Recorder;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function bounded(value: unknown) {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  for (const [key, elapsed] of Object.entries(value as object)) {
    expect(PHASES).toContain(key);
    expect(typeof elapsed).toBe("number");
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  }
  expect(Object.keys(value as object).length).toBeLessThanOrEqual(6);
}

describe("calendar phase recorder contract", () => {
  it("has no observed phases until work runs; an observed zero is not an absent phase", async () => {
    const r = recorder(() => 10);
    expect(r.snapshot()).toEqual({});
    const result = { unchanged: true };
    expect(await r.measure("public_read_guard", () => result)).toBe(result);
    expect(r.snapshot()).toEqual({ public_read_guard: 0 });
  });

  it("measures overlapping branches independently, not a sum masquerading as model total", async () => {
    let now = 0;
    const r = recorder(() => now);
    const canonical = deferred<void>();
    const discord = deferred<void>();
    const model = r.measure("calendar_model", () =>
      Promise.all([
        r.measure("canonical_read", () => canonical.promise),
        r.measure("discord_snapshot", () => discord.promise),
      ]),
    );
    now = 12;
    canonical.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    now = 25;
    discord.resolve();
    await model;
    expect(r.snapshot()).toEqual({ calendar_model: 25, canonical_read: 12, discord_snapshot: 25 });
    bounded(r.snapshot());
  });

  it("uses the injected monotonic clock even when civil time jumps backwards", async () => {
    let now = 100;
    const r = recorder(() => now);
    vi.spyOn(Date, "now").mockReturnValueOnce(9_000_000).mockReturnValue(1);
    await r.measure("render_cache", () => {
      now = 107;
    });
    expect(r.snapshot()).toEqual({ render_cache: 7 });
  });

  it.each(["private-query", "sql", "member_id", "__proto__", "constructor", "request_id"])(
    "does not publish arbitrary label %s or suppress its work",
    async (label) => {
      const r = recorder(() => 1);
      let calls = 0;
      expect(await r.measure(label, () => ++calls)).toBe(1);
      expect(calls).toBe(1);
      expect(r.snapshot()).toEqual({});
    },
  );

  it.each(["start", "end"])(
    "a throwing %s clock does not change work or its return value",
    async (at) => {
      let calls = 0;
      const r = recorder(() => {
        calls++;
        if (calls === (at === "start" ? 1 : 2)) throw new Error("private-clock-detail");
        return 4;
      });
      let ran = 0;
      const value = { unchanged: true };
      expect(
        await r.measure("canonical_read", () => {
          ran++;
          return value;
        }),
      ).toBe(value);
      expect(ran).toBe(1);
      bounded(r.snapshot());
    },
  );

  it.each([NaN, Infinity, -Infinity, -5])(
    "never emits invalid elapsed time from an end reading of %s",
    async (end) => {
      let now = 0;
      const r = recorder(() => now);
      expect(
        await r.measure("discord_snapshot", () => {
          now = end;
          return "same result";
        }),
      ).toBe("same result");
      bounded(r.snapshot());
    },
  );

  it.each(["sync", "async"])(
    "records a rejecting %s phase without replacing its original error",
    async (kind) => {
      let now = 0;
      const r = recorder(() => now);
      const original = new RangeError("private-SQL-and-query-detail");
      const work = () => {
        now = 8;
        if (kind === "sync") throw original;
        return Promise.reject(original);
      };
      await expect(r.measure("discord_dedupe", work)).rejects.toBe(original);
      expect(r.snapshot()).toEqual({ discord_dedupe: 8 });
      expect(JSON.stringify(r.snapshot())).not.toContain(original.message);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "does not let an invalid start reading of %s break successful work",
    async (start) => {
      let now = start;
      const r = recorder(() => now);
      expect(
        await r.measure("calendar_model", () => {
          now = 20;
          return "success";
        }),
      ).toBe("success");
      bounded(r.snapshot());
    },
  );

  it("preserves a work rejection even when reading its elapsed time also throws", async () => {
    const original = new Error("original-work-error");
    const r = recorder(() => {
      throw new Error("clock-error");
    });
    await expect(
      r.measure("public_read_guard", () => {
        throw original;
      }),
    ).rejects.toBe(original);
    bounded(r.snapshot());
  });

  it("keeps recorders and returned snapshots independent", async () => {
    let now = 0;
    const a = recorder(() => now);
    const b = recorder(() => now);
    await a.measure("public_read_guard", () => {
      now = 3;
    });
    const published = a.snapshot();
    published.public_read_guard = 999;
    await b.measure("render_cache", () => {
      now = 8;
    });
    expect(a.snapshot()).toEqual({ public_read_guard: 3 });
    expect(b.snapshot()).toEqual({ render_cache: 5 });
  });
});

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
  rejection?: { at: Step; error: Error };
  limited: boolean;
  session: Session | null;
  clones: number;
  bodyReads: number;
};
let now = 0;
let scenarios: Map<Db, Scenario>;
let router: Hono<{ Bindings: Env }>;
let log: MockInstance<typeof console.log>;
let capturedErrors: Error[];
let requests: Promise<Response>[];

async function step(s: Scenario, name: Step) {
  s.steps.push(name);
  const hold = s.holds[name];
  if (hold) {
    hold.entered.resolve();
    await hold.released.promise;
  }
  if (s.rejection?.at === name) throw s.rejection.error;
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
  if (!s) throw new Error("unexpected database: acceptance must stay fixture-only");
  return s;
}
function forEnv(env: Env): Scenario {
  return forDb((env as Scenario["bindings"]).ADMIN_DB);
}
function get(s: Scenario, path = "/events", ray = RAY_A, init: RequestInit = {}) {
  const pending = Promise.resolve(
    router.request(
      `https://calendar.example.test${path}`,
      {
        ...init,
        headers: { "cf-ray": ray, ...init.headers },
      },
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
  bounded(entry.calendar_phase_ms);
}

beforeEach(() => {
  now = 0;
  scenarios = new Map();
  capturedErrors = [];
  requests = [];
  __resetAnonEventCacheForTests();
  __resetReleaseForTests();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("acceptance attempted real HTTP");
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
  router.onError((error, c) => {
    capturedErrors.push(error);
    return c.text("fixture original refusal", 503, { "cache-control": "no-store" });
  });
  // Preserve real HTML and cache code. Controlled renderer/clone settlement
  // lets the test observe precisely which existing awaited work is measured.
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
  router.get("/other", (c) => c.text("unchanged"));
});
afterEach(async () => {
  // Always release and drain peers before restoring spies, including when an
  // assertion fails with another request or Promise.all branch still parked.
  for (const s of scenarios.values()) for (const g of Object.values(s.holds)) g.released.resolve();
  await Promise.allSettled(requests);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAnonEventCacheForTests();
  __resetReleaseForTests();
});

describe("real calendar route to final request-log acceptance", () => {
  it("awaits admission, overlaps branches, includes dedupe and render/cache settlement on the same final event", async () => {
    const s = scenario();
    const clones = vi.spyOn(Response.prototype, "clone");
    const bodyReads = vi.spyOn(Response.prototype, "text");
    const guard = hold(s, "guard");
    const games = hold(s, "games");
    const upcoming = hold(s, "upcoming");
    const past = hold(s, "past");
    const discord = hold(s, "discord");
    const dedupe = hold(s, "dedupe");
    const render = hold(s, "render");
    const settle = hold(s, "settle");
    const pending = get(s);
    await guard.entered.promise;
    expect(s.steps).toEqual(["guard"]);
    expect(entries()).toEqual([]);
    now = 5;
    guard.released.resolve();
    // No game requested: the facet read is held, yet the page reads and
    // Discord all start without waiting for it.
    await Promise.all([
      games.entered.promise,
      upcoming.entered.promise,
      past.entered.promise,
      discord.entered.promise,
    ]);
    expect(s.steps).toEqual(["guard", "db", "session", "games", "upcoming", "past", "discord"]);
    now = 10;
    games.released.resolve();
    now = 20;
    upcoming.released.resolve();
    past.released.resolve();
    // Canonical completes while Discord is still held. No dedupe/render yet.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.steps).not.toContain("dedupe");
    expect(entries()).toEqual([]);
    now = 30;
    discord.released.resolve();
    await dedupe.entered.promise;
    now = 35;
    dedupe.released.resolve();
    await render.entered.promise;
    now = 38;
    render.released.resolve();
    await settle.entered.promise;
    expect(entries()).toEqual([]);
    now = 42;
    settle.released.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(RAY_A);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("vary")).toBe("Cookie, X-Two-Island");
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-type",
      "vary",
      "x-request-id",
    ]);
    expect(response.bodyUsed).toBe(false);
    expect(clones).toHaveBeenCalledTimes(1);
    expect(bodyReads).toHaveBeenCalledTimes(1);
    expect(await response.text()).toContain('data-island="events-calendar"');
    expect(s.steps).toEqual([
      "guard",
      "db",
      "session",
      "games",
      "upcoming",
      "past",
      "discord",
      "dedupe",
      "render",
      "settle",
    ]);
    expect([s.clones, s.bodyReads]).toEqual([1, 1]);
    expect(entries()).toHaveLength(1);
    finalEntry(RAY_A, 42, {
      public_read_guard: 5,
      calendar_model: 30,
      canonical_read: 15,
      discord_snapshot: 25,
      discord_dedupe: 5,
      render_cache: 7,
    });
  });

  it("retains anonymous cache hits without rerunning model reads or inventing skipped zeroes", async () => {
    const s = scenario();
    const first = await get(s);
    const body = await first.text();
    s.steps = [];
    s.clones = 0;
    s.bodyReads = 0;
    log.mockClear();
    const response = await get(s, "/events", RAY_B);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("vary")).toBe("Cookie, X-Two-Island");
    expect(s.steps).toEqual(["guard", "db", "session", "render"]);
    expect([s.clones, s.bodyReads]).toEqual([0, 0]);
    const times = requestEntry(RAY_B).calendar_phase_ms;
    bounded(times);
    expect(times).toMatchObject({ public_read_guard: 0 });
    for (const phase of ["calendar_model", "canonical_read", "discord_snapshot", "discord_dedupe"])
      expect(times).not.toHaveProperty(phase);
  });

  it("does not force cache eligibility for an anonymous request carrying a stray cookie", async () => {
    const s = scenario();
    for (const ray of [RAY_A, RAY_B]) {
      s.steps = [];
      const response = await get(s, "/events", ray, { headers: { cookie: "stray=fixture" } });
      expect(response.status).toBe(200);
      expect(s.steps).toEqual([
        "guard",
        "db",
        "session",
        "games",
        "upcoming",
        "past",
        "discord",
        "dedupe",
        "render",
      ]);
      expect([s.clones, s.bodyReads]).toEqual([0, 0]);
      expect(response.bodyUsed).toBe(false);
    }
  });

  it("logs only admission for an early 429 and never acquires the model/session", async () => {
    const s = scenario();
    s.limited = true;
    const guard = hold(s, "guard");
    const pending = get(s);
    await guard.entered.promise;
    now = 9;
    guard.released.resolve();
    const response = await pending;
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("fixture throttled");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(s.steps).toEqual(["guard"]);
    finalEntry(RAY_A, 9, { public_read_guard: 9 }, 429);
  });

  it("does not populate phases on validation rejection before admission", async () => {
    const s = scenario();
    const response = await get(s, `/events?q=${"x".repeat(256)}`);
    expect(response.status).toBe(422);
    expect(s.steps).toEqual(["render"]);
    const times = requestEntry().calendar_phase_ms;
    // No phase was observed: omission or an empty object is valid, six zeroes are not.
    expect(times ?? {}).toEqual({});
  });

  it("preserves the rejecting guard's error identity/status and bounded final logging", async () => {
    const s = scenario();
    const original = new RangeError("private-SQL-and-session-detail");
    s.rejection = { at: "guard", error: original };
    const guard = hold(s, "guard");
    const pending = get(s);
    await guard.entered.promise;
    now = 11;
    guard.released.resolve();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("fixture original refusal");
    expect(capturedErrors).toEqual([original]);
    expect(s.steps).toEqual(["guard"]);
    finalEntry(RAY_A, 11, { public_read_guard: 11 }, 503);
    expect(JSON.stringify(entries())).not.toContain(original.message);
  });

  it("does not await an unrelated pending Discord branch after canonical rejects", async () => {
    const s = scenario();
    const original = new TypeError("private-canonical-failure");
    s.rejection = { at: "upcoming", error: original };
    const upcoming = hold(s, "upcoming");
    const discord = hold(s, "discord");
    const pending = get(s);
    await Promise.all([upcoming.entered.promise, discord.entered.promise]);
    now = 13;
    upcoming.released.resolve();
    try {
      const response = await pending; // Discord stays parked until finally.
      expect(response.status).toBe(503);
      expect(capturedErrors).toEqual([original]);
      expect(s.steps).not.toContain("dedupe");
      expect(s.steps).not.toContain("render");
      finalEntry(RAY_A, 13, { public_read_guard: 0, canonical_read: 13, calendar_model: 13 }, 503);
    } finally {
      discord.released.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("keeps interleaved request phases attached to their own existing request_id and release", async () => {
    const a = scenario();
    const b = scenario();
    const guardA = hold(a, "guard");
    const upcomingB = hold(b, "upcoming");
    const pendingA = get(a, "/events", RAY_A);
    await guardA.entered.promise;
    now = 3;
    const pendingB = get(b, "/events", RAY_B);
    await upcomingB.entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    now = 8;
    upcomingB.released.resolve();
    expect((await pendingB).status).toBe(200);
    finalEntry(RAY_B, 5, {
      public_read_guard: 0,
      calendar_model: 5,
      canonical_read: 5,
      discord_snapshot: 0,
      discord_dedupe: 0,
      render_cache: 0,
    });
    now = 10;
    guardA.released.resolve();
    expect((await pendingA).status).toBe(200);
    finalEntry(RAY_A, 10, {
      public_read_guard: 10,
      calendar_model: 0,
      canonical_read: 0,
      discord_snapshot: 0,
      discord_dedupe: 0,
      render_cache: 0,
    });
    expect(entries()).toHaveLength(2);
  });

  it.each([
    "https://togetherweown.com",
    "https://preview.example.test",
    "http://localhost:8787",
    `${STAGING}/`,
    "",
  ])(
    "keeps the existing log shape outside exact staging APP_URL %s, regardless of request host",
    async (appUrl) => {
      const s = scenario(appUrl);
      const response = await router.request(
        `${STAGING}/events`,
        { headers: { "cf-ray": RAY_A } },
        s.bindings,
      );
      expect(response.status).toBe(200);
      expect(requestEntry()).not.toHaveProperty("calendar_phase_ms");
      expect(Object.keys(requestEntry()).sort()).toEqual([
        "build_sha",
        "colo",
        "duration_ms",
        "error_class",
        "event",
        "method",
        "release",
        "request_id",
        "route",
        "status",
      ]);
    },
  );

  it.each(["/events/past", "/other", "/missing", "/events/unknown"])(
    "keeps phase attribution off other route %s",
    async (path) => {
      const s = scenario();
      const response = await get(s, path);
      expect(response.status).toBe(path === "/events/past" || path === "/other" ? 200 : 404);
      expect(requestEntry()).not.toHaveProperty("calendar_phase_ms");
    },
  );

  it("does not add phase attribution for HEAD even though Hono resolves the GET handler", async () => {
    const s = scenario();
    const response = await get(s, "/events", RAY_A, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(requestEntry()).not.toHaveProperty("calendar_phase_ms");
  });

  it("keeps member responses private and outside anonymous attribution", async () => {
    const s = scenario();
    s.session = {
      id: "private-member",
      username: "private-user",
      avatar: null,
      member: true,
      moderator: false,
    };
    const response = await get(s, "/events", RAY_A, {
      headers: { cookie: "s=private-session-marker" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect([s.clones, s.bodyReads]).toEqual([0, 0]);
    expect(requestEntry()).not.toHaveProperty("calendar_phase_ms");
    expect(JSON.stringify(entries())).not.toMatch(
      /private-member|private-user|private-session-marker/,
    );
  });

  it("never publishes query/header/payload values as phase keys or data", async () => {
    const s = scenario();
    const response = await get(
      s,
      "/events?game=private-game-marker&event=private-input-marker",
      RAY_A,
      {
        headers: {
          authorization: "Bearer private-header-marker",
          "x-calendar-phase": "private-label-marker",
        },
      },
    );
    expect(response.status).toBe(200);
    bounded(requestEntry().calendar_phase_ms);
    expect(JSON.stringify(entries())).not.toMatch(
      /private-game-marker|private-input-marker|private-header-marker|private-label-marker/,
    );
    expect(response.headers.has("server-timing")).toBe(false);
    expect(response.headers.has("calendar_phase_ms")).toBe(false);
  });
});
