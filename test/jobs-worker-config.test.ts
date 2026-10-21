import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { STAGING_APP_URL, qaEnabled } from "../src/qa";

// The SvelteKit Worker shares src/db and the domain modules with Hono. A queue
// has exactly one consumer and a cron exactly one owner, so staging consumes in
// two-web-jobs (wrangler.jobs.jsonc top level) and production consumes in
// two-web-jobs-production (wrangler.jobs.jsonc env.production); the Hono
// rollback config, the deployed Kit config and the web production env only
// produce. Preview Workers stay off staging queues, routes and secrets. An
// accidental deploy must not steal consumers, double-run crons, or page from
// an alert probe.

const PRODUCTION_APP_URL = "https://togetherweown.com";

const read = (path: string) => readFileSync(path, "utf8");
const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
const kit = readWranglerConfig(read("web/wrangler.jsonc"));
const stagingKit = readWranglerConfig(read("web/wrangler.staging.jsonc"));
const main = readWranglerConfig(read("wrangler.jsonc"));
const jobsEntry = read("src/jobs-worker.ts");

const queueNames = (
  config: { queues?: { producers?: { queue: string }[]; consumers?: { queue: string }[] } },
  key: "producers" | "consumers",
) => (config.queues?.[key] ?? []).map((entry) => entry.queue);
const bindings = (config: { queues?: { producers?: { binding: string }[] } }) =>
  (config.queues?.producers ?? []).map((entry) => entry.binding);
const hyperdriveId = (config: { hyperdrive?: { id: string }[] }) => config.hyperdrive?.[0]?.id;

