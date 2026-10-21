import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    // production too, and production is live (docs/runbook.md), so the runbook
    // must coordinate the shared freeze explicitly without inventing a new
    // approval gate or changing runtime/config authority.
    expect(rollbackSection).not.toContain("production is pre-cutover");
    expect(rollbackSection).toContain("production is live");
    expect(rollbackSection).toContain("covers the production target");
    expect(rollbackSection).toContain("Coordinate the window explicitly");
    expect(rollbackSection).toContain("not a new approval gate");
    expect(rollbackSection).toContain("or config authority changes");
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

describe("rollback fail-closed structure", () => {
  const runbook = read("docs/jobs-handoff.md");
  const rollbackSection = runbook.split("## Rollback")[1]!.split("### First install")[0]!;

  it("wraps the rollback in an enclosing fail-fast boundary with preflight first", () => {
    expect(rollbackSection).toContain("(\n  set -euo pipefail");
    const order = [
      "Preflight: version pointers",
      "Preflight: rollback configs",
      "Preflight: live consumer",
      "Pause delivery",
      "Mutations in safe order",
      'wrangler rollback "$GOOD_JOBS_VERSION"',
      'wrangler rollback "$GOOD_WEB_VERSION"',
      "consumer remove",
      "consumer add",
      "triggers deploy",
      "Read back the live schedules",
      "Verify:",
      "touch ./.rollback-verified",
    ];
    let last = -1;
    for (const marker of order) {
      const at = rollbackSection.indexOf(marker);
      expect(at, `rollback order marker: ${marker}`).toBeGreaterThan(last);
      last = at;
    }
    expect(rollbackSection).toContain("bad Worker version ID");
    expect(rollbackSection).toContain("bad PRE_HANDOFF_SHA");
    expect(rollbackSection).toContain("FIRST_INSTALL");
    expect(rollbackSection).toContain("DELIVERY_WAS_ACTIVE");
    expect(rollbackSection).toContain("rollback preflight ok");
    expect(rollbackSection).not.toContain("rollback schedules ok");
    // The verified marker is single-use: cleared before any pause, written
    // only after the readbacks pass, consumed after resume.
    expect(rollbackSection).toContain("rm -f ./.rollback-verified");
  });

  it("makes consumer moves state-aware with exact --json matching", () => {
    expect(rollbackSection).toContain('consumer list "$q" --json');
    expect(rollbackSection).toContain("unexpected consumer");
    expect(rollbackSection).toContain("already web-only");
    expect(rollbackSection).toContain("never blindly add or remove");
    expect(rollbackSection).toContain("two-web-jobs-preview as");
    // The verify step re-reads live consumers and fails unless converged,
    // instead of printing the lists and marking verified regardless.
    expect(rollbackSection).toContain("expected exactly worker:two-web-next");
  });

  it("gates delivery resume on owned pauses and re-confirmed gates", () => {
    expect(rollbackSection).toContain(".rollback-paused-");
    expect(rollbackSection).toContain("no owned pause");
    expect(rollbackSection).toContain("refusing to resume");
    expect(rollbackSection).toContain("Delivery resume is owned and gated");
    expect(rollbackSection).toContain("left untouched");
    expect(rollbackSection).toContain("explicit Operator decision");
    expect(rollbackSection).toContain("Re-confirm the");
    expect(rollbackSection).toContain("re-run the `gh run list`");
    expect(rollbackSection).toContain("Never purge");
    // Pauses are state-aware: live delivery is read via the Queues API
    // (wrangler info prints none), unmarked paused queues are refused, and
    // stale markers on active queues are cleared before pausing fresh.
    expect(rollbackSection).toContain("delivery_paused");
    expect(rollbackSection).toContain("refusing to adopt");
    expect(rollbackSection).toContain("stale pause marker");
    expect(rollbackSection).toContain("single-use");
  });
});

