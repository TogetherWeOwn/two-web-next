import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import type { Env } from "../src/env";
import {
  PUBLIC_EVENT_READS_PER_MINUTE,
  publicReadBudget,
  publicReadGuard,
} from "../src/events/routes-shared";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { withThrottleTx } from "./helpers/throttle-tx-double";

// The sequential browser suites share one `events-read:anon` bucket off-edge,
// so both loopback workers raise the budget via E2E_PUBLIC_READ_BUDGET while
// production keeps 60 (docs/event-read-admission.md). The Kit fixture value
// is pinned in ci/kit-parity-ci-wiring.test.mjs, next to the other generated
// fixture pins.

function fixture(env: Partial<Env> = {}) {
  const hits: string[] = [];
  const sql = withThrottleTx((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)"))
      return [{ n: hits.filter((bucket) => bucket === values[0]).length, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) {
      hits.push(values[0] as string);
      return [];
    }
    if (query.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql);
  const app = new Hono<{ Bindings: Env }>();
  app.get("/events", async (c) => (await publicReadGuard(c)) ?? c.body(null, 204));
  const bindings = { ...env, THROTTLE_STORE: async () => sql } as EnvWithThrottle;
  const read = () => app.request("/events", { method: "GET", headers: {} }, bindings);
  return { hits, read };
}

describe("E2E public read budget", () => {
  it("keeps the production 60 when the override is absent", () => {
    expect(publicReadBudget({} as Env)).toBe(PUBLIC_EVENT_READS_PER_MINUTE);
    expect(PUBLIC_EVENT_READS_PER_MINUTE).toBe(60);
  });

  it("honours a positive-integer override", () => {
    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: "600" } as Env)).toBe(600);
  });

  it.each(["0", "-5", "1.5", "abc", "", "   ", "NaN", "Infinity"])(
    "falls back to 60 for %j",
    (value) => {
      expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: value } as Env)).toBe(
        PUBLIC_EVENT_READS_PER_MINUTE,
      );
    },
  );

  it("admits to the override through the guard, then 429s with Retry-After", async () => {
    const { hits, read } = fixture({ E2E_PUBLIC_READ_BUDGET: "2" });
    expect((await read()).status).toBe(204);
    expect((await read()).status).toBe(204);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limited.headers.get("cache-control")).toBe("no-store, private");
    // Headerless off-edge requests share the documented `anon` bucket.
    expect(hits).toEqual(["events-read:anon", "events-read:anon"]);
  });

  it("refuses the 61st read when the override is absent", async () => {
    const { read } = fixture();
    for (let n = 0; n < PUBLIC_EVENT_READS_PER_MINUTE; n++) {
      expect((await read()).status).toBe(204);
    }
    expect((await read()).status).toBe(429);
  });

  it("refuses the 61st read when the override is invalid", async () => {
    const { read } = fixture({ E2E_PUBLIC_READ_BUDGET: "bogus" });
    for (let n = 0; n < PUBLIC_EVENT_READS_PER_MINUTE; n++) {
      expect((await read()).status).toBe(204);
    }
    expect((await read()).status).toBe(429);
  });
});

describe("E2E public read budget config", () => {
  const read = (path: string) =>
    readWranglerConfig(readFileSync(path, "utf8")) as {
      vars?: Record<string, string>;
      env?: Record<string, { vars?: Record<string, string> }>;
    };
  const scopes = (path: string) => {
    const config = read(path);
    return [config.vars ?? {}, ...Object.values(config.env ?? {}).map((e) => e.vars ?? {})];
  };

  it("sets 600 on the loopback Hono worker", () => {
    expect(read("e2e/wrangler.jsonc").vars?.E2E_PUBLIC_READ_BUDGET).toBe("600");
  });

  it.each(["wrangler.jsonc", "wrangler.local.jsonc", "wrangler.jobs.jsonc", "web/wrangler.jsonc"])(
    "leaves %s without the override in every environment",
    (path) => {
      for (const vars of scopes(path)) expect(vars.E2E_PUBLIC_READ_BUDGET).toBeUndefined();
    },
  );
});
