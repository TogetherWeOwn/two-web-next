// route-inventory: POST /api/agent-events
// Acceptance contract: normalize the anonymous shield bucket key.
//
// The outer agent-events shield must bucket anonymous hits the same way the
// human throttle buckets its clients (`src/throttle.ts` `clientKey`), instead
// of spending one bucket per raw address:
//
// - IPv6 clients share their /64: the stored bucket is
//   `shield:ip:<first-four-pieces>::/64`, whatever the spelling or interface
//   identifier of the presented address.
// - An IPv4-mapped IPv6 address shares the native IPv4 bucket
//   (`shield:ip:<a.b.c.d>`); a native IPv4 address is unchanged.
// - A malformed off-edge value is preserved verbatim, as the human throttle
//   preserves it, so it still spends its own bucket instead of bypassing
//   the store.
// - Select the trimmed nonblank `cf-connecting-ip`, else the first nonblank
//   trimmed `x-forwarded-for` hop, matching the existing human-route policy.
//   With no usable address, keep `shield:ip:unknown` (not human `anon` or an
//   empty suffix). This is off-edge consistency, not a new header trust model.
// - Preserve the 64-character segment cap after selecting and normalizing.
// - Credentialed hits keep bucketing on the credential hash
//   (`shield:<sha256>`), untouched by the client address.
// - Distinct /64 prefixes keep independent budgets.
//
// Hermetic and DB-free: the in-memory fake agent-event store records every
// shield bucket write, so the exact stored keys and the 429 burst behaviour
// are observed directly with no DATABASE_URL, network, or Discord access.
import { describe, expect, it } from "vitest";
import {
  admitAgentEvent,
  DEFAULT_CONFIG,
  handleAgentEvent,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import type { Env } from "../src/env";
import app from "./app";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";

const cfg = (routePerMinute: number): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 1500,
  routePerMinute,
});

let n = 0;
const key = () => `shield-bucket-key-${++n}`;

/** Admit one anonymous hit against a loose budget and return the shield buckets it wrote. */
async function admittedBuckets(ip: string | null, credential: string | null = null) {
  const fake = makeFakeAgentDb();
  const admitted = await admitAgentEvent(fake.sql, cfg(60), credential, ip);
  expect("handle" in admitted).toBe(true);
  return fake.hits.map((hit) => hit.bucket);
}

describe("anonymous shield bucket key derivation", () => {
  it.each([
    ["2001:db8:abcd:1234::1", "shield:ip:2001:db8:abcd:1234::/64"],
    ["2001:db8:abcd:1234:ffff:eeee:dddd:cccc", "shield:ip:2001:db8:abcd:1234::/64"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "shield:ip:2001:db8:0:0::/64"],
    ["::ffff:192.0.2.1", "shield:ip:192.0.2.1"],
    ["198.51.100.7", "shield:ip:198.51.100.7"],
    ["not-an-ip", "shield:ip:not-an-ip"],
  ])("buckets %s as %s", async (ip, bucket) => {
    expect(await admittedBuckets(ip)).toEqual([bucket]);
  });

  it("buckets a missing address as unknown", async () => {
    expect(await admittedBuckets(null)).toEqual(["shield:ip:unknown"]);
  });

  it("keeps credentialed hits on the credential hash, whatever the address", async () => {
    const credential = "shield-bucket-credential";
    const expected = [`shield:${await sha256Hex(credential)}`];
    expect(await admittedBuckets("2001:db8:abcd:1234::1", credential)).toEqual(expected);
    expect(await admittedBuckets("198.51.100.7", credential)).toEqual(expected);
    expect(await admittedBuckets(null, credential)).toEqual(expected);
  });
});

describe("anonymous shield burst across one /64", () => {
  it("refuses the burst once two addresses in the same /64 spend the shared budget", async () => {
    const fake = makeFakeAgentDb();
    const call = (ip: string) =>
      handleAgentEvent(fake.sql, cfg(2), { op: "create", idempotency_key: key() }, null, ip);

    expect((await call("2001:db8:abcd:1234::1")).status).toBe(401);
    expect((await call("2001:db8:abcd:1234:ffff:eeee:dddd:cccc")).status).toBe(401);

    const refused = await call("2001:db8:abcd:1234::3");
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(refused.headers?.["Retry-After"]).toBeTruthy();
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([
      "shield:ip:2001:db8:abcd:1234::/64",
      "shield:ip:2001:db8:abcd:1234::/64",
    ]);
    // The refused hit wrote no audit row: pre-auth refusals write none,
    // so neither admitted hit did either.
    expect(fake.audits.filter((audit) => audit.reason === "unauthenticated")).toHaveLength(0);
  });

  it("keeps a distinct /64 on its own budget while its neighbour is spent", async () => {
    const fake = makeFakeAgentDb();
    const call = (ip: string) =>
      handleAgentEvent(fake.sql, cfg(2), { op: "create", idempotency_key: key() }, null, ip);

    expect((await call("2001:db8:abcd:1234::1")).status).toBe(401);
    expect((await call("2001:db8:abcd:1234::2")).status).toBe(401);
    expect((await call("2001:db8:abcd:1234::3")).status).toBe(429);
    expect((await call("2001:db8:abcd:1235::1")).status).toBe(401);
    expect(fake.hits.at(-1)?.bucket).toBe("shield:ip:2001:db8:abcd:1235::/64");
  });
});

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

