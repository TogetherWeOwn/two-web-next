import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readWranglerConfig } = require("../ci/wrangler-config.mjs");

// web/wrangler.production.jsonc is the reviewed Kit Worker config for the
// production script name. It must mirror the root env.production bindings and
// vars, add only the two Kit route flags, own no routes, crons or consumers,
// and leave the root Hono entry unchanged.

const read = (path: string) => readFileSync(path, "utf8");
const kit = readWranglerConfig(read("web/wrangler.production.jsonc"));
const main = readWranglerConfig(read("wrangler.jsonc"));
const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
const prod = main.env.production;

describe("production Kit Worker config (web/wrangler.production.jsonc)", () => {
  it("uses the production script name and the Kit build output", () => {
    expect(kit.name).toBe("two-web-next-production");
    expect(kit.name).toBe(prod.name);
    expect(kit.main).toBe(".svelte-kit/cloudflare/_worker.js");
    expect(kit.assets).toEqual({
      directory: ".svelte-kit/cloudflare",
      binding: "ASSETS",
      run_worker_first: true,
    });
  });

  it("preserves the production runtime settings", () => {
    expect(kit.placement).toEqual({ mode: "off" });
    expect(kit.placement).toEqual(prod.placement);
    expect(kit.compatibility_date).toBe(main.compatibility_date);
    expect(kit.compatibility_flags).toEqual(main.compatibility_flags);
    expect(kit.observability).toEqual(main.observability);
    expect(kit.workers_dev).toBe(false);
    expect(kit.preview_urls).toBe(false);
    expect(kit.keep_vars).toBe(true);
    expect(kit.tail_consumers).toEqual(prod.tail_consumers);
    expect(kit.version_metadata).toEqual(prod.version_metadata);
  });

  it("repeats every production binding and var", () => {
    expect(kit.hyperdrive).toEqual(prod.hyperdrive);
    expect(kit.queues).toEqual(prod.queues);
    const { KIT_ROUTE_ARCHIVE, KIT_ROUTE_STATIC, ...inherited } = kit.vars;
    expect(inherited).toEqual(prod.vars);
    expect(KIT_ROUTE_ARCHIVE).toBe("false");
    expect(KIT_ROUTE_STATIC).toBe("false");
  });

  it("has no QA surface, consumers, crons or routes", () => {
    expect(kit.vars).not.toHaveProperty("QA_AUTH_TOKEN");
    expect(JSON.stringify(kit)).not.toMatch(/QA_/);
    expect(kit.queues.consumers).toBeUndefined();
    expect(kit.queues.producers).toHaveLength(2);
    expect(kit.triggers).toEqual({ crons: [] });
    expect(kit.routes).toBeUndefined();
    expect(kit.route).toBeUndefined();
    expect(kit.env).toBeUndefined();
  });

  it("leaves consumers and crons solely with the production jobs Worker", () => {
    const jobsProd = jobs.env.production;
    const consumed = (jobsProd.queues?.consumers ?? []).map((c: { queue: string }) => c.queue);
    const produced = kit.queues.producers.map((p: { queue: string }) => p.queue);
    expect(consumed.sort()).toEqual([...produced].sort());
    expect(jobsProd.triggers.crons.length).toBeGreaterThan(0);
    expect(kit.triggers.crons).toEqual([]);
  });

  it("leaves the root Hono production entry unchanged", () => {
    expect(main.main).toBe("src/worker.ts");
    expect(prod.name).toBe("two-web-next-production");
    expect(prod.routes).toEqual([{ pattern: "togetherweown.com", custom_domain: true }]);
  });
});
