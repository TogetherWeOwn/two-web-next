import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { STAGING_APP_URL, qaEnabled } from "../src/qa";

// TOG-12247: the SvelteKit spike splits the runtime in two Workers that share
// src/db and the domain modules. A queue has exactly one consumer and a cron
// exactly one owner, so this pins the split: staging keeps consuming in
// src/worker.ts (wrangler.jsonc) until a cutover PR moves consumers + crons
// into wrangler.jobs.jsonc, and both preview Workers stay off the staging
// queues, routes and secrets. An accidental deploy must not steal staging's
// consumers, double-run its crons, or page from an alert probe.

const read = (path: string) => readFileSync(path, "utf8");
const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
const kit = readWranglerConfig(read("web/wrangler.jsonc"));
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

  it("consumes nothing at top level, so staging keeps its consumers until cutover", () => {
    expect(jobs.workers_dev).toBe(false);
    expect(jobs.routes).toBeUndefined();
    expect(jobs.triggers?.crons).toEqual([]);
    expect(jobs.queues?.consumers).toBeUndefined();
    // Same producer shape as the staging Worker: top level only produces.
    expect(queueNames(jobs, "producers")).toEqual(queueNames(main, "producers"));
    expect(bindings(jobs)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    // Staging still owns both consumers and both crons until the cutover PR.
    expect(queueNames(main, "consumers")).toHaveLength(2);
    expect(main.triggers?.crons).toEqual([RECONCILE_CRON, PRUNE_CRON]);
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
    for (const queue of produced) expect(queueNames(main, "consumers")).not.toContain(queue);
    expect(hyperdriveId(preview ?? {})).toBe(hyperdriveId(main));
    // Never the staging APP_URL, so qaEnabled() stays false and an
    // alert-probe message is acked as done without paging.
    expect(String(preview?.vars?.APP_URL)).toMatch(/\.invalid$/);
    expect(qaEnabled(String(preview?.vars?.APP_URL), "any-token")).toBe(false);
    expect(preview?.vars?.APP_URL).not.toBe(STAGING_APP_URL);
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
