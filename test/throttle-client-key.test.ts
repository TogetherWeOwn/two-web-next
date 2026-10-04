import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { Sql } from "../src/sessions";
import { throttle, throttleGuard, type EnvWithThrottle } from "../src/throttle";
import { withThrottleTx } from "./helpers/throttle-tx-double";

function fixture() {
  const hits: string[] = [];
  const sql = withThrottleTx((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)"))
      return [{ n: hits.filter((bucket) => bucket === values[0]).length, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) {
      hits.push(values[0] as string);
      return [];
    }
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql);
  const app = new Hono<{ Bindings: Env }>();
  app.post("/write", throttle("client", 2), (c) => c.body(null, 204));
  app.get("/read", async (c) => (await throttleGuard(c, "client", 2)) ?? c.body(null, 204));
  const env = { THROTTLE_STORE: async () => sql } as EnvWithThrottle;
  const request = (headers: Record<string, string> = {}, path = "/write") =>
    app.request(path, { method: path === "/write" ? "POST" : "GET", headers }, env);
  const from = (ip: string, path?: string) => request({ "cf-connecting-ip": ip }, path);
  return { hits, request, from };
}

describe("throttle client address keys", () => {
  it("shares a /64 budget across changing IPv6 interface identifiers in both guard forms", async () => {
    const { from, hits } = fixture();
    expect((await from("2001:db8:abcd:1234::1")).status).toBe(204);
    expect((await from("2001:db8:abcd:1234:ffff:eeee:dddd:cccc", "/read")).status).toBe(204);
    const limited = await from("2001:db8:abcd:1234::3");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect((await from("2001:db8:abcd:1234::4", "/read")).status).toBe(429);
    expect(hits).toEqual(["client:2001:db8:abcd:1234::/64", "client:2001:db8:abcd:1234::/64"]);
  });

  it("keeps adjacent /64 prefixes independent", async () => {
    const { from, hits } = fixture();
    for (let i = 0; i < 2; i++) expect((await from("2001:db8:abcd:1234::1")).status).toBe(204);
    expect((await from("2001:db8:abcd:1234::2")).status).toBe(429);
    expect((await from("2001:db8:abcd:1235::1")).status).toBe(204);
    expect(hits.at(-1)).toBe("client:2001:db8:abcd:1235::/64");
  });

  it.each([
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::abcd", "2001:db8:0:0::/64"],
    ["2001:db8:0:1::", "2001:0db8:0000:0001:0000:0000:0000:ffff", "2001:db8:0:1::/64"],
    ["::1", "0:0:0:0:ffff:1234:5678:9abc", "0:0:0:0::/64"],
    ["::", "0:0:0:0:0:0:0:0", "0:0:0:0::/64"],
    ["2001:db8:1:2::192.0.2.1", "2001:db8:1:2::c633:6401", "2001:db8:1:2::/64"],
  ])("canonicalizes %s and %s to the same prefix", async (first, second, prefix) => {
    const { from, hits } = fixture();
    expect((await from(first)).status).toBe(204);
    expect((await from(second)).status).toBe(204);
    expect((await from(first)).status).toBe(429);
    expect(hits).toEqual([`client:${prefix}`, `client:${prefix}`]);
  });

  it.each(["::ffff:192.0.2.1", "::FFFF:c000:0201", "0:0:0:0:0:ffff:c000:201"])(
    "shares mapped address %s with its native IPv4 budget",
    async (mapped) => {
      const { from, hits } = fixture();
      expect((await from("192.0.2.1")).status).toBe(204);
      expect((await from(mapped)).status).toBe(204);
      expect((await from("192.0.2.1")).status).toBe(429);
      expect(hits).toEqual(["client:192.0.2.1", "client:192.0.2.1"]);
      expect((await from("::ffff:192.0.2.2")).status).toBe(204);
      expect(hits.at(-1)).toBe("client:192.0.2.2");
    },
  );

  it("leaves native IPv4 keys and separate address budgets unchanged", async () => {
    const { from, hits } = fixture();
    for (let i = 0; i < 2; i++) expect((await from("198.51.100.7")).status).toBe(204);
    expect((await from("198.51.100.7")).status).toBe(429);
    expect((await from("198.51.100.8")).status).toBe(204);
    expect(hits).toEqual(["client:198.51.100.7", "client:198.51.100.7", "client:198.51.100.8"]);
  });

  it("preserves the edge-header precedence and normalizes the off-edge first-hop fallback", async () => {
    const { request, hits } = fixture();
    await request({ "cf-connecting-ip": "2001:db8:1:2::1", "x-forwarded-for": "192.0.2.1" });
    await request({ "cf-connecting-ip": "2001:db8:1:2::2", "x-forwarded-for": "192.0.2.2" });
    expect((await request({ "cf-connecting-ip": "2001:db8:1:2::3" })).status).toBe(429);
    await request({ "x-forwarded-for": "2001:db8:1:3::1, 192.0.2.1" });
    await request({ "x-forwarded-for": "2001:db8:1:3::2, 192.0.2.2" });
    expect((await request({ "x-forwarded-for": "2001:db8:1:3::3, 192.0.2.3" })).status).toBe(429);
    expect(hits).toEqual([
      "client:2001:db8:1:2::/64",
      "client:2001:db8:1:2::/64",
      "client:2001:db8:1:3::/64",
      "client:2001:db8:1:3::/64",
    ]);
  });

  it("keeps the anonymous fallback in one bucket", async () => {
    const { request, hits } = fixture();
    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(429);
    expect(hits).toEqual(["client:anon", "client:anon"]);
  });

  it.each([
    "not-an-ip",
    "2001:db8:::1",
    "2001:db8::1::2",
    "2001:db8:gggg::1",
    "::ffff:999.0.2.1",
    "::1]/path?[",
  ])("keeps malformed input %s unchanged without bypassing the store", async (ip) => {
    const { from, hits } = fixture();
    expect((await from(ip)).status).toBe(204);
    expect((await from(ip)).status).toBe(204);
    expect((await from(ip)).status).toBe(429);
    expect(hits).toEqual([`client:${ip}`, `client:${ip}`]);
  });
});
