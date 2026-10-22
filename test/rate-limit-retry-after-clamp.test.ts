// Pins the 429 Retry-After clamp edges in `rateLimitExceeded`
// (src/error-responses.tsx:96-99 at 33114c2): Math.floor, non-finite -> 60,
// Math.max(1, ...). Every caller passes store/provider values through
// unchecked (src/throttle.ts:102, src/profiles/routes-admission.ts:31,
// src/events/routes-rsvp.tsx:88,119, src/join/route-shared.ts:88) and the
// only existing pins feed retry_after 30/45, so the clamp branches never
// execute. These unit pins drive rateLimitExceeded directly with the edge
// inputs and assert the Retry-After header and the retry_after body agree,
// with the {reason, message} envelope unchanged. Hermetic: local Hono
// fixture, no requestLog (so no request_id), no DB, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { rateLimitExceeded } from "../src/errors";

const env = {
  APP_URL: "https://example.test",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
} as Env;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("retry-after clamp fixtures must remain offline");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function clampedResponse(retryAfter: number): Promise<Response> {
  const fixture = new Hono();
  fixture.get("/limited", (c) => rateLimitExceeded(c, retryAfter));
  return fixture.request("/limited", { headers: { accept: "application/json" } }, env);
}

async function expectClamped(retryAfter: number, expected: number): Promise<void> {
  const res = await clampedResponse(retryAfter);
  expect(res.status).toBe(429);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("retry-after")).toBe(String(expected));
  expect(await res.json()).toEqual({
    code: "rate_limited",
    reason: "rate_limited",
    message: `Too many requests. Try again in ${expected} seconds.`,
    retry_after: expected,
    next: "Wait for Retry-After, then retry.",
  });
}

describe("rateLimitExceeded Retry-After clamp edges", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [0.5, 1],
    [Number.NaN, 60],
    [Number.POSITIVE_INFINITY, 60],
    [Number.NEGATIVE_INFINITY, 60],
    [1.9, 1],
  ])("clamps retryAfter %s to %s in the header and envelope", async (input, expected) => {
    await expectClamped(input, expected);
  });

  it("negative control: a normal 30 passes through unclamped", async () => {
    await expectClamped(30, 30);
  });
});
