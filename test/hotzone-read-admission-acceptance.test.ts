// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only): hot-zone heatmap reads spend the shared
// public-read budget before aggregation and board-view logging.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Today the Hono handlers (src/hotzones/routes.tsx) open a DB handle, run the
// joins aggregate and insert a board_view_logs row on every GET with no
// admission, and the Kit dispatch (src/route-ownership.ts) resolves the
// Kit-owned hot-zone paths with no guard. The event pages already charge one
// shared 60/min `events-read` budget per client before any read
// (src/events/routes-shared.ts `publicReadGuard`; the reusable Kit wrapper is
// `kitPublicReadGuard` in src/kit-past-events.ts). Hot zones must charge that
// same bucket — not a new hot-zone bucket — after the season/signal grammar
// and before `dbFor`, aggregation and logging:
//
// - Grammar first (existing order kept): a bad `?season=` answers 400 and an
//   unknown signal answers 404 with zero budget spent, exactly as today.
// - Then admission: one `events-read:<clientKey>` hit per admitted GET on
//   `/hotzones`, `/hotzones/joins`, `/hotzones/voice` and `/hotzones/games`.
//   An exhausted client gets the shared branded 429 (`Retry-After`,
//   `cache-control: no-store, private`) with zero DB-handle opens, zero
//   aggregate transactions and zero board-view inserts.
// - Admitted renders keep `200` with `cache-control: public, max-age=300`
//   and `vary: Cookie`.
// - Kit: the guard runs in the hook dispatch, following the
//   pastArchive/eventsPage/eventDetail pattern — a new
//   `HookDispatchDeps.hotzones` wrapper `(request, render) => Promise<Response>`
//   that src/route-ownership.ts routes the `/hotzones` and
//   `/hotzones/[signal]` route ids through when present, bound in
//   web/src/hooks.server.ts to a `kitPublicReadGuard`-based wrapper (e.g.
//   `dispatchHotzonesRequest(request, env, render)` in src/kit-hotzones.ts).
//   The production wrapper checks the season grammar before charging, so a
//   bad season reaches the load's 400 without spending, mirroring Hono.
//
// How this fails before the Builder lands: the budget cases fail — hot-zone
// GETs spend no hits, an exhausted client still gets a 200 board (and touches
// the poisoned DB double), and the Kit dispatch ignores the `hotzones`
// wrapper and renders. The positive controls (200/cache headers, 400/404 with
// no spend) already pass and must keep passing.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { PUBLIC_EVENT_READS_PER_MINUTE, registerEventRoutes } from "../src/events/routes";
import { registerHotzoneRoutes } from "../src/hotzones/routes";
import { emptyGrid } from "../src/hotzones/aggregates";
import { parseSeasonParam } from "../src/hotzones/season";
import { loadHotzoneSignalData } from "../src/kit-hotzones";
import { kitPublicReadGuard } from "../src/kit-past-events";
import { dispatchHookRequest, type HookDispatchDeps } from "../src/route-ownership";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const PATHS = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];
const IP = "192.0.2.17";
const APP_URL = "https://next.example.test";

