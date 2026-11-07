import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { dispatchHookRequest } from "../src/route-ownership";
import worker from "../src/worker";
import { ALERT_ROUTES, APP_SCRIPT_NAMES } from "../tail/worker";
import app from "./app";

// Source-level pins for the operations a production Kit upload must not
// disturb: who consumes queues and owns crons, that the root Hono Worker still
// runs on its own, and that production Tail paging keeps today's Hono route
// labels. Source only: nothing here proves what is deployed.

const require = createRequire(import.meta.url);
const { readWranglerConfig } = require("../ci/wrangler-config.mjs");
const read = (path: string) => readFileSync(path, "utf8");
const kit = readWranglerConfig(read("web/wrangler.production.jsonc"));
const main = readWranglerConfig(read("wrangler.jsonc"));
const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
const prod = main.env.production;
const jobsProd = jobs.env.production;

const PRODUCTION = "two-web-next-production";
const queueNames = (entries: { queue: string }[] | undefined) =>
  (entries ?? []).map((entry) => entry.queue).sort();

describe("production Kit Worker is producers-only", () => {
  it("shares the production script name and produces to the production queues", () => {
    expect(kit.name).toBe(PRODUCTION);
    expect(queueNames(kit.queues.producers)).toEqual(queueNames(prod.queues.producers));
    expect(queueNames(kit.queues.producers)).toEqual([
      "two-web-next-production-internal-action",
      "two-web-next-production-sync-event",
    ]);
  });

  it("declares no queue consumers and no cron triggers", () => {
    expect(kit.queues.consumers).toBeUndefined();
    expect(kit.triggers).toEqual({ crons: [] });
    expect(JSON.stringify(kit)).not.toMatch(/"(consumers|dead_letter_queue|scheduled)"/);
  });
});

describe("root Hono Worker stays runnable on its own", () => {
  it("keeps the Hono entry with fetch, queue and scheduled handlers", () => {
    expect(main.main).toBe("src/worker.ts");
    expect(prod.name).toBe(PRODUCTION);
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.queue).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("is produce-only in production and carries no Kit build or flags", () => {
    expect(prod.triggers).toEqual({ crons: [] });
    expect(prod.queues.consumers).toBeUndefined();
    expect(JSON.stringify(prod)).not.toMatch(/KIT_ROUTE|\.svelte-kit/);
  });
});

describe("wrangler.jobs.jsonc owns production consumers and crons", () => {
  it("is a separate Worker from the web production script", () => {
    expect(jobsProd.name).toBe("two-web-jobs-production");
    expect(jobsProd.name).not.toBe(kit.name);
    expect(jobs.main).toBe("src/jobs-worker.ts");
    expect(jobsProd.routes).toBeUndefined();
    expect(jobsProd.route).toBeUndefined();
  });

  it("consumes exactly the queues the Kit Worker produces to and owns the crons", () => {
    expect(queueNames(jobsProd.queues.consumers)).toEqual(queueNames(kit.queues.producers));
    expect(jobsProd.triggers.crons).toEqual(["*/10 * * * *", "0 0 * * *"]);
  });
});

describe("production Tail paging keeps today's Hono route labels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pages both production web and production jobs scripts through the production Tail", () => {
    expect(kit.tail_consumers).toEqual([{ service: "two-web-next-alerts-production" }]);
    expect(kit.tail_consumers).toEqual(prod.tail_consumers);
    expect(jobsProd.tail_consumers).toEqual(prod.tail_consumers);
    expect(APP_SCRIPT_NAMES.has(kit.name)).toBe(true);
    expect(APP_SCRIPT_NAMES.has(jobsProd.name)).toBe(true);
  });

  it("allows only registered Hono templates and no Kit route ids", () => {
    const inventory = JSON.parse(read("test/fixtures/route-inventory.json")) as { path: string }[];
    const honoPaths = new Set(inventory.map((route) => route.path).filter((p) => !p.includes("*")));
    expect([...ALERT_ROUTES].sort()).toEqual([...honoPaths].sort());
    expect(ALERT_ROUTES.has("/[...path]")).toBe(false);
  });

  it.each(["/about", "/faq", "/rules"])(
    "labels %s the same through the Hono catch-all as through Hono directly",
    async (path) => {
      const env = {
        APP_URL: "https://togetherweown.com",
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_BOT_TOKEN: "bot-token",
        SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      } as Env;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const labels = () =>
        log.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('"http.request"'))
          .map((line) => (JSON.parse(line) as { route: string }).route);

      const direct = await app.request(path, undefined, env);
      expect(direct.status).toBe(200);
      expect(labels()).toEqual([path]);
      log.mockClear();

      const request = new Request(new URL(path, env.APP_URL));
      const resolve = vi.fn(async () => new Response("kit"));
      const response = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: "/[...path]" } },
        {
          appUrl: env.APP_URL,
          honoFetch: async (forwarded: Request) => app.request(forwarded, undefined, env),
          resolve,
        },
      );
      expect(response.status).toBe(200);
      expect(resolve).not.toHaveBeenCalled();
      expect(labels()).toEqual([path]);
      expect(ALERT_ROUTES.has(path)).toBe(true);
    },
  );
});
