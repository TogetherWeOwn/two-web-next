// Warm cookieless responses still spend the shared events-read budget. Only
// admitted hits may skip DB/session/model reads. Serving the cache before the
// guard, charging twice, or replaying the entry's original max-age must fail.
// Every case runs offline; DATABASE_URL selects the same guarded live fixture.
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { createMemorySessionStore } from "../src/sessions";
import { createEventsPerfFixture, type EventsPerfFixture } from "./helpers/events-perf-fixture";

const NOW = new Date("2030-07-04T18:00:00Z");
const IP = "192.0.2.17";
const BUCKET = `events-read:${IP}`;

// Model the real admission SQL boundary, never mock publicReadGuard itself.
function throttleStore() {
  const hits: string[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("SELECT count(*)"))
        return [{ n: hits.filter((bucket) => bucket === values[0]).length, wait: 60 }];
      if (query.includes("INSERT INTO web_throttle_hits")) {
        hits.push(String(values[0]));
        return [];
      }
      if (query.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error(`Unexpected throttle statement: ${query}`);
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  return { hits, store: vi.fn(async () => sql as unknown as Sql) };
}

describe("cookieless /events admitted cache hits", () => {
  let fixture: EventsPerfFixture;

  beforeAll(async () => {
    fixture = await createEventsPerfFixture();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await fixture.reset();
    __resetAnonEventCacheForTests();
    await fixture.seedEvent({ eventKey: "cache-first-0", title: "Cache First" });
    fixture.statements.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetAnonEventCacheForTests();
  });

  function scenario() {
    const throttle = throttleStore();
    const sessions = createMemorySessionStore();
    const sessionGet = vi.spyOn(sessions, "get");
    const discord = { upcoming: vi.fn(async () => []), lastReadFailed: () => false };
    const env = {
      APP_URL: "https://next.example.test",
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      ADMIN_DB: fixture.db,
      SESSION_STORE: sessions,
      DISCORD_EVENTS: discord,
      THROTTLE_STORE: throttle.store,
    } as unknown as Env;
    const request = (method = "GET") =>
      app.request("/events", { method, headers: { "cf-connecting-ip": IP } }, env);
    return { throttle, sessionGet, discord, request };
  }

  it.each(["GET", "HEAD"])(
    "charges one admission for a warm %s and performs no DB/session/model reads",
    async (method) => {
      const f = scenario();
      const first = await f.request();
      expect(first.status).toBe(200);
      expect(f.throttle.store).toHaveBeenCalledTimes(1);
      expect(f.throttle.hits).toEqual([BUCKET]);
      const firstBody = await first.text();
      expect(firstBody).toContain("Cache First");
      expect(first.headers.get("cache-control")).toBe("public, max-age=60");
      fixture.statements.length = 0;
      f.sessionGet.mockClear();
      f.discord.upcoming.mockClear();

      const second = await f.request(method);
      expect(second.status).toBe(200);
      expect(f.throttle.store).toHaveBeenCalledTimes(2);
      expect(f.throttle.hits).toEqual([BUCKET, BUCKET]);
      expect(fixture.statements).toHaveLength(0);
      expect(f.sessionGet).not.toHaveBeenCalled();
      expect(f.discord.upcoming).not.toHaveBeenCalled();
      expect(await second.text()).toBe(method === "HEAD" ? "" : firstBody);
      expect(second.headers.get("vary")).toBe("Cookie, X-Two-Island");
    },
  );

  it.each(["GET", "HEAD"])(
    "refuses a warm %s after the shared bucket is exhausted",
    async (method) => {
      const f = scenario();
      const first = await f.request();
      expect(first.status).toBe(200);
      await first.text();
      // Exhaust the same store while keeping the already-settled cache warm.
      f.throttle.hits.push(...Array<string>(59).fill(BUCKET));
      fixture.statements.length = 0;
      f.sessionGet.mockClear();
      f.discord.upcoming.mockClear();

      const refused = await f.request(method);
      expect(refused.status, "warm cache must never bypass events-read admission").toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect(refused.headers.get("cache-control")).toBe("no-store, private");
      expect(f.throttle.store).toHaveBeenCalledTimes(2);
      expect(f.throttle.hits).toHaveLength(60);
      expect(fixture.statements).toHaveLength(0);
      expect(f.sessionGet).not.toHaveBeenCalled();
      expect(f.discord.upcoming).not.toHaveBeenCalled();
      expect(await refused.text()).not.toContain("Cache First");
    },
  );

  it.each([
    ["GET", 0, 60],
    ["HEAD", 0, 60],
    ["GET", 1_000, 59],
    ["HEAD", 1_000, 59],
    ["GET", 59_000, 1],
    ["HEAD", 59_000, 1],
  ] as const)(
    "warm %s at age %dms advertises only %ds and preserves Vary",
    async (method, age, maxAge) => {
      const f = scenario();
      const first = await f.request();
      expect(first.status).toBe(200);
      const body = await first.text();
      fixture.statements.length = 0;
      f.discord.upcoming.mockClear();
      vi.setSystemTime(new Date(NOW.getTime() + age));

      const hit = await f.request(method);
      expect(hit.status).toBe(200);
      expect(hit.headers.get("cache-control")).toBe(`public, max-age=${maxAge}`);
      expect(hit.headers.get("vary")).toBe("Cookie, X-Two-Island");
      expect(await hit.text()).toBe(method === "HEAD" ? "" : body);
      expect(fixture.statements).toHaveLength(0);
      expect(f.discord.upcoming).not.toHaveBeenCalled();
    },
  );
});
