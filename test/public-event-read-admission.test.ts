import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { PUBLIC_EVENT_READS_PER_MINUTE, registerEventRoutes } from "../src/events/routes";
import { MAX_QUERY_LENGTH } from "../src/events/search-log";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const PATHS = [
  "/events?q=chess",
  "/events/past?page=2",
  "/events.rss",
  "/events.ics",
  "/events/01ARZ3NDEKTSV4RRFFQ69G5FAA.ics",
  "/e/01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
    { begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql) },
  );
  const throttleStore = vi.fn(async () => sql as unknown as Sql);
  const eventStore = vi.fn(() => db);
  const readSession = vi.fn(async () => null);
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, readSession, readSession);
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
      expect(await response.json()).toEqual({
        reason: "rate_limited",
        message: "Too many requests. Try again in 60 seconds.",
        retry_after: 60,
      });
    }
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
    expect(new Set(f.hits.map((hit) => hit.bucket))).toEqual(new Set([`events-read:${IP}`]));
    expect(f.eventStore).not.toHaveBeenCalled();
    expect(f.readSession).not.toHaveBeenCalled();
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
      expect(await response.text()).toBe("Search query must be 255 characters or fewer.");
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