describe("rollback fail-closed execution (hermetic stubs)", () => {
  const WEB_VERSION = "11111111-1111-1111-1111-111111111111";
  const JOBS_VERSION = "22222222-2222-2222-2222-222222222222";
  const PRE_SHA = "a".repeat(40);

  const goodWebConfig = JSON.stringify({
    triggers: { crons: [RECONCILE_CRON, PRUNE_CRON] },
    queues: {
      consumers: [{ queue: "two-sync-event" }, { queue: "two-internal-action" }],
    },
  });
  const goodJobsConfig = JSON.stringify({
    triggers: { crons: [] },
    queues: { consumers: [] },
  });
  const healthySchedules = JSON.stringify({
    "two-web-next": [RECONCILE_CRON, PRUNE_CRON],
    "two-web-jobs": [],
  });
  // Default stub shape is the documented Queues API worker-consumer shape
  // (script_name); consumersOfScript covers the alternate script shape so the
  // doc's `c.script ?? c.script_name` fallback stays pinned on both branches.
  const consumersOf = (...scripts: string[]) =>
    JSON.stringify(
      scripts.map((script_name, i) => ({
        script_name,
        type: "worker",
        consumer_id: String(1001 + i),
      })),
    );
  const consumersOfScript = (...scripts: string[]) =>
    JSON.stringify(
      scripts.map((script, i) => ({ script, type: "worker", consumer_id: String(1001 + i) })),
    );

  const extractBlocks = () => {
    const runbook = read("docs/jobs-handoff.md");
    const section = runbook.split("## Rollback")[1]!.split("### First install")[0]!;
    const fences = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(fences.length).toBe(2);
    return fences as [string, string];
  };

  const npxStub = [
    `#!${process.execPath}`,
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const argv = process.argv.slice(2);",
    'appendFileSync(process.env.STUB_LOG_NPX, JSON.stringify(argv) + "\\n");',
    'const wi = argv.indexOf("wrangler");',
    "const w = wi >= 0 ? argv.slice(wi) : argv;",
    'const joined = w.join(" ");',
    'const failAt = process.env.STUB_FAIL_AT ?? "";',
    'if (failAt !== "" && joined.includes(failAt)) { console.error("stub: injected failure"); process.exit(1); }',
    "// Stateful consumer lists: the first --json read seeds per-queue state",
    "// from STUB_CONSUMERS_*; remove/add mutate it, so the doc's verify",
    "// re-read observes post-mutation state. STUB_STUCK_CONSUMERS=1 leaves",
    "// state untouched to simulate mutations that exit 0 without converging.",
    'const stateDir = process.env.STUB_STATE_DIR ?? "";',
    "const stateFile = (q) => join(stateDir, `consumers-${q}.json`);",
    "const readState = (q) => {",
    '  if (stateDir !== "" && existsSync(stateFile(q))) return readFileSync(stateFile(q), "utf8");',
    '  const key = "STUB_CONSUMERS_" + String(q).toUpperCase().replace(/-/g, "_");',
    '  const initial = process.env[key] ?? "[]";',
    '  if (stateDir !== "") writeFileSync(stateFile(q), initial);',
    "  return initial;",
    "};",
    "const writeState = (q, json) => {",
    '  if (stateDir !== "") writeFileSync(stateFile(q), json);',
    "};",
    "const scriptOf = (c) => c.script ?? c.script_name ?? null;",
    'if (w[0] === "wrangler" && w[1] === "queues" && w[2] === "consumer" && w[3] === "list") {',
    '  const q = w[4] ?? "";',
    '  if (w.includes("--json")) {',
    "    process.stdout.write(readState(q));",
    "    process.exit(0);",
    "  }",
    '  process.stdout.write("stub consumers for " + q + "\\n");',
    "  process.exit(0);",
    "}",
    'if (w[0] === "wrangler" && w[1] === "queues" && w[2] === "consumer" && (w[3] === "remove" || w[3] === "add")) {',
    '  if (process.env.STUB_STUCK_CONSUMERS !== "1") {',
    '    const q = w[4] ?? "";',
    '    const target = w[5] ?? "";',
    "    const list = JSON.parse(readState(q));",
    '    if (w[3] === "remove") writeState(q, JSON.stringify(list.filter((c) => scriptOf(c) !== target)));',
    '    else writeState(q, JSON.stringify([...list, { script: target, type: "worker", consumer_id: "9001" }]));',
    "  }",
    '  process.stdout.write("stub ok\\n");',
    "  process.exit(0);",
    "}",
    'if (w[0] === "wrangler" && w[1] === "deployments" && w[2] === "status") { process.stdout.write("{}\\n"); process.exit(0); }',
    'if (w[0] === "wrangler" && (w[1] === "rollback" || w[1] === "queues" || w[1] === "triggers")) { process.stdout.write("stub ok\\n"); process.exit(0); }',
    'console.error("stub npx: unexpected invocation: " + joined);',
    "process.exit(2);",
  ].join("\n");

  const gitStub = [
    `#!${process.execPath}`,
    'import { appendFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    'appendFileSync(process.env.STUB_LOG_GIT, JSON.stringify(argv) + "\\n");',
    'const joined = argv.join(" ");',
    'const failAt = process.env.STUB_FAIL_AT ?? "";',
    'if (failAt !== "" && joined.includes(failAt)) { console.error("stub: injected failure"); process.exit(1); }',
    'if (argv[0] === "show" && typeof argv[1] === "string") {',
    "  const spec = argv[1];",
    '  if (spec.endsWith(":wrangler.jsonc")) { process.stdout.write(process.env.STUB_GIT_WEB_CONFIG ?? ""); process.exit(0); }',
    '  if (spec.endsWith(":wrangler.jobs.jsonc")) { process.stdout.write(process.env.STUB_GIT_JOBS_CONFIG ?? ""); process.exit(0); }',
    "}",
    'console.error("stub git: unexpected invocation: " + joined);',
    "process.exit(2);",
  ].join("\n");

  const curlStub = [
    `#!${process.execPath}`,
    'import { appendFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    'appendFileSync(process.env.STUB_LOG_CURL, JSON.stringify(argv) + "\\n");',
    'const joined = argv.join(" ");',
    'const failAt = process.env.STUB_FAIL_AT ?? "";',
    'if (failAt !== "" && joined.includes(failAt)) { console.error("stub: injected failure"); process.exit(1); }',
    'process.stdout.write(JSON.stringify({ db: "ok", pending_migrations: 0 }) + "\\n");',
    "process.exit(0);",
  ].join("\n");

  const fetchStub = [
    "const stub = process.env.STUB_SCHEDULES;",
    "if (stub === undefined) {",
    "  globalThis.fetch = async () => { throw new Error('network disabled in hermetic test'); };",
    "} else {",
    "  const payload = JSON.parse(stub);",
    "  globalThis.fetch = async (url) => {",
    "    const u = String(url);",
    "    const failAt = process.env.STUB_FETCH_FAIL_AT ?? '';",
    "    if (failAt !== '' && u.includes(failAt)) throw new Error('stub: injected fetch failure');",
    "    if (u.includes('/queues') && !u.includes('/consumers')) {",
    "      if (process.env.STUB_DELIVERY_ERROR === '1') {",
    "        return { json: async () => ({ success: false, errors: [{ message: 'stub delivery error' }] }) };",
    "      }",
    "      const pausedByQueue = JSON.parse(process.env.STUB_DELIVERY_PAUSED ?? '{}');",
    "      const result = ['two-sync-event', 'two-internal-action'].map((queue_name) => {",
    "        const v = pausedByQueue[queue_name];",
    "        return v === 'unknown'",
    "          ? { queue_name, settings: {} }",
    "          : { queue_name, settings: { delivery_paused: v ?? false } };",
    "      });",
    "      return { json: async () => ({ success: true, result }) };",
    "    }",
    "    const m = u.match(/\\/scripts\\/([^/]+)\\/schedules/);",
    '    const script = m ? m[1] : "unknown";',
    "    const crons = payload[script] ?? [];",
    "    return { json: async () => ({ success: true, result: { schedules: crons.map((cron) => ({ cron })) } }) };",
    "  };",
    "}",
  ].join("\n");

  type RunOpts = {
    env?: Record<string, string>;
    unset?: string[];
    preCreate?: string[];
    runResume?: boolean;
  };

  type RunResult = {
    mainStatus: number | null;
    mainStdout: string;
    mainStderr: string;
    npxCalls: string[][];
    gitCalls: string[][];
    curlCalls: number;
    markers: { sync: boolean; internal: boolean; verified: boolean };
    resumeStatus: number | null;
    resumeCalls: string[][];
    resumeMarkers: { sync: boolean; internal: boolean };
    resumeVerified: boolean | null;
  };

  const wranglerArgs = (argv: string[]) => {
    const i = argv.indexOf("wrangler");
    return i >= 0 ? argv.slice(i) : argv;
  };

  const isMutation = (argv: string[]) => {
    const w = wranglerArgs(argv);
    if (w[1] === "rollback") return true;
    if (w[1] === "triggers" && w[2] === "deploy") return true;
    if (w[1] === "queues" && w[2] === "consumer" && (w[3] === "remove" || w[3] === "add"))
      return true;
    if (w[1] === "queues" && (w[2] === "pause-delivery" || w[2] === "resume-delivery")) return true;
    return false;
  };

  const label = (argv: string[]) => {
    const w = wranglerArgs(argv);
    if (w[1] === "rollback") return `rollback ${w[4]}`;
    if (w[1] === "triggers") return `triggers ${w[4]}`;
    if (w[1] === "queues" && w[2] === "consumer") return `consumer ${w[3]} ${w[4]}`;
    if (w[1] === "queues") return `${w[2]} ${w[3]}`;
    return w.join(" ");
  };

  const childEnv = (stubs: string, base: Record<string, string>, fetchHref?: string) => {
    // Hermetic child: drop shell-init shims (BASH_ENV broker functions shadow
    // PATH lookups) and resolve only our stubs plus system tools plus the
    // exact running node (symlinked below), never broker or user PATH entries.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env.BASH_ENV;
    delete env.ENV;
    Object.assign(env, base);
    env.PATH = `${stubs}:/usr/local/bin:/usr/bin:/bin`;
    if (fetchHref !== undefined) env.NODE_OPTIONS = `--import ${fetchHref}`;
    else delete env.NODE_OPTIONS;
    return env;
  };

  const runRollback = (opts: RunOpts = {}): RunResult => {
    const root =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const temp = mkdtempSync(join(root, "rollback-hermetic-"));
    try {
      const stubs = join(temp, "stubs");
      mkdirSync(stubs, { recursive: true });
      writeFileSync(join(stubs, "npx"), npxStub, { mode: 0o700 });
      writeFileSync(join(stubs, "git"), gitStub, { mode: 0o700 });
      writeFileSync(join(stubs, "curl"), curlStub, { mode: 0o700 });
      symlinkSync(process.execPath, join(stubs, "node"));
      mkdirSync(join(temp, "ci"), { recursive: true });
      writeFileSync(join(temp, "ci", "wrangler-config.mjs"), read("ci/wrangler-config.mjs"));
      const fetchPath = join(temp, "fetch-stub.mjs");
      writeFileSync(fetchPath, fetchStub);
      const [mainBlock, resumeBlock] = extractBlocks();
      writeFileSync(join(temp, "main.sh"), `${mainBlock}\n`);
      writeFileSync(join(temp, "resume.sh"), `${resumeBlock}\n`);
      for (const f of opts.preCreate ?? []) writeFileSync(join(temp, f), "");
      const npxLog = join(temp, "npx.log");
      const gitLog = join(temp, "git.log");
      const curlLog = join(temp, "curl.log");
      writeFileSync(npxLog, "");
      writeFileSync(gitLog, "");
      writeFileSync(curlLog, "");
      const base: Record<string, string> = {
        GOOD_WEB_VERSION: WEB_VERSION,
        GOOD_JOBS_VERSION: JOBS_VERSION,
        PRE_HANDOFF_SHA: PRE_SHA,
        DELIVERY_WAS_ACTIVE: "1",
        CF_ACCOUNT_ID: "test-acct",
        CLOUDFLARE_API_TOKEN: "test-token",
        STUB_SCHEDULES: healthySchedules,
        STUB_DELIVERY_PAUSED: JSON.stringify({
          "two-sync-event": false,
          "two-internal-action": false,
        }),
        STUB_STATE_DIR: temp,
        STUB_CONSUMERS_TWO_SYNC_EVENT: consumersOf("two-web-jobs"),
        STUB_CONSUMERS_TWO_INTERNAL_ACTION: consumersOf("two-web-jobs"),
        STUB_GIT_WEB_CONFIG: goodWebConfig,
        STUB_GIT_JOBS_CONFIG: goodJobsConfig,
        STUB_LOG_NPX: npxLog,
        STUB_LOG_GIT: gitLog,
        STUB_LOG_CURL: curlLog,
        ...(opts.env ?? {}),
      };
      for (const k of opts.unset ?? []) delete base[k];
      const env = childEnv(stubs, base, pathToFileURL(fetchPath).href);
      const main = spawnSync("bash", ["main.sh"], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(main.error, "bash must exist").toBeUndefined();
      const parseLog = (p: string) =>
        readFileSync(p, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      const npxCalls = parseLog(npxLog);
      const gitCalls = parseLog(gitLog);
      const curlCalls = parseLog(curlLog).length;
      const markers = {
        sync: existsSync(join(temp, ".rollback-paused-two-sync-event")),
        internal: existsSync(join(temp, ".rollback-paused-two-internal-action")),
        verified: existsSync(join(temp, ".rollback-verified")),
      };
      let resumeStatus: number | null = null;
      let resumeCalls: string[][] = [];
      let resumeMarkers = { sync: markers.sync, internal: markers.internal };
      let resumeVerified: boolean | null = null;
      if (opts.runResume) {
        const resume = spawnSync("bash", ["resume.sh"], {
          cwd: temp,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(resume.error, "bash must exist").toBeUndefined();
        resumeStatus = resume.status;
        resumeCalls = parseLog(npxLog).slice(npxCalls.length);
        resumeMarkers = {
          sync: existsSync(join(temp, ".rollback-paused-two-sync-event")),
          internal: existsSync(join(temp, ".rollback-paused-two-internal-action")),
        };
        resumeVerified = existsSync(join(temp, ".rollback-verified"));
      }
      return {
        mainStatus: main.status,
        mainStdout: main.stdout?.toString() ?? "",
        mainStderr: main.stderr?.toString() ?? "",
        npxCalls,
        gitCalls,
        curlCalls,
        markers,
        resumeStatus,
        resumeCalls,
        resumeMarkers,
        resumeVerified,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };

  it("runs the happy path: preflight, owned pauses, safe-order mutations, verify, owned resume", () => {
    const r = runRollback({ runResume: true });
    expect(r.mainStatus, `main must exit 0: ${r.mainStderr}`).toBe(0);
    expect(r.npxCalls.filter(isMutation).map(label)).toEqual([
      "pause-delivery two-sync-event",
      "pause-delivery two-internal-action",
      "rollback two-web-jobs",
      "rollback two-web-next",
      "consumer remove two-sync-event",
      "consumer add two-sync-event",
      "consumer remove two-internal-action",
      "consumer add two-internal-action",
      "triggers ./rollback-wrangler.jsonc",
      "triggers ./rollback-wrangler.jobs.jsonc",
    ]);
    // Consumer mutations pin the full argv: the target script and the
    // pre-handoff retry/batch settings. A wrong target (two-web-jobs) or
    // wrong settings (1/1/1) must fail here, not pass green mid-incident.
    const consumerMutations = r.npxCalls
      .map(wranglerArgs)
      .filter(
        (w) => w[1] === "queues" && w[2] === "consumer" && (w[3] === "add" || w[3] === "remove"),
      );
    expect(consumerMutations.map((w) => `${w[3]} ${w[4]}`)).toEqual([
      "remove two-sync-event",
      "add two-sync-event",
      "remove two-internal-action",
      "add two-internal-action",
    ]);
    for (const w of consumerMutations) {
      if (w[3] === "remove") {
        expect(w.slice(4)).toEqual([w[4], "two-web-jobs"]);
      } else {
        expect(w.slice(4)).toEqual([
          w[4],
          "two-web-next",
          "--message-retries",
          "10",
          "--batch-size",
          "10",
          "--batch-timeout",
          "5",
        ]);
      }
    }
    expect(r.markers).toEqual({ sync: true, internal: true, verified: true });
    expect(r.resumeStatus).toBe(0);
    expect(r.resumeCalls.filter(isMutation).map(label)).toEqual([
      "resume-delivery two-sync-event",
      "resume-delivery two-internal-action",
    ]);
    expect(r.resumeMarkers).toEqual({ sync: false, internal: false });
    // The resume block consumes this run's verification: nothing is left for
    // a later run to mistake for its own authorization.
    expect(r.resumeVerified).toBe(false);
    const joined = r.npxCalls.map((c) => c.join(" ")).join("\n");
    expect(joined).not.toContain("purge");
    expect(joined).not.toContain("queues create");
    expect(joined).not.toContain("queues delete");
  });

  const preflightCases: Array<{ name: string; env?: Record<string, string>; unset?: string[] }> = [
    { name: "missing web pointer", unset: ["GOOD_WEB_VERSION"] },
    { name: "missing jobs pointer", unset: ["GOOD_JOBS_VERSION"] },
    { name: "missing pre-handoff SHA", unset: ["PRE_HANDOFF_SHA"] },
    { name: "missing delivery assertion", unset: ["DELIVERY_WAS_ACTIVE"] },
    { name: "delivery was not active", env: { DELIVERY_WAS_ACTIVE: "0" } },
    { name: "delivery assertion is not exactly 1", env: { DELIVERY_WAS_ACTIVE: "yes" } },
    { name: "missing CF account id", unset: ["CF_ACCOUNT_ID"] },
    { name: "missing API token", unset: ["CLOUDFLARE_API_TOKEN"] },
    { name: "malformed web pointer", env: { GOOD_WEB_VERSION: "not-a-uuid" } },
    {
      name: "uppercase web pointer",
      env: { GOOD_WEB_VERSION: "ABCDEF12-1111-1111-1111-111111111111" },
    },
    { name: "malformed jobs pointer", env: { GOOD_JOBS_VERSION: "zzz" } },
    { name: "short SHA", env: { PRE_HANDOFF_SHA: "abc123" } },
    { name: "non-hex SHA", env: { PRE_HANDOFF_SHA: "z".repeat(40) } },
    { name: "first-install with jobs pointer", env: { FIRST_INSTALL: "1" } },
  ];
  it.each(preflightCases)("invalid preflight causes zero mutations ($name)", ({ env, unset }) => {
    const r = runRollback({ env, unset });
    expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
    expect(r.npxCalls.filter(isMutation)).toEqual([]);
    expect(r.npxCalls).toEqual([]);
    expect(r.markers).toEqual({ sync: false, internal: false, verified: false });
  });

  const configCases: Array<{ name: string; env: Record<string, string> }> = [
    {
      name: "web config missing a cron",
      env: {
        STUB_GIT_WEB_CONFIG: JSON.stringify({
          triggers: { crons: [RECONCILE_CRON] },
          queues: { consumers: [{ queue: "two-sync-event" }, { queue: "two-internal-action" }] },
        }),
      },
    },
    {
      name: "web config with an extra cron",
      env: {
        STUB_GIT_WEB_CONFIG: JSON.stringify({
          triggers: { crons: [RECONCILE_CRON, PRUNE_CRON, "7 7 * * *"] },
          queues: { consumers: [{ queue: "two-sync-event" }, { queue: "two-internal-action" }] },
        }),
      },
    },
    {
      name: "jobs config still owns a cron",
      env: {
        STUB_GIT_JOBS_CONFIG: JSON.stringify({
          triggers: { crons: [RECONCILE_CRON] },
          queues: { consumers: [] },
        }),
      },
    },
    {
      name: "web consumers mismatch",
      env: {
        STUB_GIT_WEB_CONFIG: JSON.stringify({
          triggers: { crons: [RECONCILE_CRON, PRUNE_CRON] },
          queues: { consumers: [{ queue: "two-sync-event" }] },
        }),
      },
    },
    {
      name: "jobs config still owns consumers",
      env: {
        STUB_GIT_JOBS_CONFIG: JSON.stringify({
          triggers: { crons: [] },
          queues: { consumers: [{ queue: "two-sync-event" }] },
        }),
      },
    },
    { name: "unparseable web config", env: { STUB_GIT_WEB_CONFIG: "not json {" } },
  ];
  it.each(configCases)(
    "wrong pre-handoff configs fail before any Cloudflare mutation ($name)",
    ({ env }) => {
      const r = runRollback({ env });
      expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
      expect(r.npxCalls).toEqual([]);
      expect(r.gitCalls.length).toBeGreaterThan(0);
      expect(r.markers.verified).toBe(false);
    },
  );

  const ownershipCases: Array<{ name: string; env: Record<string, string> }> = [
    {
      name: "failed list",
      env: { STUB_FAIL_AT: "consumer list two-sync-event --json" },
    },
    {
      name: "unexpected worker",
      env: { STUB_CONSUMERS_TWO_SYNC_EVENT: consumersOf("evil-worker") },
    },
    {
      name: "preview worker is not the jobs worker",
      env: { STUB_CONSUMERS_TWO_INTERNAL_ACTION: consumersOf("two-web-jobs-preview") },
    },
    {
      name: "malformed list JSON",
      env: { STUB_CONSUMERS_TWO_SYNC_EVENT: "not json" },
    },
    {
      name: "non-array list",
      env: { STUB_CONSUMERS_TWO_SYNC_EVENT: JSON.stringify({ script: "two-web-jobs" }) },
    },
  ];
  it.each(ownershipCases)(
    "live ownership preflight fails closed with zero mutations ($name)",
    ({ env }) => {
      const r = runRollback({ env });
      expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
      expect(r.npxCalls.filter(isMutation)).toEqual([]);
      expect(r.markers).toEqual({ sync: false, internal: false, verified: false });
    },
  );

  it.each([
    { at: "pause-delivery two-sync-event", want: ["pause-delivery two-sync-event"] },
    {
      at: "pause-delivery two-internal-action",
      want: ["pause-delivery two-sync-event", "pause-delivery two-internal-action"],
    },
    {
      at: "two-web-jobs -y",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
      ],
    },
    {
      at: "two-web-next -y",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
      ],
    },
    {
      at: "consumer remove two-sync-event",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
      ],
    },
    {
      at: "consumer add two-sync-event",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
        "consumer add two-sync-event",
      ],
    },
    {
      at: "consumer remove two-internal-action",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
        "consumer add two-sync-event",
        "consumer remove two-internal-action",
      ],
    },
    {
      at: "consumer add two-internal-action",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
        "consumer add two-sync-event",
        "consumer remove two-internal-action",
        "consumer add two-internal-action",
      ],
    },
    {
      at: "triggers deploy --config ./rollback-wrangler.jsonc",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
        "consumer add two-sync-event",
        "consumer remove two-internal-action",
        "consumer add two-internal-action",
        "triggers ./rollback-wrangler.jsonc",
      ],
    },
    {
      at: "triggers deploy --config ./rollback-wrangler.jobs.jsonc",
      want: [
        "pause-delivery two-sync-event",
        "pause-delivery two-internal-action",
        "rollback two-web-jobs",
        "rollback two-web-next",
        "consumer remove two-sync-event",
        "consumer add two-sync-event",
        "consumer remove two-internal-action",
        "consumer add two-internal-action",
        "triggers ./rollback-wrangler.jsonc",
        "triggers ./rollback-wrangler.jobs.jsonc",
      ],
    },
  ])("failure injection at $at stops later mutations", ({ at, want }) => {
    const r = runRollback({ env: { STUB_FAIL_AT: at } });
    expect(r.mainStatus, `must fail at ${at}: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
    expect(r.npxCalls.filter(isMutation).map(label)).toEqual(want);
    expect(r.markers.verified).toBe(false);
  });

  it("schedule readback mismatch fails before verify with no verified marker", () => {
    const r = runRollback({
      env: {
        STUB_SCHEDULES: JSON.stringify({ "two-web-next": [RECONCILE_CRON], "two-web-jobs": [] }),
      },
    });
    expect(r.mainStatus).not.toBe(0);
    expect(r.markers.verified).toBe(false);
    expect(r.curlCalls).toBe(0);
  });

  it("first-install skips the jobs version rollback without defaulting", () => {
    const r = runRollback({
      env: { FIRST_INSTALL: "1" },
      unset: ["GOOD_JOBS_VERSION"],
    });
    expect(r.mainStatus, `must exit 0: ${r.mainStderr}`).toBe(0);
    const labels = r.npxCalls.filter(isMutation).map(label);
    expect(labels).not.toContain("rollback two-web-jobs");
    expect(labels).toContain("rollback two-web-next");
    expect(r.mainStdout).toContain("FIRST_INSTALL=1");
  });

  it.each([
    {
      name: "one queue already web-only is skipped",
      sync: consumersOf("two-web-next"),
      internal: consumersOf("two-web-jobs"),
      want: ["consumer remove two-internal-action", "consumer add two-internal-action"],
    },
    {
      name: "detached queues only add web",
      sync: consumersOf(),
      internal: consumersOf(),
      want: ["consumer add two-sync-event", "consumer add two-internal-action"],
    },
    {
      name: "doubled queues only remove jobs",
      sync: consumersOf("two-web-next", "two-web-jobs"),
      internal: consumersOf("two-web-jobs", "two-web-next"),
      want: ["consumer remove two-sync-event", "consumer remove two-internal-action"],
    },
    {
      name: "fully converged queues skip all consumer mutations",
      sync: consumersOf("two-web-next"),
      internal: consumersOf("two-web-next"),
      want: [],
    },
  ])("partial re-entry converges ($name)", ({ sync, internal, want }) => {
    const r = runRollback({
      env: { STUB_CONSUMERS_TWO_SYNC_EVENT: sync, STUB_CONSUMERS_TWO_INTERNAL_ACTION: internal },
    });
    expect(r.mainStatus, `must exit 0: ${r.mainStderr}`).toBe(0);
    const consumerMutations = r.npxCalls
      .filter(isMutation)
      .map(label)
      .filter((l) => l.startsWith("consumer "));
    expect(consumerMutations).toEqual(want);
  });

  it("re-entry with owned pause markers and live-paused delivery skips re-pausing", () => {
    const r = runRollback({
      preCreate: [".rollback-paused-two-sync-event", ".rollback-paused-two-internal-action"],
      env: {
        STUB_DELIVERY_PAUSED: JSON.stringify({
          "two-sync-event": true,
          "two-internal-action": true,
        }),
      },
    });
    expect(r.mainStatus, `must exit 0: ${r.mainStderr}`).toBe(0);
    const labels = r.npxCalls.filter(isMutation).map(label);
    expect(labels.filter((l) => l.startsWith("pause-delivery"))).toEqual([]);
    expect(labels).toContain("rollback two-web-next");
  });

  it("stale markers on live-active delivery are cleared and re-paused", () => {
    const r = runRollback({
      preCreate: [".rollback-paused-two-sync-event", ".rollback-paused-two-internal-action"],
    });
    expect(r.mainStatus, `must exit 0: ${r.mainStderr}`).toBe(0);
    const labels = r.npxCalls.filter(isMutation).map(label);
    expect(labels.filter((l) => l.startsWith("pause-delivery"))).toEqual([
      "pause-delivery two-sync-event",
      "pause-delivery two-internal-action",
    ]);
    expect(r.markers).toEqual({ sync: true, internal: true, verified: true });
    expect(r.mainStdout).toContain("stale pause marker");
  });

  it("unmarked live-paused queue fails without adopting another run's pause", () => {
    const r = runRollback({
      env: {
        STUB_DELIVERY_PAUSED: JSON.stringify({
          "two-sync-event": true,
          "two-internal-action": false,
        }),
      },
    });
    expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
    expect(r.npxCalls.filter(isMutation)).toEqual([]);
    expect(r.markers).toEqual({ sync: false, internal: false, verified: false });
    expect(r.mainStderr).toContain("refusing to adopt");
  });

  it.each<{ name: string; env: Record<string, string> }>([
    { name: "failed delivery read", env: { STUB_DELIVERY_ERROR: "1" } },
    {
      name: "unknown delivery state",
      env: {
        STUB_DELIVERY_PAUSED: JSON.stringify({
          "two-sync-event": "unknown",
          "two-internal-action": false,
        }),
      },
    },
    { name: "fetch failure on queues", env: { STUB_FETCH_FAIL_AT: "/queues" } },
  ])("delivery read failure fails closed with zero mutations ($name)", ({ env }) => {
    const r = runRollback({ env });
    expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
    expect(r.npxCalls.filter(isMutation)).toEqual([]);
    expect(r.markers).toEqual({ sync: false, internal: false, verified: false });
  });

  it("stale verified marker cannot authorize resume after a failed attempt", () => {
    const r = runRollback({
      runResume: true,
      preCreate: [".rollback-verified"],
      env: { STUB_FAIL_AT: "two-web-next -y" },
    });
    expect(r.mainStatus, `main must fail: ${r.mainStdout}`).not.toBe(0);
    expect(r.markers.verified).toBe(false);
    expect(r.resumeStatus, "resume must refuse without this run's verification").not.toBe(0);
    expect(r.resumeCalls.filter(isMutation)).toEqual([]);
  });

  it("unconverged consumers fail verify with no verified marker", () => {
    const r = runRollback({ env: { STUB_STUCK_CONSUMERS: "1" } });
    expect(r.mainStatus, `must fail: ${r.mainStdout}${r.mainStderr}`).not.toBe(0);
    expect(r.markers.verified).toBe(false);
    expect(r.curlCalls).toBe(0);
    expect(r.mainStderr).toContain("expected exactly worker:two-web-next");
  });

  it("consumer readback accepts script-shaped entries", () => {
    const r = runRollback({
      env: {
        STUB_CONSUMERS_TWO_SYNC_EVENT: consumersOfScript("two-web-jobs"),
        STUB_CONSUMERS_TWO_INTERNAL_ACTION: consumersOfScript("two-web-jobs"),
      },
    });
    expect(r.mainStatus, `must exit 0: ${r.mainStderr}`).toBe(0);
    expect(r.markers.verified).toBe(true);
  });

  it("resume without a verified main block refuses with zero resumes", () => {
    const r = runRollback({ runResume: true, env: { STUB_FAIL_AT: "next.togetherweown.com" } });
    expect(r.mainStatus).not.toBe(0);
    expect(r.markers.verified).toBe(false);
    expect(r.resumeStatus).not.toBe(0);
    expect(r.resumeCalls.filter(isMutation)).toEqual([]);
  });

  it("resume with no owned pauses leaves delivery untouched", () => {
    const root =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const temp = mkdtempSync(join(root, "rollback-resume-none-"));
    try {
      const stubs = join(temp, "stubs");
      mkdirSync(stubs, { recursive: true });
      writeFileSync(join(stubs, "npx"), npxStub, { mode: 0o700 });
      const [, resumeBlock] = extractBlocks();
      writeFileSync(join(temp, "resume.sh"), `${resumeBlock}\n`);
      writeFileSync(join(temp, ".rollback-verified"), "");
      const npxLog = join(temp, "npx.log");
      writeFileSync(npxLog, "");
      const env = childEnv(stubs, { STUB_LOG_NPX: npxLog });
      const resume = spawnSync("bash", ["resume.sh"], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(resume.error).toBeUndefined();
      expect(resume.status).toBe(0);
      const calls = readFileSync(npxLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter(isMutation)).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("resume with one owned pause resumes only that queue", () => {
    const root =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const temp = mkdtempSync(join(root, "rollback-resume-"));
    try {
      const stubs = join(temp, "stubs");
      mkdirSync(stubs, { recursive: true });
      writeFileSync(join(stubs, "npx"), npxStub, { mode: 0o700 });
      const [, resumeBlock] = extractBlocks();
      writeFileSync(join(temp, "resume.sh"), `${resumeBlock}\n`);
      writeFileSync(join(temp, ".rollback-verified"), "");
      writeFileSync(join(temp, ".rollback-paused-two-sync-event"), "");
      const npxLog = join(temp, "npx.log");
      writeFileSync(npxLog, "");
      const env = childEnv(stubs, { STUB_LOG_NPX: npxLog });
      const resume = spawnSync("bash", ["resume.sh"], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(resume.error).toBeUndefined();
      expect(resume.status).toBe(0);
      const calls = readFileSync(npxLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter(isMutation).map(label)).toEqual(["resume-delivery two-sync-event"]);
      expect(existsSync(join(temp, ".rollback-paused-two-sync-event"))).toBe(false);
      expect(existsSync(join(temp, ".rollback-paused-two-internal-action"))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
