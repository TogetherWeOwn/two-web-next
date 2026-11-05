import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Model the generated local build's compile-time define. It is captured once
// at module evaluation, not read from a runtime binding or request header.
let app: typeof import("../src/index").default;
let clock: typeof import("../src/render-clock");
let archive: typeof import("../src/kit-past-events");
let cache: typeof import("../src/events/anon-cache");
beforeAll(async () => {
  vi.stubGlobal("__TWO_LOCAL_CAPTURE__", true);
  try {
    clock = await import("../src/render-clock");
    app = (await import("../src/index")).default;
    archive = await import("../src/kit-past-events");
    cache = await import("../src/events/anon-cache");
  } finally {
    vi.unstubAllGlobals();
  }
});
afterEach(() => {
  vi.useRealTimers();
  cache.__resetAnonEventCacheForTests();
});
const APP_URL = "http://127.0.0.1:8788";
const env = { APP_URL, SSR_CAPTURE_FIXTURE: "true" } as Env;
const request = (path: string) => new Request(APP_URL + path);

describe("local capture request integration", () => {
  it("certifies real Hono static HTML and refuses uncovered document rows", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.request(
          request("/faq"),
          undefined,
          i % 2 ? env : { ...env, SSR_CAPTURE_FIXTURE: "false" },
        ),
      ),
    );
    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(response.headers.get(clock.SSR_CAPTURE_HEADER)).toBe(
        i % 2 ? clock.SSR_CAPTURE_INSTANT : null,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const refusal = await app.request(request("/profile"), undefined, env);
    expect(refusal.status).toBe(412);
    expect(refusal.headers.has(clock.SSR_CAPTURE_HEADER)).toBe(false);
    expect(refusal.headers.get("x-content-type-options")).toBe("nosniff");
    const asset = await app.request(request("/islands/example.js"), undefined, env);
    expect(asset.status).not.toBe(412);
    expect(asset.headers.has(clock.SSR_CAPTURE_HEADER)).toBe(false);
  });

  it("preserves the Hono host guard despite a fixture flag and spoofed request header", async () => {
    const response = await app.request(
      new Request("https://example.test/faq", {
        headers: { host: "127.0.0.1:8788", origin: APP_URL, "x-forwarded-host": "127.0.0.1:8788" },
      }),
      undefined,
      env,
    );
    expect(response.headers.has(clock.SSR_CAPTURE_HEADER)).toBe(false);
  });

  it("neither reads live archive cache entries nor writes frozen bytes into the cache", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const archiveEnv = { ...env, DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next" };
    const source = cache.anonCacheSource(archiveEnv);
    const key = cache.anonPastKey("GET", 1);
    cache.writeAnonCache(
      key,
      source,
      { status: 200, body: "live cache", cacheControl: "public, max-age=300", vary: "Cookie" },
      cache.ANON_PAST_TTL_MS,
    );
    const resolve = vi.fn(
      async () =>
        new Response("frozen render", {
          headers: {
            "content-type": "text/html",
            "x-two-past-cacheable": "true",
            "cache-control": "public, max-age=300",
          },
        }),
    );
    const guard = vi.fn(async () => null);
    const response = await archive.dispatchPastArchiveRequest(
      request("/events/past"),
      archiveEnv,
      resolve,
      guard,
    );
    expect(await response.text()).toBe("frozen render");
    expect(resolve).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
    expect(cache.readAnonCache(key, source)?.body).toBe("live cache");
    cache.__resetAnonEventCacheForTests();
    await archive.dispatchPastArchiveRequest(request("/events/past"), archiveEnv, resolve, guard);
    expect(cache.readAnonCache(key, source)).toBeNull();
    const live = await archive.dispatchPastArchiveRequest(
      request("/events/past"),
      { ...archiveEnv, SSR_CAPTURE_FIXTURE: "false" },
      async () =>
        new Response("live render", {
          headers: { "x-two-past-cacheable": "true", "cache-control": "public, max-age=300" },
        }),
      guard,
    );
    expect(await live.text()).toBe("live render");
    expect(cache.readAnonCache(key, source)?.body).toBe("live render");
    expect(Date.now()).toBe(new Date("2030-01-01T00:00:00Z").getTime());
  });
});