// Exercise the real admission transaction with local statement doubles only,
// mirroring test/public-event-read-admission.test.ts. The events routes share
// the app so the budget can be exhausted through `/events` — proving the
// hot zones spend the same `events-read` bucket, not a bucket of their own.
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
      // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before
      // the advisory lock; the double passes it through.
      unsafe: async () => [],
    },
  );
  const throttleStore = vi.fn(async () => sql as unknown as Sql);
  // Poisoned DB: any aggregate or board-log transaction is a contract break.
  // `dbFor` reaching for ADMIN_DB at all is counted through `eventStore`.
  const transaction = vi.fn(async () => {
    throw new Error("hot-zone DB touched after budget exhaustion");
  });
  const poisonDb = { transaction } as unknown as Db;
  let currentDb: Db | null = null;
  const eventStore = vi.fn(() => currentDb);
  const readSession = vi.fn(async () => null);
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, readSession, readSession);
  registerHotzoneRoutes(app);
  const env = {
    APP_URL,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    THROTTLE_STORE: throttleStore,
    get ADMIN_DB() {
      return eventStore();
    },
  } as unknown as EnvWithThrottle;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": IP, ...init.headers } }, env);
  const exhaust = async () => {
    for (let n = 0; n < PUBLIC_EVENT_READS_PER_MINUTE; n++) {
      const response = await request(`/events?q=probe${n}`);
      expect(response.status).not.toBe(429);
    }
    expect(hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  };
  return {
    request,
    exhaust,
    hits,
    throttleStore,
    eventStore,
    transaction,
    env,
    poison: () => {
      currentDb = poisonDb;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// Expected production shape of the Kit binding: season grammar first (a bad
// season renders the load's 400 without spending), then the shared guard,
// then render. The dispatch cases below inject this shape as
// `deps.hotzones`; the Builder's src/kit-hotzones.ts wrapper must mirror it.
function kitWrapperFor(env: Env) {
  return async (req: Request, render: () => Promise<Response>): Promise<Response> => {
    const url = new URL(req.url);
    if (!parseSeasonParam(url.searchParams.get("season"))) return render();
    const limited = await kitPublicReadGuard(req, env);
    return limited ?? render();
  };
}

describe("hot-zone read admission (Hono)", () => {
  it("returns the shared 429 before any DB, aggregate or board-log work once the budget is exhausted", async () => {
    const f = fixture();
    await f.exhaust();
    f.poison();
    f.eventStore.mockClear();
    f.transaction.mockClear();
    for (const path of PATHS) {
      const response = await f.request(path, { headers: { accept: "application/json" } });
      expect(response.status, path).toBe(429);
      expect(response.headers.get("retry-after"), path).toBe("60");
      expect(response.headers.get("cache-control"), path).toBe("no-store, private");
      expect(await response.json(), path).toMatchObject({
        reason: "rate_limited",
        retry_after: 60,
      });
    }
    // Denials spend nothing further and stay in the one shared bucket.
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
    expect(new Set(f.hits.map((hit) => hit.bucket))).toEqual(new Set([`events-read:${IP}`]));
    // Zero DB-handle opens, so zero aggregate reads and zero board inserts.
    expect(f.eventStore).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("renders the branded browser 429 for an exhausted HTML client", async () => {
    const f = fixture();
    await f.exhaust();
    f.poison();
    f.eventStore.mockClear();
    const response = await f.request("/hotzones", { headers: { accept: "text/html" } });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Slow down a little");
    expect(f.eventStore).not.toHaveBeenCalled();
  });

  it("spends exactly one shared hit per admitted hot-zone GET", async () => {
    const f = fixture();
    for (const path of PATHS) {
      const before = f.hits.length;
      const response = await f.request(path);
      expect(response.status, path).toBe(200);
      expect(f.hits, path).toHaveLength(before + 1);
      expect(f.hits.at(-1)?.bucket, path).toBe(`events-read:${IP}`);
    }
  });

  it("keeps other clients admitted and admits again after the window", async () => {
    const f = fixture();
    await f.exhaust();
    expect((await f.request("/hotzones")).status).toBe(429);
    expect(
      (await f.request("/hotzones", { headers: { "cf-connecting-ip": "192.0.2.18" } })).status,
    ).toBe(200);
    f.advance(60_001);
    expect((await f.request("/hotzones")).status).toBe(200);
  });
});

describe("hot-zone positive controls (Hono)", () => {
  it("keeps the 200 render and public cache headers under budget on every path", async () => {
    const f = fixture();
    for (const path of PATHS) {
      const response = await f.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("public, max-age=300");
      expect(response.headers.get("vary"), path).toBe("Cookie");
      expect(response.headers.get("content-type"), path).toContain("text/html");
    }
  });

  it.each(["/hotzones?season=not-a-season", "/hotzones/joins?season=2026-13"])(
    "answers a bad season on %s with 400 and spends no budget",
    async (path) => {
      const f = fixture();
      const response = await f.request(path);
      expect(response.status).toBe(400);
      expect(f.hits).toHaveLength(0);
      expect(f.throttleStore).not.toHaveBeenCalled();
      expect(f.eventStore).not.toHaveBeenCalled();
    },
  );

  it("answers an unknown signal with 404 and spends no budget", async () => {
    const f = fixture();
    const response = await f.request("/hotzones/bogus");
    expect(response.status).toBe(404);
    expect(f.hits).toHaveLength(0);
    expect(f.throttleStore).not.toHaveBeenCalled();
    expect(f.eventStore).not.toHaveBeenCalled();
  });
});

describe("hot-zone read admission (Kit dispatch)", () => {
  const kitEventFor = (path: string, routeId: string) => {
    const request = new Request(new URL(path, APP_URL).href, {
      method: "GET",
      headers: { host: "next.example.test", "cf-connecting-ip": IP },
    });
    return { request, url: new URL(request.url), route: { id: routeId } };
  };

  it("refuses an exhausted Kit hot-zone request before resolve, aggregation or logging", async () => {
    const f = fixture();
    await f.exhaust();
    const dbForFn = vi.fn(async () => ({}) as never);
    const loadJoinsGridFn = vi.fn(async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }));
    const recordBoardViewFn = vi.fn(async () => {});
    const resolve = vi.fn(async () => {
      const data = await loadHotzoneSignalData({
        env: { APP_URL } as never,
        seasonParam: null,
        signalParam: "joins",
        setHeaders: vi.fn(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn,
      });
      return new Response(JSON.stringify(data));
    });
    const deps = {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      hotzones: kitWrapperFor(f.env as unknown as Env),
    } as unknown as HookDispatchDeps;

    const response = await dispatchHookRequest(
      kitEventFor("/hotzones/joins", "/hotzones/[signal]"),
      deps,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(resolve).not.toHaveBeenCalled();
    expect(dbForFn).not.toHaveBeenCalled();
    expect(loadJoinsGridFn).not.toHaveBeenCalled();
    expect(recordBoardViewFn).not.toHaveBeenCalled();
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
    expect(new Set(f.hits.map((hit) => hit.bucket))).toEqual(new Set([`events-read:${IP}`]));
  });

  it("spends one shared hit and renders once for an admitted Kit hot-zone request", async () => {
    const f = fixture();
    const resolve = vi.fn(
      async () => new Response("kit", { headers: { "cache-control": "public, max-age=300" } }),
    );
    const deps = {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      hotzones: kitWrapperFor(f.env as unknown as Env),
    } as unknown as HookDispatchDeps;

    const response = await dispatchHookRequest(kitEventFor("/hotzones", "/hotzones"), deps);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("kit");
    expect(resolve).toHaveBeenCalledOnce();
    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]?.bucket).toBe(`events-read:${IP}`);
  });

  it("lets a bad Kit season reach render (the load's 400) without spending", async () => {
    const f = fixture();
    const resolve = vi.fn(async () => new Response("Unknown season", { status: 400 }));
    const deps = {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      hotzones: kitWrapperFor(f.env as unknown as Env),
    } as unknown as HookDispatchDeps;

    const response = await dispatchHookRequest(
      kitEventFor("/hotzones?season=not-a-season", "/hotzones"),
      deps,
    );

    expect(response.status).toBe(400);
    expect(resolve).toHaveBeenCalledOnce();
    expect(f.hits).toHaveLength(0);
  });
});
