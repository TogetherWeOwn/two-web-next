import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deploymentTarget, requireSuccessfulCi } from "./staging-deploy-gate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "TogetherWeOwn/two-web-next";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const run = {
  id: 42, run_attempt: 1, head_sha: sha, head_branch: "main", event: "push",
  path: ".github/workflows/ci.yml", head_repository: { full_name: repository },
  status: "completed", conclusion: "success",
};
function context(eventName) {
  return {
    eventName, repository, ref: "refs/heads/main", checkoutSha: sha,
    // Deliberately newer default-branch tip for workflow_run.
    sha: eventName === "workflow_run" ? otherSha : sha,
    event: { repository: { full_name: repository }, workflow_run: structuredClone(run) },
  };
}
function fixture() {
  return {
    runs: { total_count: 1, workflow_runs: [structuredClone(run)] },
    jobs: { total_count: 2, jobs: ["a11y", "check"].map((name) => ({ name, head_sha: sha, status: "completed", conclusion: "success" })) },
    current: structuredClone(run),
  };
}

const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
function step(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(block, `Missing workflow step: ${name}`);
  assert.doesNotMatch(block, /^        if:/m, "The gate and mutations must use default success semantics");
  const match = block.match(/^        run: (.+)(?:\n|$)/m);
  assert.ok(match);
  if (match[1] !== "|") return match[1];
  return block.split("        run: |\n")[1].split(/^        \S/m)[0].replace(/^          /gm, "").trim();
}
const gateCommand = step("Require successful exact-SHA full CI");
const queueCommand = step("Ensure queues exist");
const deployCommand = step("Deploy to Cloudflare Workers");

function executeStaging(ctx, evidence, changes = {}) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "staging-gate-"));
  try {
    writeFileSync(join(dir, "event.json"), JSON.stringify(ctx.event));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence));
    writeFileSync(join(dir, "changes.json"), JSON.stringify(changes));
    writeFileSync(join(dir, "transition.mjs"), `
      import { readFileSync, writeFileSync } from "node:fs";
      const changes = JSON.parse(readFileSync(process.env.TEST_CHANGES, "utf8"));
      if (changes[process.argv[2]]) writeFileSync(process.env.TEST_EVIDENCE, JSON.stringify(changes[process.argv[2]]));
    `);
    writeFileSync(join(dir, "git"), '#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] || [ "$*" = "-c safe.directory=$PWD rev-parse HEAD" ] || exit 1\nprintf "%s\\n" "$TEST_CHECKOUT_SHA"\n', { mode: 0o755 });
    writeFileSync(join(dir, "npx"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\nnode "$TEST_TRANSITION" "$*"\n', { mode: 0o755 });
    writeFileSync(join(dir, "fetch.mjs"), `
      import { readFileSync } from "node:fs";
      const evidence = JSON.parse(readFileSync(process.env.TEST_EVIDENCE, "utf8"));
      globalThis.fetch = async (url, options) => {
        if (evidence.networkError) throw new Error("Stubbed network failure");
        const parsed = new URL(url);
        if (parsed.origin !== "https://api.github.com" || options.method && options.method !== "GET") throw new Error("Unexpected API call");
        let data;
        if (parsed.pathname.endsWith("/workflows/ci.yml/runs")) {
          if (parsed.searchParams.get("head_sha") !== "${sha}" || parsed.searchParams.get("branch") !== "main" || parsed.searchParams.get("event") !== "push" || parsed.searchParams.has("status")) throw new Error("Unsafe CI query");
          data = evidence.runs;
        } else if (parsed.pathname.endsWith("/runs/42/jobs")) {
          if (parsed.searchParams.get("filter") !== "latest") throw new Error("Stale jobs query");
          data = evidence.jobs;
        } else if (parsed.pathname.endsWith("/runs/42")) data = evidence.current;
        else throw new Error("Unexpected API path");
        return { ok: !evidence.httpError, status: evidence.httpError ?? 200, json: async () => {
          if (evidence.invalidJson) throw new Error("Invalid JSON");
          return data;
        }};
      };
    `);
    const result = spawnSync("bash", ["-c", `set -e\n${gateCommand}\nnode "$TEST_TRANSITION" afterPreparation\n${queueCommand}\n${deployCommand}`], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: {
        PATH: `${dir}:${process.env.PATH}`, NODE_OPTIONS: `--import=${join(dir, "fetch.mjs")}`,
        GITHUB_EVENT_NAME: ctx.eventName, GITHUB_EVENT_PATH: join(dir, "event.json"),
        GITHUB_REPOSITORY: ctx.repository, GITHUB_REF: ctx.ref, GITHUB_SHA: ctx.sha,
        GITHUB_TOKEN: "offline-stub", TEST_CHECKOUT_SHA: ctx.checkoutSha,
        TEST_EVIDENCE: join(dir, "evidence.json"), TEST_CALLS: join(dir, "calls"),
        TEST_TRANSITION: join(dir, "transition.mjs"), TEST_CHANGES: join(dir, "changes.json"),
      },
    });
    let calls = [];
    try { calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const denied = [
  ["missing", (f) => { f.runs = { total_count: 0, workflow_runs: [] }; }],
  ["ambiguous", (f) => { f.runs.total_count = 2; f.runs.workflow_runs.push(structuredClone(run)); }],
  ["truncated runs", (f) => { f.runs.total_count = 2; }],
  ["wrong SHA", (f) => { f.runs.workflow_runs[0].head_sha = otherSha; }],
  ["wrong branch", (f) => { f.runs.workflow_runs[0].head_branch = "topic"; }],
  ["PR evidence", (f) => { f.runs.workflow_runs[0].event = "pull_request"; }],
  ["wrong workflow", (f) => { f.runs.workflow_runs[0].path = ".github/workflows/deploy.yml"; }],
  ["foreign repository", (f) => { f.runs.workflow_runs[0].head_repository.full_name = "foreign/repo"; }],
  ...["queued", "in_progress", "waiting"].map((status) => [status, (f) => { f.runs.workflow_runs[0].status = status; }]),
  ...["failure", "cancelled", "skipped", "neutral", "timed_out", null].map((conclusion) => [String(conclusion), (f) => { f.runs.workflow_runs[0].conclusion = conclusion; }]),
  ["missing a11y", (f) => { f.jobs.jobs.shift(); f.jobs.total_count = 1; }],
  ["missing check", (f) => { f.jobs.jobs.pop(); f.jobs.total_count = 1; }],
  ["duplicate check", (f) => { f.jobs.jobs.push(structuredClone(f.jobs.jobs[1])); f.jobs.total_count = 3; }],
  ["truncated jobs", (f) => { f.jobs.total_count = 101; }],
  ["wrong job SHA", (f) => { f.jobs.jobs[1].head_sha = otherSha; }],
  ["skipped check", (f) => { f.jobs.jobs[1].conclusion = "skipped"; }],
  ["failed a11y", (f) => { f.jobs.jobs[0].conclusion = "failure"; }],
  ["pending check", (f) => { f.jobs.jobs[1].status = "in_progress"; }],
  ["rerun started", (f) => { f.current.status = "in_progress"; }],
  ["attempt changed", (f) => { f.current.run_attempt = 2; }],
  ["HTTP 403", (f) => { f.httpError = 403; }],
  ["network unavailable", (f) => { f.networkError = true; }],
  ["malformed response", (f) => { f.invalidJson = true; }],
];

for (const eventName of ["workflow_run", "workflow_dispatch"]) {
  for (const [name, mutate] of denied) {
    test(`${eventName}: ${name} makes no queue/deploy calls`, () => {
      const evidence = fixture();
      mutate(evidence);
      const result = executeStaging(context(eventName), evidence);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.calls, []);
      assert.match(result.stderr, /Staging gate refused:/);
    });
  }
  test(`${eventName}: successful same-SHA full CI allows exactly the staging commands`, () => {
    const result = executeStaging(context(eventName), fixture());
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ["wrangler queues create two-sync-event", "wrangler queues create two-internal-action", "wrangler deploy"]);
    assert.match(result.stdout, new RegExp(`Staging gate passed: ${sha}`));
  });
  test(`${eventName}: checkout mismatch makes no queue/deploy calls`, () => {
    const ctx = context(eventName);
    ctx.checkoutSha = otherSha;
    const result = executeStaging(ctx, fixture());
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr, /Checkout does not match deployment SHA/);
  });
}

