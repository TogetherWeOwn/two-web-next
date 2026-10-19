// Throttled feed reads answer 429 text/plain, not the branded HTML page.
//
// Feed routes sit behind the shared public-read budget (publicReadGuard
// before dbFor on /events.rss, /events.ics and /events/:file.ics), and the
// shared rateLimitExceeded answered every non-JSON caller with the branded
// page — so a throttled feed reader's parser received HTML. Feed contracts
// stay non-HTML (the 403/410 isFeedErrorPath branch): these pins drive the
// real feed and event Markdown routes with an exhausted budget and assert
// 429 text/plain with unchanged Retry-After, no-store/private cache-control
// and Vary: Accept. Dropping the .md alternative must fail the Markdown rows.
// Hermetic: memory throttle store, no DB reads (the guard refuses first),
// session reads forbidden, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAiFriendlyRoutes } from "../src/ai-friendly/routes";
import type { Env } from "../src/env";
import { rateLimitExceeded } from "../src/errors";
import { registerFeedRoutes } from "../src/events/routes-feeds";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const IP = "192.0.2.44";
const WAIT = 42;
const FEED_429_BODY = "Too many requests";

function memoryThrottleSql(limited: boolean) {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        return [{ n: limited ? 999 : 0, wait: WAIT }];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) return [];
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  return sql as unknown as Sql;
}

function feedApp(limited: boolean) {
  const app = new Hono<{ Bindings: Env }>();
  registerAiFriendlyRoutes(app);
  registerFeedRoutes(app, async () => {
    throw new Error("throttled feed reads must not touch the session");
  });
  const env = {
    APP_URL: "https://next.example.test",
    THROTTLE_STORE: async () => memoryThrottleSql(limited),
  } as unknown as EnvWithThrottle;
  const get = (path: string, accept?: string) =>
    app.request(path, { headers: { "cf-connecting-ip": IP, ...(accept ? { accept } : {}) } }, env);
  return { get };
}

async function expectFeed429(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  expect(res.headers.get("content-type")).not.toMatch(/text\/html/);
  expect(res.headers.get("retry-after")).toBe(String(WAIT));
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(res.headers.get("vary")).toBe("Accept");
  const body = await res.text();
  expect(body).toBe(FEED_429_BODY);
  expect(body).not.toContain("recovery-code");
  expect(body).not.toContain("Slow down");
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("feed throttle fixtures must remain offline");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("throttled feed reads", () => {
  it.each(["/events.rss", "/events.ics", "/events/definitely-not-a-key.ics"])(
    "answers %s as 429 text/plain with unchanged throttle headers",
    async (path) => {
      await expectFeed429(await feedApp(true).get(path));
    },
  );

  it.each([
    "text/html",
    "application/rss+xml, application/xml, text/xml",
    "text/calendar",
    "application/json",
    "*/*",
  ])("keeps /events.rss non-HTML when Accept is %s", async (accept) => {
    // The feed contract wins over content negotiation — mirroring the
    // 403/410 feed branch, which also answers before the JSON check — so
    // even an explicit JSON Accept on a feed path stays plain text.
    await expectFeed429(await feedApp(true).get("/events.rss", accept));
  });

  it("keeps the per-event feed non-HTML for a browser-like Accept", async () => {
    await expectFeed429(await feedApp(true).get("/events/definitely-not-a-key.ics", "text/html"));
  });

  it("positive control: an unexhausted budget passes the guard to the 503 no-DB path", async () => {
    // No DATABASE_URL here, so a request that clears the guard reaches
    // dbFor -> null -> eventsUnavailable. This proves the 429s above come
    // from the exhausted budget, not from another refusal.
    const res = await feedApp(false).get("/events.rss");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Events temporarily unavailable");
  });
});

describe.each(["/events.md", "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV.md"])(
  "throttled Markdown reads on %s",
  (path) => {
    it.each([undefined, "text/markdown", "text/html", "application/json", "*/*"])(
      "keeps 429 text/plain with unchanged headers when Accept is %s",
      async (accept) => {
        await expectFeed429(await feedApp(true).get(path, accept));
      },
    );

    it("positive control: an unexhausted budget reaches the Markdown 503 no-DB path", async () => {
      const res = await feedApp(false).get(path);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
      expect(await res.text()).toBe("Events temporarily unavailable");
    });
  },
);

describe("non-feed 429 representations (unchanged)", () => {
  function directApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/limited", (c) => rateLimitExceeded(c, WAIT));
    const env = { APP_URL: "https://next.example.test" } as Env;
    return {
      get: (accept?: string) => app.request("/limited", { headers: accept ? { accept } : {} }, env),
    };
  }

  it("keeps the branded page for browser 429s with unchanged headers", async () => {
    const res = await directApp().get();
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(await res.text()).toContain("Slow down a little");
  });

  it("keeps the JSON envelope for JSON callers", async () => {
    const res = await directApp().get("application/json");
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(await res.json()).toEqual({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${WAIT} seconds.`,
      retry_after: WAIT,
    });
  });
});
