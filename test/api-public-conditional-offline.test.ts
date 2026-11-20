// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// Conditional reads against the real app without a database.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { validatePublicSchema } from "./helpers/public-api-schema";

const baseEnv = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/test-invite-handoff",
  DISCORD_BOT_TOKEN: "bot-token-canary-never-served",
  THROTTLE_STORE: async () => null,
} as unknown as Env & EnvWithThrottle;

const maxAgeOf = (res: Response): number | null => {
  const header = res.headers.get("cache-control");
  const match = header ? header.match(/max-age=(\d+)/) : null;
  return match ? Number(match[1]) : null;
};

const junkEtag = (etag: string) => {
  const flipped = etag.replace(
    /^(W\/)?"(.)/,
    (_m, weak: string | undefined, ch: string) => `${weak ?? ""}"${ch === "0" ? "1" : "0"}`,
  );
  return flipped !== etag ? flipped : '"junk-not-the-current-validator"';
};

const strongForm = (etag: string) => etag.replace(/^W\//, "");
const weakForm = (etag: string) => `W/${strongForm(etag)}`;

type PublicErrorBody = {
  error: { code: string; message: string; request_id: string; next: string };
};

describe("public API conditional runtime without a database (offline)", () => {
  // Freeze the clock for the whole suite so a minute boundary cannot turn the
  // warm max-age from 60 into 59 between the baseline and the conditional read.
  let clock: MockInstance<typeof Date.now>;
  let frozenAt: number;

  beforeEach(() => {
    frozenAt = Date.now();
    clock = vi.spyOn(Date, "now").mockReturnValue(frozenAt);
    __resetApiPublicCacheForTests();
  });

  afterEach(() => {
    clock.mockRestore();
  });

  const paths = ["/api/public/join", "/api/public/community"] as const;

  const get = (path: string, ifNoneMatch?: string, env: Env & EnvWithThrottle = baseEnv) =>
    app.request(
      path,
      {
        headers: {
          "cf-connecting-ip": "192.0.2.95",
          ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
        },
      },
      env,
    );

  type Baseline = { etag: string; body: string };

  const baseline = async (path: string): Promise<Baseline> => {
    __resetApiPublicCacheForTests();
    const res = await get(path);
    expect(res.status, path).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag, path).not.toBeNull();
    expect(res.headers.get("cache-control"), path).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie"), path).toBeNull();
    return { etag: etag as string, body: await res.text() };
  };

  const expectNotModified = async (res: Response, base: Baseline, path: string) => {
    expect(res.status, path).toBe(304);
    expect(await res.text(), path).toBe("");
    expect(res.headers.get("etag"), path).toBe(base.etag);
    expect(res.headers.get("cache-control"), path).toMatch(/^public, max-age=(59|60)$/);
    expect(res.headers.get("set-cookie"), path).toBeNull();
  };

  const expectFresh = async (res: Response, base: Baseline, path: string) => {
    expect(res.status, path).toBe(200);
    expect(await res.text(), path).toBe(base.body);
    expect(res.headers.get("etag"), path).toBe(base.etag);
    expect(res.headers.get("cache-control"), path).toMatch(/^public, max-age=(59|60)$/);
    expect(res.headers.get("set-cookie"), path).toBeNull();
  };

  const matching = [
    { name: "exact", make: (etag: string) => etag },
    { name: "weak", make: (etag: string) => weakForm(etag) },
    { name: "list containing the exact tag", make: (etag: string) => `${junkEtag(etag)}, ${etag}` },
    {
      name: "list containing the weak tag",
      make: (etag: string) => `${junkEtag(etag)}, ${weakForm(etag)}`,
    },
    { name: "wildcard", make: () => "*" },
  ] as const;

  const nonMatching = [
    { name: "different tag", make: (etag: string) => junkEtag(etag) },
    { name: "weak copy of a different tag", make: (etag: string) => weakForm(junkEtag(etag)) },
    {
      name: "list without the current tag",
      make: (etag: string) => `${junkEtag(etag)}, "also-not-current"`,
    },
  ] as const;

  for (const path of paths) {
    for (const { name, make } of matching) {
      it(`${path} answers an empty 304 for a ${name} validator on a cold build`, async () => {
        const base = await baseline(path);
        __resetApiPublicCacheForTests();
        await expectNotModified(await get(path, make(base.etag)), base, path);
      });

      it(`${path} answers an empty 304 for a ${name} validator on a warm cache`, async () => {
        const base = await baseline(path);
        await expectNotModified(await get(path, make(base.etag)), base, path);
      });
    }

    for (const { name, make } of nonMatching) {
      it(`${path} answers the unchanged 200 body for a ${name} on a cold build`, async () => {
        const base = await baseline(path);
        __resetApiPublicCacheForTests();
        await expectFresh(await get(path, make(base.etag)), base, path);
      });

      it(`${path} answers the unchanged 200 body for a ${name} on a warm cache`, async () => {
        const base = await baseline(path);
        await expectFresh(await get(path, make(base.etag)), base, path);
      });
    }

    it(`${path} serves a 304 hit at t0+59s with max-age=1`, async () => {
      // The suite clock is frozen at t0 by beforeEach; advance it explicitly.
      __resetApiPublicCacheForTests();
      const first = await get(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).not.toBeNull();
      await first.text();
      clock.mockReturnValue(frozenAt + 59_000);
      const hit = await get(path, etag as string);
      expect(hit.status, path).toBe(304);
      expect(hit.headers.get("etag"), path).toBe(etag);
      expect(maxAgeOf(hit), path).toBe(1);
    });

    it(`${path} refuses before 304 when the shared budget is spent`, async () => {
      // Control: admission runs before any ETag comparison. A matching
      // validator under a spent budget still answers 429, never 304.
      const base = await baseline(path);
      const now = Date.now();
      const ip = "192.0.2.96";
      const hits: { bucket: string; at: number }[] = Array.from({ length: 60 }, () => ({
        bucket: `events-read:${ip}`,
        at: now,
      }));
      const sql = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const statement = strings.join("?");
          if (statement.includes("pg_advisory_xact_lock")) return [];
          if (statement.includes("SELECT count(*)")) {
            const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
            return [{ n: rows.length, wait: 60 }];
          }
          if (statement.includes("INSERT INTO web_throttle_hits")) {
            hits.push({ bucket: String(values[0]), at: now });
            return [];
          }
          if (statement.includes("DELETE FROM web_throttle_hits")) return [];
          throw new Error("Unexpected throttle statement");
        },
        {
          begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
          unsafe: async () => [],
        },
      );
      const throttled = {
        ...baseEnv,
        THROTTLE_STORE: async () => sql as unknown as Sql,
      } as unknown as Env & EnvWithThrottle;
      const res = await app.request(
        path,
        { headers: { "cf-connecting-ip": ip, "if-none-match": base.etag } },
        throttled,
      );
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after"), path).toBe("60");
      const body = (await res.json()) as PublicErrorBody;
      expect(body.error.code, path).toBe("rate_limited");
      expect(validatePublicSchema(body, "PublicDataError"), path).toEqual([]);
    });
  }
});
