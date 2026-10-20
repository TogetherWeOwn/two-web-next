import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { PUBLIC_EVENT_READS_PER_MINUTE, registerEventRoutes } from "../src/events/routes";
import { MAX_QUERY_LENGTH } from "../src/events/search-log";
import { EVENTS_SEARCH_TOO_LONG_COPY } from "../src/islands/contracts-calendar";
import { registerPublicApiRoutes } from "../src/public-data/routes";
import { registerSeoLeaves } from "../src/seo-leaves";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const PATHS = [
  "/events?q=chess",
  "/events/past?page=2",
  "/events.rss",
  "/events.ics",
  "/events/01ARZ3NDEKTSV4RRFFQ69G5FAA.ics",
  "/e/01ARZ3NDEKTSV4RRFFQ69G5FAA",
  "/sitemap_index.xml",
];
const IP = "192.0.2.17";

// Exercise the real admission transaction with local statement doubles only.
function fixture(db: Db | null = null) {
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
  const eventStore = vi.fn(() => db);
  const readSession = vi.fn(async () => null);
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, readSession, readSession);
  registerSeoLeaves(app);
  registerPublicApiRoutes(app);
  const env = {
    APP_URL: "https://next.example.test",
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
  };
  return {
    app,
    env,
    request,
    exhaust,
    hits,
    throttleStore,
    eventStore,
    readSession,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("public event read admission", () => {
  it("shares one budget across pages, feeds and distinct search values before event/session reads", async () => {
    const f = fixture();
    await f.exhaust();
    f.eventStore.mockClear();
    f.readSession.mockClear();
    for (const path of PATHS) {
      const response = await f.request(path, { headers: { accept: "application/json" } });
      expect(response.status, path).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      if (path.endsWith(".rss") || path.endsWith(".ics")) {
        // Throttled feed reads keep the non-HTML contract even for an
        // explicit JSON Accept: plain text, never the envelope or the
        // branded page (same branch shape as the 403/410 feed refusals).
        expect(response.headers.get("content-type")).toMatch(/text\/plain/);
        expect(await response.text()).toBe("Too many requests");
      } else {
        expect(await response.json()).toEqual({
          reason: "rate_limited",
          message: "Too many requests. Try again in 60 seconds.",
          retry_after: 60,
        });
      }
    }
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
    expect(new Set(f.hits.map((hit) => hit.bucket))).toEqual(new Set([`events-read:${IP}`]));
    expect(f.eventStore).not.toHaveBeenCalled();
    expect(f.readSession).not.toHaveBeenCalled();
  });

  it("charges sitemap reads once and refuses before the event scan without XML success headers", async () => {
    const scan = vi.fn(async () => ({ rows: [] }));
    const f = fixture(drizzle(scan) as unknown as Db);
    const admitted = await f.request("/sitemap_index.xml");
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(admitted.headers.get("content-type")).toBe("application/xml; charset=UTF-8");
    expect(f.hits).toEqual([{ bucket: `events-read:${IP}`, at: expect.any(Number) }]);
    expect(scan).toHaveBeenCalledOnce();
    // Spend the rest through another route, then prove both GET and HEAD stop before dbFor.
    f.eventStore.mockReturnValue(null);
    for (let n = 1; n < PUBLIC_EVENT_READS_PER_MINUTE; n++) await f.request("/events");
    f.eventStore.mockReturnValue(drizzle(scan) as unknown as Db);
    f.eventStore.mockClear();
    scan.mockClear();
    for (const method of ["GET", "HEAD"]) {
      const response = await f.request("/sitemap_index.xml", { method });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toEqual(
        method === "HEAD" ? "" : expect.stringContaining("Slow down a little"),
      );
    }
    expect(f.eventStore).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("keeps static sitemap fallback during an outage and leaves static discovery routes unguarded", async () => {
    const f = fixture();
    const missing = await f.request("/sitemap_index.xml");
    expect(missing.status).toBe(200);
    const staticXml = await missing.text();
    expect(staticXml).toContain("<loc>https://next.example.test/events</loc>");
    f.eventStore.mockReturnValue(
      drizzle(async () => {
        throw new Error("DB outage");
      }) as unknown as Db,
    );
    f.env.THROTTLE_STORE = async () => {
      throw new Error("Limiter outage");
    };
    const outage = await f.request("/sitemap_index.xml");
    expect(outage.status).toBe(200);
    expect(outage.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await outage.text()).toBe(staticXml);
    const staticRoutes = fixture();
    await staticRoutes.exhaust();
    staticRoutes.throttleStore.mockClear();
    staticRoutes.eventStore.mockClear();
    for (const path of ["/robots.txt", "/openapi.json"]) {
      expect((await staticRoutes.request(path)).status).toBe(200);
    }
    expect(staticRoutes.throttleStore).not.toHaveBeenCalled();
    expect(staticRoutes.eventStore).not.toHaveBeenCalled();
  });

  it("renders a private branded browser refusal and guards HEAD and island reads", async () => {
    const f = fixture();
    await f.exhaust();
    const browser = await f.request("/events", { headers: { accept: "text/html" } });
    expect(browser.status).toBe(429);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("cache-control")).toBe("no-store, private");
    expect(await browser.text()).toContain("Slow down a little");
    const head = await f.request("/events.rss", { method: "HEAD" });
    expect(head.status).toBe(429);
    expect(await head.text()).toBe("");
    expect(
      (await f.request("/events?q=another", { headers: { "x-two-island": "events-calendar" } }))
        .status,
    ).toBe(429);
  });

  it("keeps clients separate and admits again after the 60-second window", async () => {
    const f = fixture();
    await f.exhaust();
    expect((await f.request("/events")).status).toBe(429);
    expect(
      (await f.request("/events", { headers: { "cf-connecting-ip": "192.0.2.18" } })).status,
    ).toBe(503);
    f.advance(60_001);
    expect((await f.request("/events")).status).toBe(503);
  });

  it("does not change guest refusals on the session-only JSON endpoints", async () => {
    const f = fixture();
    await f.exhaust();
    for (const path of ["/events.json", "/events/01ARZ3NDEKTSV4RRFFQ69G5FAA"]) {
      expect((await f.request(path)).status).toBe(401);
    }
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("preserves the missing/failed limiter store outage behavior without exposing driver errors", async () => {
    const f = fixture();
    f.env.THROTTLE_STORE = async () => null;
    expect((await f.request("/events")).status).toBe(503);
    f.env.THROTTLE_STORE = async () => {
      throw new Error("private driver diagnostic");
    };
    const response = await f.request("/events?q=chess");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Events temporarily unavailable");
    expect(f.hits).toHaveLength(0);
  });

  it("preserves public feed cache headers and conditional 304 responses on admitted requests", async () => {
    const db = drizzle(async () => ({ rows: [] })) as unknown as Db;
    const f = fixture(db);
    for (const path of ["/events.rss", "/events.ics"]) {
      const response = await f.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("max-age=300, public");
      const etag = response.headers.get("etag");
      expect(etag).not.toBeNull();
      const cached = await f.request(path, { headers: { "if-none-match": etag! } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("cache-control")).toBe("max-age=300, public");
    }
    expect(f.hits).toHaveLength(4);
  });
});

describe("event query cost bound", () => {
  it.each(["a", "😀"])(
    "rejects overlong decoded %s queries before any store/session access",
    async (character) => {
      const f = fixture();
      const query = character.repeat(MAX_QUERY_LENGTH + 1);
      const response = await f.request(`/events?q=${encodeURIComponent(query)}`);
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
      expect(f.throttleStore).not.toHaveBeenCalled();
      expect(f.eventStore).not.toHaveBeenCalled();
      expect(f.readSession).not.toHaveBeenCalled();
    },
  );

  it.each(["a".repeat(MAX_QUERY_LENGTH), "😀".repeat(MAX_QUERY_LENGTH), "x", "", "  "])(
    "admits the bounded query %j",
    async (query) => {
      const f = fixture();
      expect((await f.request(`/events?q=${encodeURIComponent(query)}`)).status).toBe(503);
      expect(f.hits).toHaveLength(1);
      expect(f.eventStore).toHaveBeenCalledOnce();
    },
  );

  it("refuses a 9 KB query without reflecting it or touching the database", async () => {
    const f = fixture();
    const response = await f.request(`/events?q=${"sensitive-input".repeat(700)}`);
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("sensitive-input");
    expect(f.throttleStore).not.toHaveBeenCalled();
    expect(f.eventStore).not.toHaveBeenCalled();
  });
});
