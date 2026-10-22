// Feed 503 JSON negotiation pins: explicit JSON exclusion stays plaintext.
//
// unavailableFeed answers the structured envelope only when the caller
// explicitly lists application/json with q>0, using the same quality grammar
// as jsonSession (whitespace-tolerant `q =` separator, at most one q per
// range). q=0-excluded, whitespace-q, multi-q, absent and feed-native callers
// stay on the plaintext feed contract, no-store either way. Hermetic: memory
// throttle store, no DB reads (the guard passes, dbFor resolves null, the
// route answers eventsUnavailable), session reads forbidden, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { registerFeedRoutes } from "../src/events/routes-feeds";
import { requestLog } from "../src/request-log";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const IP = "192.0.2.44";
const RAY = "0123456789abcdef";
const UNAVAILABLE = "Events temporarily unavailable";

function memoryThrottleSql() {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        return [{ n: 0, wait: 0 }];
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

function feedApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use(requestLog);
  registerFeedRoutes(app, async () => {
    throw new Error("feed 503 fixtures must not touch the session");
  });
  const env = {
    APP_URL: "https://next.example.test",
    THROTTLE_STORE: async () => memoryThrottleSql(),
  } as unknown as EnvWithThrottle;
  const get = (path: string, accept?: string) =>
    app.request(
      path,
      {
        headers: {
          "cf-connecting-ip": IP,
          "cf-ray": RAY,
          ...(accept ? { accept } : {}),
        },
      },
      env,
    );
  return { get };
}

async function expectPlaintext503(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("vary")).toContain("Accept");
  expect(await res.text()).toBe(UNAVAILABLE);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("feed 503 fixtures must remain offline");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("feed 503 JSON negotiation", () => {
  it.each([
    "application/json;q=0",
    "application/json;q=0, */*;q=1",
    "application/json; q = 0",
    "application/json;q =0",
    "application/json;q=1;q=0",
  ])("stays plaintext on /events.rss when Accept is %s", async (accept) => {
    await expectPlaintext503(await feedApp().get("/events.rss", accept));
  });

  it("stays plaintext on /events.ics for q=0-excluded JSON", async () => {
    await expectPlaintext503(await feedApp().get("/events.ics", "application/json;q=0"));
  });

  it("stays plaintext when Accept is absent", async () => {
    await expectPlaintext503(await feedApp().get("/events.rss"));
  });

  it.each(["application/json", "application/json;q=0.5"])(
    "answers the JSON envelope on /events.rss when Accept is %s",
    async (accept) => {
      const res = await feedApp().get("/events.rss", accept);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("vary")).toContain("Accept");
      expect(res.headers.get("x-request-id")).toBe(RAY);
      const body = (await res.json()) as {
        error: { code: string; message: string; request_id: string; next: string };
      };
      expect(body.error.code).toBe("unavailable");
      expect(body.error.message).toBe(UNAVAILABLE);
      expect(body.error.request_id).toBe(RAY);
      expect(typeof body.error.next).toBe("string");
      expect(body.error.next.length).toBeGreaterThan(0);
    },
  );
});
