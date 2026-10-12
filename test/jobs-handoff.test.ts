import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";

// Staging handoff invariants. The jobs Worker takes over the exact
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
    const bindings = (entries: QueueEntry[] | undefined) => (entries ?? []).map((e) => e.binding);
    expect(bindings(jobs.queues?.producers)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    expect(bindings(main.queues?.producers)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
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

  it("pins the rollback configs inside the checkout (wrangler resolves assets relative to the config)", () => {
    const runbook = read("docs/jobs-handoff.md");
    expect(runbook).toContain("> ./rollback-wrangler.jsonc");
    expect(runbook).toContain("> ./rollback-wrangler.jobs.jsonc");
    expect(runbook).toContain("--config ./rollback-wrangler.jsonc");
    expect(runbook).toContain("--config ./rollback-wrangler.jobs.jsonc");
    expect(runbook).not.toContain("--config /tmp/");
  });

  it("reads live schedules as result.schedules and fails closed on mismatch", () => {
    const runbook = read("docs/jobs-handoff.md");
    // GET /workers/scripts/{script}/schedules returns result as an object
    // { schedules: [...] }, never a bare array. The old (d.result ?? []).map
    // shape throws TypeError on every healthy response.
    expect(runbook).toContain("d.result?.schedules ?? []");
    expect(runbook).not.toContain("(d.result ?? []).map");

    // Extract the exact node -e payload from the fenced rollback block and
    // run it against a stubbed fetch shaped like the Cloudflare API, so the
    // comparison cannot be neutered (if (false)) without this test failing.
    const block = runbook.split("Read back the live schedules")[1]!;
    const marker = "node -e '";
    const start = block.indexOf(marker);
    expect(start, "live-schedules node -e block").toBeGreaterThan(-1);
    const end = block.indexOf("'\n", start + marker.length);
    expect(end, "live-schedules node -e terminator").toBeGreaterThan(start);
    const extracted = block.slice(start + marker.length, end);
    expect(extracted).toContain("d.result?.schedules ?? []");

    const stub =
      "globalThis.fetch = async (url) => { " +
      "const u = String(url); " +
      "const script = u.includes('/scripts/two-web-jobs/') ? 'two-web-jobs' : 'two-web-next'; " +
      "const payload = JSON.parse(process.env.STUB_SCHEDULES ?? '{}'); " +
      "const crons = payload[script] ?? []; " +
      "return { json: async () => ({ success: true, " +
      "result: { schedules: crons.map((cron) => ({ cron })) } }) }; }; " +
      extracted;
    const run = (schedules: Record<string, string[]>) =>
      spawnSync(process.execPath, ["-e", stub], {
        env: {
          ...process.env,
          CF_TOKEN: "test-token",
          CF_ACCT: "test-acct",
          STUB_SCHEDULES: JSON.stringify(schedules),
        },
        encoding: "utf8",
      });
    const healthy = {
      "two-web-next": [RECONCILE_CRON, PRUNE_CRON],
      "two-web-jobs": [],
    };
    const ok = run(healthy);
    expect(ok.status, `healthy schedules must exit 0: ${ok.stderr}${ok.stdout}`).toBe(0);
    const webDiffers = run({ "two-web-next": [RECONCILE_CRON], "two-web-jobs": [] });
    expect(webDiffers.status, "web mismatch must exit 1").toBe(1);
    const jobsDiffers = run({
      "two-web-next": [RECONCILE_CRON, PRUNE_CRON],
      "two-web-jobs": [RECONCILE_CRON],
    });
    expect(jobsDiffers.status, "jobs mismatch must exit 1").toBe(1);
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