const mutationCalls = ["wrangler queues create two-sync-event", "wrangler queues create two-internal-action", "wrangler deploy"];
for (const eventName of ["workflow_run", "workflow_dispatch"]) {
  for (const [phase, allowedCalls] of [["afterPreparation", 0], [mutationCalls[0], 1], [mutationCalls[1], 2]]) {
    for (const [name, mutate] of denied.filter(([name]) => ["missing", "wrong SHA", "in_progress", "failure", "cancelled"].includes(name))) {
      test(`${eventName}: ${name} after ${phase} stops the next mutation`, () => {
        const changed = fixture();
        mutate(changed);
        if (changed.runs.workflow_runs.length) {
          changed.runs.workflow_runs[0].run_attempt = 2;
          changed.current = structuredClone(changed.runs.workflow_runs[0]);
        }
        const result = executeStaging(context(eventName), fixture(), { [phase]: changed });
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(result.calls, mutationCalls.slice(0, allowedCalls));
        assert.match(result.stderr, /Staging gate refused:/);
      });
    }
  }
}

test("real Git accepts only the current checkout despite a container owner mismatch", () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "staging-gate-owner-"));
  try {
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    function git(args) {
      const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    git(["init", "--quiet"]);
    git(["-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    const checkoutSha = git(["rev-parse", "HEAD"]);
    env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    const bare = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(bare.status, 128, bare.stderr);
    assert.match(bare.stderr, /dubious ownership/);
    const ctx = context("workflow_dispatch");
    ctx.sha = checkoutSha;
    const evidence = fixture();
    evidence.runs.workflow_runs[0].head_sha = checkoutSha;
    evidence.current.head_sha = checkoutSha;
    for (const job of evidence.jobs.jobs) job.head_sha = checkoutSha;
    writeFileSync(join(dir, "event.json"), JSON.stringify(ctx.event));
    writeFileSync(join(dir, "fetch.mjs"), `
      const evidence = ${JSON.stringify(evidence)};
      globalThis.fetch = async (url) => ({ ok: true, json: async () => {
        const path = new URL(url).pathname;
        if (path.endsWith("/workflows/ci.yml/runs")) return evidence.runs;
        if (path.endsWith("/runs/42/jobs")) return evidence.jobs;
        if (path.endsWith("/runs/42")) return evidence.current;
        throw new Error("Unexpected API path");
      }});
    `);
    const result = spawnSync(process.execPath, [join(root, "ci/staging-deploy-gate.mjs")], {
      cwd: dir, encoding: "utf8", timeout: 15_000,
      env: { ...env, NODE_OPTIONS: `--import=${join(dir, "fetch.mjs")}`,
        GITHUB_EVENT_NAME: ctx.eventName, GITHUB_EVENT_PATH: join(dir, "event.json"),
        GITHUB_REPOSITORY: repository, GITHUB_REF: ctx.ref, GITHUB_SHA: checkoutSha, GITHUB_TOKEN: "offline-stub" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Staging gate passed: ${checkoutSha}`));
    // Trust is command-scoped: the next bare Git call still refuses this repo.
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).status, 128);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejected completion events never enter staging job concurrency", () => {
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(workflow, /    concurrency:\n      group: deploy-staging\n      cancel-in-progress: false/);
  const expression = workflow.match(/    if: >-\n((?:      .*\n)+)/)[1];
  const accepts = new Function("github", `return ${expression}`);
  const github = { event_name: "workflow_run", repository, event: context("workflow_run").event };
  assert.equal(accepts(github), true);
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    github.event.workflow_run.conclusion = conclusion;
    assert.equal(accepts(github), false);
  }
  assert.equal(accepts({ event_name: "workflow_dispatch", ref: "refs/heads/main" }), true);
  assert.equal(accepts({ event_name: "workflow_dispatch", ref: "refs/heads/topic" }), false);
});

test("trigger identity is pinned, main-only and never taken from PR or fork evidence", () => {
  assert.equal(deploymentTarget(context("workflow_run")), sha);
  assert.equal(deploymentTarget(context("workflow_dispatch")), sha);
  const ctx = context("workflow_dispatch");
  ctx.ref = "refs/heads/topic";
  assert.throws(() => deploymentTarget(ctx), /main-only/);
  for (const mutate of [
    (c) => { c.event.workflow_run.event = "pull_request"; },
    (c) => { c.event.workflow_run.head_repository.full_name = "foreign/repo"; },
    (c) => { c.event.workflow_run.conclusion = "failure"; },
    (c) => { c.event.repository.full_name = "foreign/repo"; },
    (c) => { c.eventName = "push"; },
    (c) => { c.event.workflow_run.head_sha = "main"; },
  ]) {
    const automatic = context("workflow_run");
    mutate(automatic);
    assert.throws(() => deploymentTarget(automatic));
  }
});

test("a stale automatic run ID/attempt or missing token refuses before Cloudflare", async () => {
  for (const field of ["id", "run_attempt"]) {
    const ctx = context("workflow_run");
    ctx.event.workflow_run[field]++;
    const result = executeStaging(ctx, fixture());
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  }
  await assert.rejects(requireSuccessfulCi(context("workflow_dispatch"), { fetchImpl: () => assert.fail("No request without token") }), /Missing read-only/);
});

test("workflow wires the tested gate before both mutations and preserves staging isolation", () => {
  assert.match(workflow, /workflow_run:\n    workflows: \[ci\]\n    types: \[completed\]\n    branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /ref: \$\{\{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha \|\| github.sha \}\}/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github.event.workflow_run.event == 'push'/);
  assert.match(workflow, /github.event.workflow_run.head_repository.full_name == github.repository/);
  assert.match(workflow, /github.event.workflow_run.conclusion == 'success'/);
  assert.match(workflow, /contents: read\n  actions: read/);
  assert.match(workflow, /runs-on: \[self-hosted, two-selfhosted\]/);
  assert.match(workflow, /container:\n      image: node:24-bookworm/);
  assert.match(workflow, /environment:\n      name: staging\n      url: https:\/\/next.togetherweown.com/);
  assert.match(workflow, /name: Smoke test staging/);
  assert.equal(gateCommand, "node ci/staging-deploy-gate.mjs");
  const gateOffset = workflow.indexOf("- name: Require successful exact-SHA full CI");
  assert.ok(gateOffset < workflow.indexOf("- name: Ensure queues exist"));
  assert.ok(gateOffset < workflow.indexOf("- name: Deploy to Cloudflare Workers"));
  assert.equal((workflow.match(/npx wrangler/g) ?? []).length, 2, "No additional ungated mutations");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /run: node --test ci\/staging-deploy-gate-selftest.mjs/);
});
