// route-inventory: GET /api/public/join
// Acceptance: the public JSON conditional-GET contract follows RFC 9110
// If-None-Match weak comparison. A matching exact, weak (W/), list or
// wildcard (*) validator answers an empty 304 carrying the current ETag
// and cache headers, on both the cold-build (cache miss) and warm-cache
// (cache hit) paths; a non-matching validator answers the unchanged 200
// body. The join representation is database-free, so this suite mounts the
// real app with a fixture environment and no database.
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { EnvWithThrottle } from "../src/throttle";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/test-invite-handoff";

const env = {
  APP_URL,
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_BOT_TOKEN: "bot-token-canary-never-served",
  THROTTLE_STORE: async () => null,
} as unknown as Env & EnvWithThrottle;

const get = (ifNoneMatch?: string) =>
  app.request(
    "/api/public/join",
    {
      headers: {
        "cf-connecting-ip": "192.0.2.73",
        ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
      },
    },
    env,
  );

// A same-shaped validator guaranteed to differ from the served ETag: flip
// the first character inside the quotes when the tag is quoted, otherwise
// fall back to a fixed tag that is checked against the served one.
const junkEtag = (etag: string) => {
  const flipped = etag.replace(
    /^(W\/)?"(.)/,
    (_m, weak: string | undefined, ch: string) => `${weak ?? ""}"${ch === "0" ? "1" : "0"}`,
  );
  return flipped !== etag ? flipped : '"junk-not-the-current-validator"';
};

const strongForm = (etag: string) => etag.replace(/^W\//, "");
const weakForm = (etag: string) => `W/${strongForm(etag)}`;

type Baseline = { etag: string; cacheControl: string | null; body: string };

// Reset, then take the unconditional 200 that warms the cache and reveals
// the current validator, body and cache headers every case compares to.
const baseline = async (): Promise<Baseline> => {
  __resetApiPublicCacheForTests();
  const res = await get();
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag");
  expect(etag).not.toBeNull();
  expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  expect(res.headers.get("set-cookie")).toBeNull();
  return { etag: etag!, cacheControl: res.headers.get("cache-control"), body: await res.text() };
};

const expectNotModified = async (res: Response, base: Baseline) => {
  expect(res.status).toBe(304);
  expect(await res.text()).toBe("");
  expect(res.headers.get("etag")).toBe(base.etag);
  // Remaining TTL, rounded down, on a real clock: any elapsed millisecond
  // makes a back-to-back hit answer 59, a same-instant hit answers the
  // baseline 60. The miss baseline above stays exact.
  expect(res.headers.get("cache-control")).toMatch(/^public, max-age=(59|60)$/);
  expect(res.headers.get("set-cookie")).toBeNull();
};

const expectFresh = async (res: Response, base: Baseline) => {
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(base.body);
  expect(res.headers.get("etag")).toBe(base.etag);
  // Remaining TTL, rounded down, on a real clock: any elapsed millisecond
  // makes a back-to-back hit answer 59, a same-instant hit answers the
  // baseline 60. The miss baseline above stays exact.
  expect(res.headers.get("cache-control")).toMatch(/^public, max-age=(59|60)$/);
  expect(res.headers.get("set-cookie")).toBeNull();
};

describe("public join conditional validators", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
  });

  it("serves the join handoff with a validator and no session cookie", async () => {
    const base = await baseline();
    const body = JSON.parse(base.body) as { invite_url?: unknown };
    expect(body.invite_url).toBe(INVITE_URL);
  });

  const matching: { name: string; make: (etag: string) => string }[] = [
    { name: "exact", make: (etag) => etag },
    { name: "weak", make: (etag) => weakForm(etag) },
    { name: "list containing the exact tag", make: (etag) => `${junkEtag(etag)}, ${etag}` },
    {
      name: "list containing the weak tag",
      make: (etag) => `${junkEtag(etag)}, ${weakForm(etag)}`,
    },
    { name: "wildcard", make: () => "*" },
  ];

  for (const { name, make } of matching) {
    it(`answers an empty 304 for a ${name} validator on a cold build`, async () => {
      const base = await baseline();
      // Reset again so the conditional request itself is the cold build.
      __resetApiPublicCacheForTests();
      await expectNotModified(await get(make(base.etag)), base);
    });

    it(`answers an empty 304 for a ${name} validator on a warm cache`, async () => {
      const base = await baseline();
      await expectNotModified(await get(make(base.etag)), base);
    });
  }

  const nonMatching: { name: string; make: (etag: string) => string }[] = [
    { name: "different tag", make: (etag) => junkEtag(etag) },
    { name: "weak copy of a different tag", make: (etag) => weakForm(junkEtag(etag)) },
    {
      name: "list without the current tag",
      make: (etag) => `${junkEtag(etag)}, "also-not-current"`,
    },
  ];

  for (const { name, make } of nonMatching) {
    it(`answers the unchanged 200 body for a ${name} on a cold build`, async () => {
      const base = await baseline();
      __resetApiPublicCacheForTests();
      await expectFresh(await get(make(base.etag)), base);
    });

    it(`answers the unchanged 200 body for a ${name} on a warm cache`, async () => {
      const base = await baseline();
      await expectFresh(await get(make(base.etag)), base);
    });
  }
});
