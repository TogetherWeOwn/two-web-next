import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Sql } from "../src/sessions";
import { normalizeClientIp, throttle, throttleGuard, type EnvWithThrottle } from "../src/throttle";
import { withThrottleTx } from "./helpers/throttle-tx-double";

// Acceptance contract for bounded, attributable throttle client keys.
//
// Bounded: the normalized client segment of every bucket key is at most 64
// characters. The longest valid IP text form is 45 characters (IPv6 with an
// embedded IPv4 tail) and the normalized /64 form is shorter, so a 64-char
// cap can never truncate a valid address; only malformed or hostile
// multi-KB header values are affected. The bound must apply before any
// store call, so these tests capture the bucket argument of every store
// statement (the count read and the hit insert), not just inserted hits.
// The mechanism (truncate, hash, or equivalent) is not pinned: the pinned
// behavior is the length bound, determinism, and that values differing
// inside the bound keep distinct buckets.
//
// Empty hops: an empty or whitespace-only first `x-forwarded-for` hop is
// skipped in favor of the first usable hop, and an empty or whitespace-only
// `cf-connecting-ip` falls through to `x-forwarded-for`. Identifiable
// clients must never collapse into an empty-suffix bucket (`client:`) that
// every headerless or empty-header client would share. Only when no usable
// identity exists at all does the client land in the existing documented
// `anon` fallback bucket, exactly like a request with no identity headers.
//
// Unchanged: `cf-connecting-ip` precedence, IPv6 /64 normalization, IPv4 and
// short malformed passthrough, and no header bytes in logs.

const MAX_CLIENT_SEGMENT = 64;
const BUCKET_PREFIX = "client:";