describe("jobs Worker config (wrangler.jobs.jsonc)", () => {
  it("is the jobs-only entry with no fetch handler", () => {
    expect(jobs.name).toBe("two-web-jobs");
    expect(jobs.main).toBe("src/jobs-worker.ts");
    expect(jobsEntry).toMatch(/queue:\s*handleQueue/);
    expect(jobsEntry).toMatch(/scheduled:\s*handleScheduled/);
    expect(jobsEntry).not.toMatch(/^\s*fetch\s*:/m);
  });

  it("owns both staging consumers and both crons; the web Worker only produces", () => {
    expect(jobs.workers_dev).toBe(false);
    expect(jobs.routes).toBeUndefined();
    // Staging handoff: jobs owns both cron schedules.
    expect(jobs.triggers?.crons).toEqual([RECONCILE_CRON, PRUNE_CRON]);
    // Same queue names and producer bindings as the web Worker: no renames.
    expect(queueNames(jobs, "producers")).toEqual(queueNames(main, "producers"));
    expect(bindings(jobs)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    // Exactly one consumer per staging queue, on the jobs Worker only.
    expect(queueNames(jobs, "consumers")).toEqual(["two-sync-event", "two-internal-action"]);
    expect(queueNames(main, "consumers")).toEqual([]);
    expect(queueNames(stagingKit, "producers")).toEqual(queueNames(main, "producers"));
    expect(queueNames(stagingKit, "consumers")).toEqual([]);
    // Exactly one cron owner: both web configs run none after the handoff.
    expect(main.triggers?.crons).toEqual([]);
    expect(stagingKit.triggers?.crons).toEqual([]);
  });

  it("keeps staging placement, tail paging and consumer backstops on the jobs Worker", () => {
    // Same region as the web Worker: staging database is PlanetScale us-east-1 and every
    // statement is a round trip through Hyperdrive.
    expect(jobs.placement).toMatchObject({ region: "aws:us-east-1" });
    // Jobs traces page through the same staging Tail pager as the web Worker.
    expect(jobs.tail_consumers).toEqual([{ service: "two-web-next-alerts" }]);
    // Terminal outcomes are acked by the consumer; max_retries is only a
    // backstop above the largest `tries`. Same values as the web Worker had.
    expect(jobs.queues?.consumers).toEqual([
      { queue: "two-sync-event", max_retries: 10, max_batch_size: 10, max_batch_timeout: 5 },
      {
        queue: "two-internal-action",
        max_retries: 10,
        max_batch_size: 10,
        max_batch_timeout: 5,
      },
    ]);
    // Least-required vars: staging APP_URL only. Never the preview production
    // guild settings and never preview/production secrets in source.
    expect(jobs.vars?.APP_URL).toBe(STAGING_APP_URL);
    expect(jobs.vars).not.toHaveProperty("DISCORD_GUILD_ID");
    expect(jobs.vars).not.toHaveProperty("DISCORD_MODERATOR_ROLE_IDS");
    expect(hyperdriveId(jobs)).toBe(hyperdriveId(main));
  });

  it("preview env consumes its own queues on the staging Hyperdrive, paging nothing", () => {
    const preview = jobs.env?.preview;
    expect(preview?.name).toBe("two-web-jobs-preview");
    expect(preview?.workers_dev).toBe(false);
    expect(preview?.preview_urls).toBe(false);
    expect(preview?.routes).toBeUndefined();
    // Reconcile only: prune is a daily delete staging's own cron already runs.
    expect(preview?.triggers?.crons).toEqual([RECONCILE_CRON]);
    const produced = queueNames(preview ?? {}, "producers");
    expect(produced).toEqual(queueNames(preview ?? {}, "consumers"));
    expect(produced).toHaveLength(2);
    // Preview queues are disjoint from staging's: no consumer theft, ever.
    for (const queue of produced) expect(queueNames(jobs, "consumers")).not.toContain(queue);
    expect(hyperdriveId(preview ?? {})).toBe(hyperdriveId(main));
    // Never the staging APP_URL, so qaEnabled() stays false and an
    // alert-probe message is acked as done without paging.
    expect(String(preview?.vars?.APP_URL)).toMatch(/\.invalid$/);
    expect(qaEnabled(String(preview?.vars?.APP_URL), "any-token")).toBe(false);
    expect(preview?.vars?.APP_URL).not.toBe(STAGING_APP_URL);
  });
});

describe("production jobs split (wrangler.jobs.jsonc env.production)", () => {
  const production = jobs.env?.production;
  const webProduction = main.env?.production;

  it("is a routeless production Worker that owns both production crons", () => {
    expect(production?.name).toBe("two-web-jobs-production");
    expect(production?.workers_dev).toBe(false);
    expect(production?.preview_urls).toBe(false);
    expect(production?.routes).toBeUndefined();
    // Same schedules as staging: no renames, no extra crons.
    expect(production?.triggers?.crons).toEqual([RECONCILE_CRON, PRUNE_CRON]);
    // The web production env only produces after the transfer.
    expect(webProduction?.triggers?.crons).toEqual([]);
  });

  it("consumes exactly the production queues with the staging backstops", () => {
    const produced = queueNames(production ?? {}, "producers");
    expect(produced).toEqual(queueNames(production ?? {}, "consumers"));
    expect([...produced].sort()).toEqual([
      "two-web-next-production-internal-action",
      "two-web-next-production-sync-event",
    ]);
    expect(bindings(production ?? {})).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    // Same consumer backstops as staging: terminal outcomes are acked by the
    // consumer; max_retries is only a backstop above the largest `tries`.
    expect(production?.queues?.consumers).toEqual([
      {
        queue: "two-web-next-production-sync-event",
        max_retries: 10,
        max_batch_size: 10,
        max_batch_timeout: 5,
      },
      {
        queue: "two-web-next-production-internal-action",
        max_retries: 10,
        max_batch_size: 10,
        max_batch_timeout: 5,
      },
    ]);
    // Exactly one consumer per production queue, on the jobs Worker only.
    expect(queueNames(webProduction ?? {}, "consumers")).toEqual([]);
    // Producers keep the same bindings so the promoted web code talks to the
    // production queues, never the staging ones.
    expect(queueNames(webProduction ?? {}, "producers").sort()).toEqual([...produced].sort());
  });

  it("keeps production queues, database and paging disjoint from staging", () => {
    const produced = queueNames(production ?? {}, "consumers");
    // Production queues are disjoint from staging's and the preview's: no
    // consumer theft across environments, ever.
    for (const queue of produced) {
      expect(queueNames(jobs, "consumers")).not.toContain(queue);
      expect(queueNames(jobs.env?.preview ?? {}, "consumers")).not.toContain(queue);
    }
    // The production database: the same production Hyperdrive the web
    // production Worker reads, never the staging one. No BOT_DB: the jobs
    // Worker never reads bot views.
    expect(production?.hyperdrive).toHaveLength(1);
    expect(hyperdriveId(production ?? {})).toBe(hyperdriveId(webProduction ?? {}));
    expect(hyperdriveId(production ?? {})).not.toBe(hyperdriveId(main));
    // Jobs traces page through the production Tail pager, like the web
    // production Worker.
    expect(production?.tail_consumers).toEqual([{ service: "two-web-next-alerts-production" }]);
    expect(production?.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  it("carries only the production APP_URL, so QA stays off and secrets stay out", () => {
    expect(webProduction?.vars?.APP_URL).toBe(PRODUCTION_APP_URL);
    expect(production?.vars?.APP_URL).toBe(PRODUCTION_APP_URL);
    // qaEnabled() requires the staging APP_URL: it stays false here even
    // with a token, and QA_AUTH_TOKEN stays unprovisioned on production.
    expect(qaEnabled(String(production?.vars?.APP_URL), "any-token")).toBe(false);
    expect(production?.vars).not.toHaveProperty("DISCORD_GUILD_ID");
    expect(production?.vars).not.toHaveProperty("DISCORD_MODERATOR_ROLE_IDS");
    expect(production?.vars).not.toHaveProperty("BOT_ENDPOINT_URL");
    expect(production?.vars).not.toHaveProperty("BOT_KEY_ID");
    expect(production?.vars).not.toHaveProperty("BOT_SHARED_SECRET");
    expect(production?.vars).not.toHaveProperty("QA_AUTH_TOKEN");
  });

  it("leaves every web-family config produce-only, including future Kit production", () => {
    // The transfer moves ownership off the web Worker for good: any present
    // or future web/wrangler.*.jsonc (a Kit production config lands with the
    // Kit promotion) must produce without consuming or owning crons, or its
    // first deploy steals production consumers.
    const files = readdirSync("web").filter((name) => /^wrangler.*\.jsonc$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const config = readWranglerConfig(read(`web/${name}`));
      expect(queueNames(config, "consumers"), name).toEqual([]);
      expect(config.triggers?.crons ?? [], name).toEqual([]);
      const envs: Record<
        string,
        { queues?: { consumers?: { queue: string }[] }; triggers?: { crons?: string[] } }
      > = config.env ?? {};
      for (const [envName, environment] of Object.entries(envs)) {
        expect(queueNames(environment, "consumers"), `${name} env.${envName}`).toEqual([]);
        expect(environment.triggers?.crons ?? [], `${name} env.${envName}`).toEqual([]);
      }
    }
  });
});

describe("Kit preview Worker config (web/wrangler.jsonc)", () => {
  it("is a workers.dev preview with no route, consumer or cron", () => {
    expect(kit.name).toBe("two-web-next-kit-preview");
    expect(kit.main).toBe(".svelte-kit/cloudflare/_worker.js");
    expect(kit.workers_dev).toBe(true);
    expect(kit.preview_urls).toBe(false);
    expect(kit.routes).toBeUndefined();
    expect(kit.triggers).toBeUndefined();
    expect(kit.queues?.consumers).toBeUndefined();
    expect(kit.tail_consumers).toBeUndefined();
    // Producers only, onto the jobs preview Worker's own queues.
    expect(queueNames(kit, "producers")).toEqual(queueNames(jobs.env?.preview ?? {}, "producers"));
    expect(bindings(kit)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    // Every request reaches the Worker first, so public/ files pass the Hono
    // host guard and headers; Kit's /_app/* output is still adapter-served.
    expect(kit.assets).toMatchObject({ binding: "ASSETS", run_worker_first: true });
  });

  it("reads staging data without secrets, so sign-in fails closed and QA stays off", () => {
    expect(hyperdriveId(kit)).toBe(hyperdriveId(main));
    const host = new URL(String(kit.vars?.APP_URL)).hostname;
    expect(host).toMatch(/\.workers\.dev$/);
    expect(String(kit.vars?.APP_URL)).not.toBe(STAGING_APP_URL);
    expect(qaEnabled(String(kit.vars?.APP_URL), "any-token")).toBe(false);
  });
});
