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
const staging = readWranglerConfig(read("web/wrangler.staging.jsonc"));

type QueueEntry = { queue: string; binding?: string };
const names = (entries: QueueEntry[] | undefined) => (entries ?? []).map((e) => e.queue);

describe("staging jobs handoff invariants", () => {
  it("keeps the exact staging queue names and bindings (no renames)", () => {
    expect(names(jobs.queues?.producers)).toEqual(["two-sync-event", "two-internal-action"]);
    expect(names(jobs.queues?.consumers)).toEqual(["two-sync-event", "two-internal-action"]);
    expect(names(staging.queues?.producers)).toEqual(["two-sync-event", "two-internal-action"]);
    const bindings = (entries: QueueEntry[] | undefined) => (entries ?? []).map((e) => e.binding);
    expect(bindings(jobs.queues?.producers)).toEqual(["SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]);
    expect(bindings(staging.queues?.producers)).toEqual([
      "SYNC_EVENT_QUEUE",
      "INTERNAL_ACTION_QUEUE",
    ]);
  });

  it("has exactly one consumer per staging queue across both top levels", () => {
    const consumers = [...names(jobs.queues?.consumers), ...names(staging.queues?.consumers)];
    expect(consumers.sort()).toEqual(["two-internal-action", "two-sync-event"]);
  });

  it("has exactly one owner per cron schedule", () => {
    expect(jobs.triggers?.crons).toEqual([RECONCILE_CRON, PRUNE_CRON]);
    expect(staging.triggers?.crons).toEqual([]);
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
    expect(runbook).toContain("--config web/wrangler.staging.jsonc");
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

  it("requires a bounded exclusive hold across deploy, migrate and operator lanes", () => {
    const runbook = read("docs/jobs-handoff.md");
    // The deploy workflow serializes only deploy-staging while hand-dispatch
    // migrations use web-migrate-*: one quiet page never proves the other
    // lanes idle. Pin the workflow facts themselves so a renamed concurrency
    // group fails here instead of silently staling the runbook.
    expect(read(".github/workflows/deploy.yml")).toContain("group: deploy-staging");
    expect(read(".github/workflows/db-migrate.yml")).toContain("group: web-migrate-");
    expect(runbook).toContain("deploy-staging");
    expect(runbook).toContain("web-migrate-staging");
    expect(runbook).toContain("never proves the other two are idle");
    expect(runbook).toContain("acknowledgements");
    expect(runbook).toContain("expiry");
    expect(runbook).toContain("at most 2h");
    expect(runbook).toContain("staging-deploy-gate.mjs");
    expect(runbook).toContain("aborts the handoff");
    // The hold is enforceable and starts before the secrets step that arms the
    // automatic deploy lane; secret provisioning is a covered mutation and an
    // in-flight ci run on main is part of the idle check. Scope the command
    // pins to the hold section so the rollback section's copies cannot satisfy
    // them.
    const holdSection = runbook.split("## Coordinated hold")[1]!.split("## Handoff sequence")[0]!;
    expect(holdSection).toContain("gh workflow disable deploy");
    expect(holdSection).toContain("gh workflow enable deploy");
    expect(holdSection).toContain("gh workflow disable db-migrate");
    expect(holdSection).toContain("gh workflow enable db-migrate");
    // A rolled-back handoff is an aborted handoff: the hold must not re-arm
    // the lane the rollback keeps frozen, and the release must prove both
    // lanes are active again (a disabled workflow silently drops workflow_run).
    expect(holdSection).toContain("rolled back");
    expect(holdSection).toContain("until the cause is fixed");
    expect(holdSection).toContain("gh workflow list");
    // The disable commands must resolve: pin the workflow names and the
    // trigger the hold cites, so a renamed workflow fails here instead of
    // leaving the Operator with a command that stops nothing.
    expect(read(".github/workflows/deploy.yml")).toMatch(/^name: deploy$/m);
    expect(read(".github/workflows/deploy.yml")).toContain("workflow_run:");
    expect(read(".github/workflows/db-migrate.yml")).toMatch(/^name: db-migrate$/m);
    expect(runbook).toContain("secret provisioning");
    expect(runbook).toContain("ci.yml");
    // The required gate command is Actions-only by default; the runbook must
    // give the manual env recipe so the Operator can satisfy the required step.
    expect(runbook).toContain("GITHUB_EVENT_PATH");
    expect(runbook).toContain("GITHUB_EVENT_NAME=workflow_dispatch");
  });

  it("pins the rollback freeze and release on both automatic lanes", () => {
    const runbook = read("docs/jobs-handoff.md");
    // Scope to the standard rollback so the hold section's copies cannot
    // satisfy these pins (and vice versa).
    const rollbackSection = runbook.split("## Rollback")[1]!.split("### First install")[0]!;
    expect(rollbackSection).toContain("gh workflow disable deploy");
    expect(rollbackSection).toContain("gh workflow disable db-migrate");
    expect(rollbackSection).toContain("gh workflow enable deploy");
    expect(rollbackSection).toContain("gh workflow enable db-migrate");
    // A rolled-back handoff must not strand the migrate lane disabled: the
    // release re-enables both lanes once the cause is fixed and proves it.
    expect(rollbackSection).toContain("after the cause is fixed");
    expect(rollbackSection).toContain("gh workflow list");
    // The disable stops future triggers, not runs already started: the
    // rollback carries the hold's in-flight check, or a surviving run
    // re-attaches two-web-jobs after the manual moves.
    // Address workflows by file name: the workflow-name lookup stops resolving
    // once the lane is disabled, so the bare `--workflow deploy` form fails the
    // Operator exactly when the check matters. The negative pins below fail on
    // that form (and the matching ci one).
    expect(rollbackSection).toContain("gh run list");
    expect(rollbackSection).toContain("--workflow deploy.yml");
    expect(rollbackSection).toContain("--workflow ci.yml");
    expect(rollbackSection).not.toMatch(/--workflow deploy(?!\.yml)/);
    expect(rollbackSection).not.toMatch(/--workflow ci(?!\.yml)/);
    // Filtering on one queued status misses the run the deploy-staging
    // concurrency group holds as pending: list every non-terminal run.
    expect(rollbackSection).toContain("pending");
    expect(rollbackSection).toContain("gh run cancel");
    expect(rollbackSection).toContain("rather than cancelling it mid-mutation");
    // Scope the run lists to main: ci also runs on PRs, so an unscoped list
    // would cancel other open PRs' runs, including the fix PR.
    expect(rollbackSection).toContain("--branch main");
    expect(rollbackSection).toContain('.headBranch == "main"');
    expect(rollbackSection).toContain("--json databaseId,status,headBranch");
    expect(rollbackSection).toContain('select(.status != "completed" and .headBranch == "main")');
    // Pin the full list commands: a --status flag or a dropped --json field
    // silently narrows the check, and substring pins stay green through both.
    expect(rollbackSection).toContain(
      "gh run list --workflow deploy.yml --branch main --json databaseId,status,headBranch",
    );
    expect(rollbackSection).toContain(
      "gh run list --workflow ci.yml --branch main --json databaseId,status,headBranch",
    );
    expect(rollbackSection).not.toContain("--status");
    // Cancel-before-wait: a pending deploy starts as soon as the executing one
    // finishes (cancel-in-progress: false) and would re-attach two-web-jobs.
    expect(rollbackSection).toContain("except an in-progress deploy first");
    expect(rollbackSection).toContain("Re-list");
    expect(rollbackSection).toContain("only `completed` runs remain");
    expect(rollbackSection.indexOf("except an in-progress deploy first")).toBeLessThan(
      rollbackSection.indexOf("let the in-progress deploy finish"),
    );
    expect(rollbackSection.indexOf("Re-list")).toBeLessThan(
      rollbackSection.indexOf("only then start the wrangler"),
    );
    // The step-0 record is immutable: re-recording after a mid-rollback deploy
    // would overwrite the good pre-handoff pointers with post-deploy versions.
    expect(rollbackSection).not.toContain("re-recording the step-0 pointers");
    expect(rollbackSection).toContain("stays immutable");
    expect(rollbackSection).toContain("never overwrite");
    expect(rollbackSection).toContain("separate incident names");
    // db-migrate serves both targets on one workflow: the freeze covers
    // production too, so the runbook must say what is blocked today.
    expect(rollbackSection).toContain("production is pre-cutover");
    expect(rollbackSection).toContain("covers the production target");
  });

  it("pins the first-install rollback from the inert draft (no GOOD_JOBS_VERSION)", () => {
    const runbook = read("docs/jobs-handoff.md");
    expect(runbook).toContain("inert");
    expect(runbook).toContain("$GOOD_JOBS_VERSION");
    expect(runbook).toContain("queue-side");
    // Web rollback pointers are preserved but the fresh step-0 record wins.
    expect(runbook).toContain("55c22e8e-b1d4-4137-867f-06bf3ceebae2");
    expect(runbook).toContain("5a8e6b90-ecaa-48e2-8026-14552066d8f1");
    // Partial detach/attach stays idempotent with bounded delivery resume.
    expect(runbook).toContain("fails the run instead of reading as empty");
    expect(runbook).toContain("only if paused");
    // The first-install path has no usable jobs version to roll back to, so it
    // must say to skip the jobs rollback line; either rollback must freeze the
    // automatic deploy lane or the next main push silently redoes the handoff.
    expect(runbook).toContain("skip the `wrangler rollback");
    expect(runbook).toContain("freeze the deploy lane");
    // A revert on main is a push, so it fires the deploy workflow: the freeze
    // is always the disable command first, and a revert lands only after the
    // manual consumer/cron moves below are complete.
    expect(runbook).toContain("before anything else");
    expect(runbook).toContain("only after the manual rollback");
  });

  it("pins staging-only secret custody without values or substitution", () => {
    const runbook = read("docs/jobs-handoff.md");
    expect(runbook).toContain("granted custodian");
    expect(runbook).toContain("QUEUE_RECONCILE_*");
    expect(runbook).toContain("disagree");
    expect(runbook).toContain("never values");
    expect(runbook).toContain("do not copy production");
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
