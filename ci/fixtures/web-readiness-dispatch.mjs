import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function shell(step, env, setup = "") {
  const result = spawnSync("/bin/bash", ["-c", `${setup}\n${step.run}`], { env, encoding: "utf8" });
  assert.ifError(result.error);
  return [result.status, result.stdout, result.stderr];
}

export function probeProjectionDispatch({ preflight, projection }) {
  const scope = preflight.steps[0];
  const pins = projection.steps[0];
  const execute = projection.steps.at(-1);
  const sha = "a".repeat(40);
  const context = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    BROADER_SCOPE_SECRETS: "false",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: "/dev/null",
  };
  const accepted = [0, "", ""];
  const refused = [1, "", "Readiness projection admission refused.\n"];
  assert.deepEqual(shell(scope, context), accepted);
  for (const override of [
    { GITHUB_EVENT_NAME: "workflow_call" },
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF_PROTECTED: "false" },
    { BROADER_SCOPE_SECRETS: "true" },
  ]) {
    assert.deepEqual(shell(scope, { ...context, ...override }), refused);
  }
  const approved = {
    GITHUB_RUN_ATTEMPT: "2",
    CHECKED_ATTEMPT: "2",
    GITHUB_SHA: sha,
    APPROVED_SHA: sha,
    PLAN_SHA256: "b".repeat(64),
  };
  assert.deepEqual(shell(pins, approved), accepted);
  for (const override of [
    { CHECKED_ATTEMPT: "" },
    { CHECKED_ATTEMPT: "1" },
    { APPROVED_SHA: "c".repeat(40) },
    { PLAN_SHA256: "" },
  ]) {
    assert.deepEqual(shell(pins, { ...approved, ...override }), refused);
  }
  const diagnostic = "node() { echo synthetic-url; echo driver-error >&2; return 1; }";
  assert.deepEqual(shell(execute, { OPERATION: "undo" }, diagnostic), [
    1,
    "",
    "Readiness projection operation did not confirm a commit.\n",
  ]);
}

export function probeIsolationDispatch({ preflight, isolation }) {
  const [scope] = preflight.steps;
  const [pins] = isolation.steps;
  const execute = isolation.steps.at(-1);
  const context = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    BROADER_SCOPE_SECRETS: "false",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: "/dev/null",
  };
  const accepted = [0, "", ""];
  const refused = [1, "", "Database serving ledger isolation admission refused.\n"];
  assert.deepEqual(shell(scope, context), accepted);
  for (const override of [
    { GITHUB_EVENT_NAME: "workflow_call" },
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF_PROTECTED: "false" },
    { BROADER_SCOPE_SECRETS: "true" },
  ]) {
    assert.deepEqual(shell(scope, { ...context, ...override }), refused);
  }
  const approved = {
    GITHUB_RUN_ATTEMPT: "2",
    CHECKED_ATTEMPT: "2",
    APPROVED_SHA: "a".repeat(40),
    PLAN_SHA256: "b".repeat(64),
  };
  assert.deepEqual(shell(pins, approved), accepted);
  for (const override of [
    { CHECKED_ATTEMPT: "" },
    { CHECKED_ATTEMPT: "1" },
    { APPROVED_SHA: "main" },
    { PLAN_SHA256: "" },
  ]) {
    assert.deepEqual(shell(pins, { ...approved, ...override }), refused);
  }
  const run = (operation, status) =>
    shell(
      execute,
      { OPERATION: operation, LEDGER: "1033_session-roles-checked-at" },
      `node() {
      [[ "$#" == 3 && "$1" == ci/db-serving-ledger-isolation-cli.mjs && "$2" == "$OPERATION" && "$3" == "$LEDGER" ]] || return 99
      echo synthetic-url; echo driver-error >&2; return ${status}
    }`,
    );
  for (const [operation, status, message] of [
    ["forward", 0, "Database serving ledger isolation committed."],
    ["undo", 0, "Database serving ledger isolation inverse committed."],
    ["readback", 10, "Database serving grants match the approved original state."],
    ["readback", 11, "Database serving grants match the approved isolated state."],
  ]) {
    assert.deepEqual(run(operation, status), [0, `${message}\n`, ""]);
  }
  for (const [operation, status] of [
    ["forward", 10],
    ["undo", 1],
    ["readback", 0],
  ]) {
    assert.deepEqual(run(operation, status), [
      1,
      "",
      "Database serving ledger isolation operation did not confirm an outcome.\n",
    ]);
  }
}
