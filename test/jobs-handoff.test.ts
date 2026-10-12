import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";

// TOG-22127: staging handoff invariants. The jobs Worker takes over the exact
// staging queues and cron schedules: no renames, no payload changes, no
// Effect, exactly one consumer per queue and one cron owner. Queue names are
// unchanged so Cloudflare retains the backlog across the redeploys; the
// Postgres ledger plus the single-flight advisory lock reconcile it, and the
// tracked producer/unique-lock pair keeps bot side effects idempotent.

const read = (path: string) => readFileSync(path, "utf8");
const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
const main = readWranglerConfig(read("wrangler.jsonc"));

type QueueEntry = { queue: string; binding?: string };
const names = (entries: QueueEntry[] | undefined) => (entries ?? []).map((e) => e.queue);

describe("staging jobs handoff invariants", () => {
  it("keeps the exact staging queue names and bindings (no renames)", () => {
    expect(names(jobs.queues?.producers)).toEqual(["two-sync-event", "two-internal-action"]);
    expect(names(jobs.queues?.consumers)).toEqual(["two-sync-event", "two-internal-action"]);
    expect(names(main.queues?.producers)).toEqual(["two-sync-event", "two-internal-action"]);
    const bindings = (entries: QueueEntry[] | undefined) =>
      (entries ?? []).map((e) => e.binding);
    expect(bindings(jobs.queues?.producers)).toEqual([
      "SYNC_EVENT_QUEUE",
      "INTERNAL_ACTION_QUEUE",
    ]);
    expect(bindings(main.queues?.producers)).toEqual([
      "SYNC_EVENT_QUEUE",
      "INTERNAL_ACTION_QUEUE",
    ]);
  });

  it("has exactly one consumer per staging queue across both top levels", () => {
    const consumers = [...names(jobs.queues?.consumers), ...names(main.queues?.consumers)];
    expect(consumers.sort()).toEqual(["two-internal-action", "two-sync-event"]);
  });

  it("has exactly one owner per cron schedule", () => {
    expect(jobs.triggers?.crons).toEqual([RECONCILE_CRON, PRUNE_CRON]);
    expect(main.triggers?.crons).toEqual([]);
    // Preview keeps its own reconcile-only schedule on its own queues.
    const preview = jobs.env?.preview;
    expect(preview?.triggers?.crons).toEqual([RECONCILE_CRON]);
    expect(preview?.triggers?.crons).not.toContain(PRUNE_CRON);
  });

  it("shares the same queue and cron handlers without Effect", () => {
    const webEntry = read("src/worker.ts");
    const jobsEntry = read("src/jobs-worker.ts");
    for (const entry of [webEntry, jobsEntry]) {
      expect(entry).toMatch(/handleQueue/);
      expect(entry).toMatch(/handleScheduled/);
    }
    // No Effect introduction in the handoff path.
    for (const file of ["src/jobs-worker.ts", "src/worker.ts", "src/jobs/worker.ts"]) {
      const body = read(file);
      expect(body).not.toMatch(/from\s+["']effect["']/);
      expect(body).not.toMatch(/require\(\s*["']effect["']\s*\)/);
    }
  });

  it("keeps the jobs preview off staging queues and the staging APP_URL", () => {
    const preview = jobs.env?.preview;
    const produced = names(preview?.queues?.producers);
    expect(produced).toEqual(names(preview?.queues?.consumers));
    for (const queue of produced) {
      expect(["two-sync-event", "two-internal-action"]).not.toContain(queue);
    }
    expect(String(preview?.vars?.APP_URL)).toMatch(/\.invalid$/);
  });
});
