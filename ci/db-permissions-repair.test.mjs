import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = parse(read("../.github/workflows/db-permissions-repair.yml"));
const shell = (script, env, prefix = "") =>
  spawnSync("/bin/bash", ["-c", `${prefix}\n${script}`], { env, encoding: "utf8" });

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
    "fetch-depth": 0,
  });
  const scope = workflow.jobs.preflight.steps[0];
  const gate = job.steps[0];
  const run = job.steps.at(-1);
  const sha = "a".repeat(40);
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
    { APPROVED_SHA: "not-a-sha" },
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

test("database repair recovery pins an unchanged dispatcher and a main ancestor", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "db-repair-revision-"));
  t.after(() => rmSync(cwd, { recursive: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, contents) => {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const repair = ".github/workflows/db-permissions-repair.yml";
  const executor = ".github/workflows/db-repair-executor.yml";
  const selector = ".github/scripts/select-db-repair-revision.sh";
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "-qm", "before recovery rollout", "--allow-empty");
  const beforeRollout = git("rev-parse", "HEAD");
  for (const path of [repair, executor, selector]) write(path, read(`../${path}`));
  git("add", ".");
  git("commit", "-qm", "approved source");
  const approved = git("rev-parse", "HEAD");
  git("commit", "-qm", "main advanced", "--allow-empty");
  const tip = git("rev-parse", "HEAD");
  git("checkout", "--detach", approved);
  git("commit", "-qm", "unmerged source", "--allow-empty");
  const unrelated = git("rev-parse", "HEAD");

  const select = (path, operation, dispatch, pin, workflowSha = dispatch) => {
    git("checkout", "--detach", dispatch);
    const yaml = parse(readFileSync(join(cwd, path), "utf8"));
    const step = Object.values(yaml.jobs)
      .flatMap((job) => job.steps)
      .find(({ name }) => name === "Select the approved database repair revision");
    const result = spawnSync("/bin/bash", ["-c", step.run], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OPERATION: operation,
        APPROVED_SHA: pin,
        GITHUB_SHA: dispatch,
        GITHUB_WORKFLOW_SHA: workflowSha,
      },
    });
    return [result.status, git("rev-parse", "HEAD")];
  };
  assert.deepEqual(select(repair, "forward", tip, tip), [0, tip]);
  assert.deepEqual(select(executor, "provision", tip, tip), [0, tip]);
  for (const [path, operation] of [
    [repair, "undo"],
    [repair, "readback"],
    [executor, "revoke"],
  ]) {
    assert.deepEqual(select(path, operation, tip, approved), [0, approved]);
    assert.deepEqual(select(path, operation, tip, unrelated), [1, tip]);
    assert.deepEqual(select(path, operation, tip, approved, unrelated), [1, tip]);
    assert.deepEqual(select(path, operation, tip, beforeRollout), [1, tip]);
  }
  assert.deepEqual(select(repair, "forward", tip, approved), [1, tip]);
  assert.deepEqual(select(executor, "provision", tip, approved), [1, tip]);
  write(repair, `${read(`../${repair}`)}\n# changed dispatcher\n`);
  git("commit", "-qam", "changed dispatcher");
  const changed = git("rev-parse", "HEAD");
  assert.deepEqual(select(repair, "undo", changed, approved), [1, changed]);
  write(selector, `${read(`../${selector}`)}\n# changed selector\n`);
  git("commit", "-qam", "changed selector");
  const changedSelector = git("rev-parse", "HEAD");
  assert.deepEqual(select(executor, "revoke", changedSelector, approved), [1, changedSelector]);
});

test("executor dispatch scopes its credential and suppresses subprocess output", () => {
  const workflow = parse(read("../.github/workflows/db-repair-executor.yml"));
  const { preflight, authority } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ["provision", "revoke"]);
  assert.equal(preflight.environment, undefined);
  assert.equal(authority.environment, "production");
  assert.equal(authority.needs, "preflight");
  assert.deepEqual(workflow.concurrency, {
    group: "web-migrate-production",
    "cancel-in-progress": false,
  });
  assert.deepEqual(authority.steps[1].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
    "fetch-depth": 0,
  });
  const gate = authority.steps[0];
  const sha = "a".repeat(40);
  assert.equal(
    shell(gate.run, {
      GITHUB_SHA: sha,
      APPROVED_SHA: sha,
      GITHUB_RUN_ATTEMPT: "2",
      CHECKED_ATTEMPT: "1",
      PLAN_SHA256: "b".repeat(64),
    }).status,
    1,
  );
  const run = authority.steps.at(-1);
  const dsn = "${{ secrets.PRODUCTION_DB_EXECUTOR_DATABASE_URL }}";
  assert.equal(run.env.PRODUCTION_DB_EXECUTOR_DATABASE_URL, dsn);
  assert.equal(JSON.stringify(workflow).split(dsn).length, 2);
  assert.ok(!JSON.stringify(workflow).includes("PRODUCTION_DB_REPAIR_DATABASE_URL"));
  for (const code of [0, 1]) {
    const result = shell(
      run.run,
      { OPERATION: "revoke" },
      `node() { printf 'fixture credential'; printf 'fixture error' >&2; return ${code}; }`,
    );
    assert.equal(result.status, code);
    assert.equal(result.stdout, code ? "" : "Approved executor membership state confirmed.\n");
    assert.equal(
      result.stderr,
      code ? "Executor membership operation did not confirm an outcome.\n" : "",
    );
  }
});