function routeEnv(fake: FakeAgentDb) {
  return {
    APP_URL: "https://next.example.test",
    AGENT_EVENTS_ENABLED: "true",
    AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
    AGENT_EVENTS_ROUTE_PER_MINUTE: "2",
    AGENT_EVENT_SQL: fake.sql,
  } as unknown as Env;
}

const postAnonymous = (fake: FakeAgentDb, headers: Record<string, string>) =>
  app.request(
    "/api/agent-events",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ op: "create", idempotency_key: key() }),
    },
    routeEnv(fake),
    executionCtx,
  );

describe("agent-events route client address for the shield", () => {
  it("falls back to the first x-forwarded-for hop when cf-connecting-ip is absent", async () => {
    const fake = makeFakeAgentDb();

    expect(
      (await postAnonymous(fake, { "x-forwarded-for": "2001:db8:1:3::1, 192.0.2.1" })).status,
    ).toBe(401);
    expect(
      (await postAnonymous(fake, { "x-forwarded-for": "2001:db8:1:3::2, 192.0.2.2" })).status,
    ).toBe(401);

    const refused = await postAnonymous(fake, {
      "x-forwarded-for": "2001:db8:1:3::3, 192.0.2.3",
    });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { reason: string }).reason).toBe("rate_limited");
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([
      "shield:ip:2001:db8:1:3::/64",
      "shield:ip:2001:db8:1:3::/64",
    ]);
  });

  it("prefers cf-connecting-ip over x-forwarded-for", async () => {
    const fake = makeFakeAgentDb();
    const res = await postAnonymous(fake, {
      "cf-connecting-ip": "198.51.100.9",
      "x-forwarded-for": "2001:db8:1:3::1, 192.0.2.1",
    });
    expect(res.status).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:198.51.100.9"]);
  });

  it("uses unknown when both address headers are absent", async () => {
    const fake = makeFakeAgentDb();
    expect((await postAnonymous(fake, {})).status).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:unknown"]);
  });

  // Breaks caught: nullish CF selection, element-zero selection, or taking a later usable hop.
  it.each<[string, Record<string, string>]>([
    ["empty CF", { "cf-connecting-ip": "", "x-forwarded-for": "192.0.2.1, 198.51.100.7" }],
    ["whitespace CF", { "cf-connecting-ip": " \t ", "x-forwarded-for": "192.0.2.1, 198.51.100.7" }],
    ["absent CF and a leading empty hop", { "x-forwarded-for": ", 192.0.2.1, 198.51.100.7" }],
    ["absent CF and multiple empty hops", { "x-forwarded-for": ", , 192.0.2.1, 198.51.100.7" }],
    [
      "empty CF and a leading empty hop",
      { "cf-connecting-ip": "", "x-forwarded-for": ", 192.0.2.1, 198.51.100.7" },
    ],
    [
      "whitespace CF and multiple empty hops",
      { "cf-connecting-ip": " \t ", "x-forwarded-for": ", \t, 192.0.2.1 , 198.51.100.7" },
    ],
  ])("selects the first nonblank forwarded address with %s", async (_label, headers) => {
    const fake = makeFakeAgentDb();
    expect((await postAnonymous(fake, headers)).status).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:192.0.2.1"]);
  });

  // Break caught: reusing human `anon`, or passing a blank string instead of no address.
  it.each<[string, Record<string, string>]>([
    ["empty CF alone", { "cf-connecting-ip": "" }],
    ["whitespace CF alone", { "cf-connecting-ip": " \t " }],
    ["empty XFF alone", { "x-forwarded-for": "" }],
    ["only blank forwarded hops", { "x-forwarded-for": " , \t, " }],
    ["both headers empty", { "cf-connecting-ip": "", "x-forwarded-for": "" }],
    ["both headers whitespace", { "cf-connecting-ip": " \t ", "x-forwarded-for": " , , " }],
  ])("keeps the shield unknown sentinel with %s", async (_label, headers) => {
    const fake = makeFakeAgentDb();
    expect((await postAnonymous(fake, headers)).status).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:unknown"]);
  });

  it.each(["not-an-ip", "2001:db8:::1"])(
    "keeps nonblank malformed CF %s ahead of a usable forwarded address",
    async (ip) => {
      const fake = makeFakeAgentDb();
      expect(
        (
          await postAnonymous(fake, {
            "cf-connecting-ip": ` ${ip} `,
            "x-forwarded-for": ", 192.0.2.1, 198.51.100.7",
          })
        ).status,
      ).toBe(401);
      expect(fake.hits.map((hit) => hit.bucket)).toEqual([`shield:ip:${ip}`]);
    },
  );

  // Break caught: selecting the right fallback but losing its existing normalization.
  it.each([
    ["2001:db8:abcd:1234::1", "shield:ip:2001:db8:abcd:1234::/64"],
    ["2001:0DB8:ABCD:1234:0000:0000:0000:0002", "shield:ip:2001:db8:abcd:1234::/64"],
    ["::ffff:192.0.2.1", "shield:ip:192.0.2.1"],
    ["192.0.2.1", "shield:ip:192.0.2.1"],
    ["not-an-ip", "shield:ip:not-an-ip"],
    ["2001:db8:::1", "shield:ip:2001:db8:::1"],
  ])("normalizes selected fallback %s as %s", async (ip, bucket) => {
    const fake = makeFakeAgentDb();
    expect(
      (
        await postAnonymous(fake, {
          "cf-connecting-ip": "",
          "x-forwarded-for": `, , ${ip} , 198.51.100.7`,
        })
      ).status,
    ).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([bucket]);
  });

  describe.each(["CF", "forwarded"])("selected %s address segment cap", (source) => {
    it.each([
      [63, 63],
      [64, 64],
      [65, 64],
    ])("stores a %i-character address as exactly %i characters", async (length, kept) => {
      const fake = makeFakeAgentDb();
      const ip = "a".repeat(length);
      const headers =
        source === "CF"
          ? { "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.1" }
          : { "cf-connecting-ip": "", "x-forwarded-for": `, ${ip}, 192.0.2.1` };
      expect((await postAnonymous(fake, headers)).status).toBe(401);
      expect(fake.hits.map((hit) => hit.bucket)).toEqual([`shield:ip:${"a".repeat(kept)}`]);
    });
  });

  it.each<[string, Record<string, string>]>([
    ["absent headers", {}],
    ["blank CF", { "cf-connecting-ip": "" }],
    ["wholly blank headers", { "cf-connecting-ip": " \t ", "x-forwarded-for": " , , " }],
    ["leading empty forwarded hops", { "x-forwarded-for": ", , 192.0.2.1, 198.51.100.7" }],
    ["conflicting headers", { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "192.0.2.1" }],
  ])("keeps credentialed HTTP hits independent of %s", async (_label, headers) => {
    const fake = makeFakeAgentDb();
    const credential = "shield-bucket-route-test-only";
    const expected = `shield:${await sha256Hex(credential)}`;
    const request = () =>
      postAnonymous(fake, { ...headers, authorization: `Bearer ${credential}` });
    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(429);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([expected, expected]);
  });

  it("charges exactly once per admitted request across equivalent selected addresses", async () => {
    const fake = makeFakeAgentDb();
    expect(
      (
        await postAnonymous(fake, {
          "cf-connecting-ip": "",
          "x-forwarded-for": ", , 192.0.2.1, 198.51.100.7",
        })
      ).status,
    ).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:192.0.2.1"]);
    expect(
      (await postAnonymous(fake, { "x-forwarded-for": ", 192.0.2.1, 198.51.100.8" })).status,
    ).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([
      "shield:ip:192.0.2.1",
      "shield:ip:192.0.2.1",
    ]);
    const refused = await postAnonymous(fake, {
      "cf-connecting-ip": "192.0.2.1",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { reason: string }).reason).toBe("rate_limited");
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([
      "shield:ip:192.0.2.1",
      "shield:ip:192.0.2.1",
    ]);
  });

  it("keeps a distinct fallback /64 independent after the selected prefix is spent", async () => {
    const fake = makeFakeAgentDb();
    const request = (ip: string) =>
      postAnonymous(fake, { "x-forwarded-for": `, , ${ip}, 198.51.100.7` });
    expect((await request("2001:db8:abcd:1234::1")).status).toBe(401);
    expect((await request("2001:db8:abcd:1234:ffff:eeee:dddd:cccc")).status).toBe(401);
    expect((await request("2001:db8:abcd:1234::3")).status).toBe(429);
    expect((await request("2001:db8:abcd:1235::1")).status).toBe(401);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual([
      "shield:ip:2001:db8:abcd:1234::/64",
      "shield:ip:2001:db8:abcd:1234::/64",
      "shield:ip:2001:db8:abcd:1235::/64",
    ]);
  });
});
