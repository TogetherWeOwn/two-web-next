// Acceptance: public 429s validate the RAW upstream Retry-After header.
//
// Companion to public-429-retry-after-validation-acceptance.test.ts. That
// file drives the real throttle chain; this one injects raw upstream
// `retry-after` header strings at the guard boundary admitted() re-reads
// (publicReadGuard), because the throttle chain coalesces some shapes
// before admitted() sees them. The contract under test is the admission
// itself:
//
//   admitted() must pass the upstream header through the shared
//   parseRetryAfterSeconds parser and use the ONE validated value for
//   both the envelope message and the response `retry-after` header:
//     - "42"            -> 42   (usable delta-seconds pass through)
//     - "2.5"           -> 3    (fractions round UP, never retry early)
//     - "999999"        -> 86400 (absurd values cap, never echo raw)
//     - garbage, HTTP dates, signed/exponent/unit text, "0", missing
//                       -> 60   (fallback only when absent/unparseable)
//   Raw upstream text must never appear in the response body.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { EnvWithThrottle } from "../src/throttle";

const upstream = vi.hoisted(() => ({
  limited: true,
  header: null as string | null,
}));

vi.mock("../src/events/routes-shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/events/routes-shared")>();
  return {
    ...original,
    publicReadGuard: async () =>
      upstream.limited
        ? new Response("limited", {
            status: 429,
            headers: upstream.header === null ? {} : { "retry-after": upstream.header },
          })
        : null,
  };
});

// Imported after the mock is registered so the routes close over the stub.
const { registerPublicApiRoutes } = await import("../src/public-data/routes");

const env = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/test-invite",
} as unknown as EnvWithThrottle;

function app() {
  const a = new Hono<{ Bindings: Env }>();
  registerPublicApiRoutes(a);
  return a;
}

const get = (path: string) =>
  app().request(path, { headers: { "cf-connecting-ip": "192.0.2.91" } }, env);

describe("public 429 Retry-After validation (raw upstream header)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
    upstream.limited = true;
    upstream.header = null;
  });

  it.each([
    ["42", 42],
    ["1", 1],
    ["2.5", 3],
    ["0.2", 1],
    ["999999", 86_400],
    ["86400", 86_400],
    ["86401", 86_400],
    ["0", 60],
    ["-5", 60],
    ["garbage-marker", 60],
    ["42 seconds", 60],
    ["1e3", 60],
    ["Wed, 21 Oct 2015 07:28:00 GMT", 60],
    ["", 60],
  ])("upstream retry-after %j validates to %i in both message and header", async (raw, seconds) => {
    upstream.header = raw as string;
    const res = await get("/api/public/events");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(seconds));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        message: `Too many requests. Try again in ${seconds} seconds.`,
      },
    });
    // The raw upstream text is never reflected when it was not admitted.
    // (Only distinctive non-numeric raws: "0" is a substring of "60".)
    if (String(seconds) !== raw && /[a-z]/i.test(raw as string))
      expect(body.error.message).not.toContain(raw as string);
  });

  it("falls back to 60 when the upstream 429 carries no retry-after header", async () => {
    upstream.header = null;
    const res = await get("/api/public/events");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again in 60 seconds.",
      },
    });
  });

  it("validates on every public route, not only the collection", async () => {
    upstream.header = "garbage-marker";
    for (const path of [
      "/api/public/events",
      "/api/public/events/00000000000000000000000001",
      "/api/public/community",
      "/api/public/join",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after"), path).toBe("60");
      expect(await res.text(), path).not.toContain("garbage-marker");
    }
  });

  it("positive control: no upstream refusal serves the normal 200 join handoff", async () => {
    upstream.limited = false;
    const res = await get("/api/public/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    const body = (await res.json()) as { invite_url?: unknown };
    expect(body.invite_url).toBe("https://discord.gg/test-invite");
  });
});