function fixture() {
  const hits: string[] = [];
  const seen: string[] = [];
  const sql = withThrottleTx((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) {
      seen.push(values[0] as string);
      return [{ n: hits.filter((bucket) => bucket === values[0]).length, wait: 30 }];
    }
    if (query.includes("INSERT INTO web_throttle_hits")) {
      seen.push(values[0] as string);
      hits.push(values[0] as string);
      return [];
    }
    if (query.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql);
  const app = new Hono<{ Bindings: Env }>();
  app.post("/write", throttle("client", 2), (c) => c.body(null, 204));
  app.get("/read", async (c) => (await throttleGuard(c, "client", 2)) ?? c.body(null, 204));
  const env = { THROTTLE_STORE: async () => sql } as EnvWithThrottle;
  const request = (headers: Record<string, string> = {}, path = "/write") =>
    app.request(path, { method: path === "/write" ? "POST" : "GET", headers }, env);
  return { hits, seen, request };
}

function expectEveryBucketBounded(seen: string[]) {
  expect(seen.length).toBeGreaterThan(0);
  for (const bucket of seen) {
    expect(bucket.startsWith(BUCKET_PREFIX)).toBe(true);
    expect(bucket.length).toBeLessThanOrEqual(BUCKET_PREFIX.length + MAX_CLIENT_SEGMENT);
  }
}

describe("normalizeClientIp bounds", () => {
  it.each([
    ["multi-KB token with no colon", "a".repeat(4096)],
    ["multi-KB value with an IPv4-looking prefix", `192.0.2.1${"x".repeat(4096)}`],
    ["multi-KB value with an IPv6-looking prefix", `2001:db8:${"a".repeat(4096)}`],
    ["value one character over the cap", "b".repeat(65)],
  ])("bounds a %s to the fixed cap", (_label, input) => {
    const normalized = normalizeClientIp(input);
    expect(normalized.length).toBeLessThanOrEqual(MAX_CLIENT_SEGMENT);
    expect(normalized).not.toBe(input);
    // Deterministic: the same hostile value always lands in the same bucket.
    expect(normalizeClientIp(input)).toBe(normalized);
  });

  it("keeps values differing inside the bound in distinct buckets", () => {
    const first = normalizeClientIp(`aaaaaaaaaa${"x".repeat(4096)}`);
    const second = normalizeClientIp(`aaaaaaaabb${"x".repeat(4096)}`);
    expect(first).not.toBe(second);
  });

  it.each([
    ["198.51.100.7", "198.51.100.7"],
    ["2001:db8:abcd:1234::1", "2001:db8:abcd:1234::/64"],
    ["2001:db8:abcd:1234:ffff:eeee:dddd:cccc", "2001:db8:abcd:1234::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["not-an-ip", "not-an-ip"],
    ["c".repeat(64), "c".repeat(64)],
  ])("leaves in-bound input %s unchanged in behavior", (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });
});

describe("throttle client key bounds at the store seam", () => {
  it("bounds a multi-KB x-forwarded-for first hop before any store call", async () => {
    const { request, seen } = fixture();
    const hostile = "a".repeat(4096);
    expect((await request({ "x-forwarded-for": hostile })).status).toBe(204);
    expectEveryBucketBounded(seen);
    for (const bucket of seen) expect(bucket).not.toContain(hostile);
  });

  it("bounds a multi-KB cf-connecting-ip value before any store call", async () => {
    const { request, seen } = fixture();
    const hostile = "d".repeat(4096);
    expect((await request({ "cf-connecting-ip": hostile })).status).toBe(204);
    expectEveryBucketBounded(seen);
    for (const bucket of seen) expect(bucket).not.toContain(hostile);
  });

  it("bounds the key in the guard form as well as the middleware form", async () => {
    const { request, seen } = fixture();
    const hostile = "e".repeat(8192);
    expect((await request({ "x-forwarded-for": hostile }, "/read")).status).toBe(204);
    expectEveryBucketBounded(seen);
  });

  it("keeps distinct budgets for multi-KB values differing inside the bound", async () => {
    const { request, hits } = fixture();
    const first = `aaaaaaaaaa${"x".repeat(4096)}`;
    const second = `aaaaaaaabb${"x".repeat(4096)}`;
    expect((await request({ "x-forwarded-for": first })).status).toBe(204);
    expect((await request({ "x-forwarded-for": first })).status).toBe(204);
    expect((await request({ "x-forwarded-for": first })).status).toBe(429);
    expect((await request({ "x-forwarded-for": second })).status).toBe(204);
    expect(new Set(hits).size).toBe(2);
    expectEveryBucketBounded(hits);
  });

  it("does not write header bytes to any console log channel", async () => {
    const { request } = fixture();
    const sentinel = `SENTINEL${"z".repeat(2048)}`;
    const channels = (["log", "info", "warn", "error"] as const).map((channel) =>
      vi.spyOn(console, channel).mockImplementation(() => {}),
    );
    try {
      expect((await request({ "x-forwarded-for": sentinel })).status).toBe(204);
      expect((await request({ "x-forwarded-for": "" })).status).toBe(204);
      const logged = channels
        .flatMap((spy) => spy.mock.calls.flatMap((call) => call.map(String)))
        .join("\n");
      expect(logged).not.toContain("SENTINEL");
    } finally {
      for (const spy of channels) spy.mockRestore();
    }
  });
});

describe("empty off-edge identity", () => {
  it("skips an empty first hop and buckets on the first usable hop", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(429);
    expect(hits).toEqual(["client:192.0.2.9", "client:192.0.2.9"]);
  });

  it("gives clients behind empty first hops distinct budgets", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": ", 192.0.2.9" })).status).toBe(429);
    // A different client whose first hop is also empty must not inherit the
    // exhausted budget through a shared empty-suffix bucket.
    expect((await request({ "x-forwarded-for": ", 192.0.2.10" })).status).toBe(204);
    expect(hits.at(-1)).toBe("client:192.0.2.10");
  });

  it("normalizes a usable IPv6 hop found after empty hops", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": "  , , 2001:db8:1:3::1" })).status).toBe(204);
    expect(hits).toEqual(["client:2001:db8:1:3::/64"]);
  });

  it.each(["", "   ", ",", " , , "])(
    "maps a wholly empty x-forwarded-for %j to the anon fallback, never an empty bucket",
    async (xff) => {
      const { request, hits, seen } = fixture();
      expect((await request({ "x-forwarded-for": xff })).status).toBe(204);
      expect((await request({ "x-forwarded-for": xff })).status).toBe(204);
      expect((await request({ "x-forwarded-for": xff })).status).toBe(429);
      expect(hits).toEqual(["client:anon", "client:anon"]);
      expect(seen).not.toContain("client:");
    },
  );

  it("falls through an empty cf-connecting-ip to the x-forwarded-for hop", async () => {
    const { request, hits } = fixture();
    expect(
      (await request({ "cf-connecting-ip": "", "x-forwarded-for": "192.0.2.20" })).status,
    ).toBe(204);
    expect(hits).toEqual(["client:192.0.2.20"]);
  });

  it("falls through a whitespace-only cf-connecting-ip to the x-forwarded-for hop", async () => {
    const { request, hits } = fixture();
    expect(
      (await request({ "cf-connecting-ip": "   ", "x-forwarded-for": "2001:db8:1:4::1" })).status,
    ).toBe(204);
    expect(hits).toEqual(["client:2001:db8:1:4::/64"]);
  });

  it("maps whitespace-only identity headers to the anon fallback", async () => {
    const { request, hits, seen } = fixture();
    expect((await request({ "cf-connecting-ip": " ", "x-forwarded-for": " " })).status).toBe(204);
    expect(hits).toEqual(["client:anon"]);
    expect(seen).not.toContain("client:");
    expect(seen).not.toContain("client: ");
  });
});

describe("unchanged client-key behavior (positive controls)", () => {
  it("keeps cf-connecting-ip precedence over x-forwarded-for", async () => {
    const { request, hits } = fixture();
    expect(
      (await request({ "cf-connecting-ip": "192.0.2.30", "x-forwarded-for": "192.0.2.31" })).status,
    ).toBe(204);
    expect(hits).toEqual(["client:192.0.2.30"]);
  });

  it("keeps the first non-empty hop winning over later hops", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": "192.0.2.40, 192.0.2.41" })).status).toBe(204);
    expect(hits).toEqual(["client:192.0.2.40"]);
  });

  it("trims whitespace around a usable first hop", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": "  192.0.2.50  , 192.0.2.51" })).status).toBe(204);
    expect(hits).toEqual(["client:192.0.2.50"]);
  });

  it("keeps the headerless anonymous fallback in one bucket", async () => {
    const { request, hits } = fixture();
    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(429);
    expect(hits).toEqual(["client:anon", "client:anon"]);
  });

  it("keeps IPv6 /64 sharing through x-forwarded-for", async () => {
    const { request, hits } = fixture();
    expect((await request({ "x-forwarded-for": "2001:db8:1:5::1" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": "2001:db8:1:5::2" })).status).toBe(204);
    expect((await request({ "x-forwarded-for": "2001:db8:1:5::3" })).status).toBe(429);
    expect(hits).toEqual(["client:2001:db8:1:5::/64", "client:2001:db8:1:5::/64"]);
  });
});
