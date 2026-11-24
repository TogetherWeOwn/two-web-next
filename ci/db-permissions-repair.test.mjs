import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = parse(read("../.github/workflows/db-permissions-repair.yml"));

test("repair dispatch isolates the credential and pins protected main and the same attempt", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.jobs.preflight.environment, undefined);
  const job = workflow.jobs.repair;
  assert.equal(job.environment, "production");
  assert.equal(job.needs, "preflight");
  assert.deepEqual(workflow.concurrency, {
    group: "web-migrate-production",
    "cancel-in-progress": false,
  });
  assert.deepEqual(job.steps[1].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  const scope = workflow.jobs.preflight.steps[0];
  const gate = job.steps[0];
  const run = job.steps.at(-1);
  const sha = "a".repeat(40);
  const shell = (script, env, prefix = "") =>
    spawnSync("/bin/bash", ["-c", `${prefix}\n${script}`], { env, encoding: "utf8" });
  const context = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    BROADER_SCOPE_SECRETS: "false",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: "/dev/null",
  };
  assert.equal(shell(scope.run, context).status, 0);
  for (const override of [
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_EVENT_NAME: "workflow_call" },
    { BROADER_SCOPE_SECRETS: "true" },
  ]) {
    assert.equal(shell(scope.run, { ...context, ...override }).status, 1);
  }
  const pins = {
    CHECKED_ATTEMPT: "2",
    GITHUB_RUN_ATTEMPT: "2",
    APPROVED_SHA: sha,
    GITHUB_SHA: sha,
    PLAN_SHA256: "b".repeat(64),
  };
  assert.equal(shell(gate.run, pins).status, 0);
  for (const override of [
    { CHECKED_ATTEMPT: "1" },
    { APPROVED_SHA: "c".repeat(40) },
    { PLAN_SHA256: "" },
  ]) {
    assert.equal(shell(gate.run, { ...pins, ...override }).status, 1);
  }
  const dsn = "${{ secrets.PRODUCTION_DB_REPAIR_DATABASE_URL }}";
  assert.equal(run.env.PRODUCTION_DB_REPAIR_DATABASE_URL, dsn);
  assert.equal(JSON.stringify(workflow).split(dsn).length, 2);
  for (const [operation, code, line] of [
    ["forward", 0, "Database permissions repair committed."],
    ["undo", 0, "Database permissions repair inverse committed."],
    ["readback", 10, "Database permissions match the approved pre-repair state."],
    ["readback", 11, "Database permissions match the approved post-repair state."],
    ["forward", 143, "Database permissions operation did not confirm an outcome."],
    ["undo", 10, "Database permissions operation did not confirm an outcome."],
  ]) {
    const result = shell(
      run.run,
      { OPERATION: operation },
      `node() {
      printf 'fixture credential to stdout'; printf 'fixture driver diagnostic' >&2; return ${code};
    }`,
    );
    const success = code === 0 || operation === "readback";
    assert.equal(result.status, success ? 0 : 1);
    assert.equal(result.stdout, success ? `${line}\n` : "");
    assert.equal(result.stderr, success ? "" : `${line}\n`);
  }
});
