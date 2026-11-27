import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { PLANETSCALE_PRODUCTION_BRANCH_ID, PLANETSCALE_PRODUCTION_HOST } from "./db-migrate.mjs";
import { runRepair } from "./db-permissions-repair.mjs";
import { runServingIsolation } from "./db-serving-ledger-isolation.mjs";

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
    { APPROVED_SHA: "" },
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
  const isolation = ".github/workflows/db-serving-ledger-isolation.yml";
  const selector = ".github/scripts/select-db-repair-revision.sh";
  const isolationSelector = ".github/scripts/select-db-serving-isolation-revision.sh";
  const releaseInputs = [
    "drizzle/1034_event-echoes.sql",
    "ci/db-repair-executor.mjs",
    ".github/workflows/deploy.yml",
  ];
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "-qm", "before recovery rollout", "--allow-empty");
  const beforeRollout = git("rev-parse", "HEAD");
  for (const path of [repair, executor, selector]) write(path, read(`../${path}`));
  git("add", ".");
  git("commit", "-qm", "repair recovery available");
  const beforeIsolation = git("rev-parse", "HEAD");
  for (const path of [isolation, isolationSelector]) write(path, read(`../${path}`));
  for (const path of releaseInputs) write(path, "Reviewed source fixture\n");
  git("add", ".");
  git("commit", "-qm", "candidate with exact release approval");
  const approved = git("rev-parse", "HEAD");
  const unrelatedDoc = "docs/contributing-example.md";
  write(unrelatedDoc, "# Unrelated prose\n");
  git("add", ".");
  git("commit", "-qm", "main advanced with unrelated prose");
  const tip = git("rev-parse", "HEAD");
  git("checkout", "--detach", approved);
  git("commit", "-qm", "unmerged source", "--allow-empty");
  const unrelated = git("rev-parse", "HEAD");

  const select = (path, operation, dispatch, pin, workflowSha = dispatch) => {
    git("checkout", "--detach", dispatch);
    const yaml = parse(readFileSync(join(cwd, path), "utf8"));
    const step = Object.values(yaml.jobs)
      .flatMap((job) => job.steps)
      .find(
        ({ name }) =>
          name ===
          (path === isolation
            ? "Select the approved serving isolation revision"
            : "Select the approved database repair revision"),
      );
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
  const diagnostic = fileURLToPath(new URL("./diagnose-db-repair-revision.mjs", import.meta.url));
  const diagnose = (...shas) =>
    spawnSync(process.execPath, [diagnostic, ...shas], { cwd, encoding: "utf8" });
  const compare = (dispatch, pin = approved) => {
    const result = diagnose(pin, dispatch);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  // Give the fixture a valid source and exact pins. CI, staging, isolation and
  // independent release approval are operator evidence outside this workflow.
  assert.deepEqual(select(repair, "forward", approved, approved), [0, approved]);
  assert.equal(compare(approved).forward, "SHA matches");
  assert.deepEqual(select(repair, "forward", tip, tip), [0, tip]);
  assert.deepEqual(select(executor, "provision", tip, tip), [0, tip]);
  assert.deepEqual(select(isolation, "forward", tip, tip), [0, tip]);
  for (const [path, operation] of [
    [repair, "undo"],
    [repair, "readback"],
    [executor, "revoke"],
    [isolation, "undo"],
    [isolation, "readback"],
  ]) {
    assert.deepEqual(select(path, operation, tip, approved), [0, approved]);
    assert.deepEqual(select(path, operation, tip, unrelated), [1, tip]);
    assert.deepEqual(select(path, operation, tip, approved, unrelated), [1, tip]);
    assert.deepEqual(select(path, operation, tip, beforeRollout), [1, tip]);
  }
  assert.deepEqual(select(repair, "forward", tip, approved), [1, tip]);
  assert.deepEqual(compare(tip), {
    approved,
    dispatch: tip,
    forward: "Dispatch SHA differs from approval pin",
    undo: "Revision check matches",
    unavailableDispatchPaths: [],
    changedRecoveryPaths: [],
    changedPaths: [unrelatedDoc],
  });
  for (const operation of ["forward", "undo"]) {
    assert.deepEqual(select(repair, operation, approved, approved, ""), [1, approved]);
  }
  for (const shas of [
    [unrelated, tip],
    ["f".repeat(40), tip],
    [approved],
    [approved.slice(0, 7), tip],
    [approved, `${tip}f`],
    [`g${approved.slice(1)}`, tip],
  ]) {
    const result = diagnose(...shas);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  for (const path of releaseInputs) {
    git("checkout", "--detach", approved);
    write(path, "Changed source fixture\n");
    git("add", ".");
    git("commit", "-qm", `changed ${path}`);
    const changed = git("rev-parse", "HEAD");
    assert.deepEqual(select(repair, "forward", changed, approved), [1, changed]);
    assert.deepEqual(select(repair, "undo", changed, approved), [0, approved]);
    const comparison = compare(changed);
    assert.equal(comparison.forward, "Dispatch SHA differs from approval pin");
    assert.equal(comparison.undo, "Revision check matches");
    assert.deepEqual(comparison.changedRecoveryPaths, []);
    assert.deepEqual(comparison.changedPaths, [path]);
  }
  assert.deepEqual(select(executor, "provision", tip, approved), [1, tip]);
  assert.deepEqual(select(isolation, "forward", tip, approved), [1, tip]);
  assert.deepEqual(select(repair, "undo", tip, beforeIsolation), [0, beforeIsolation]);
  assert.deepEqual(select(repair, "readback", tip, beforeIsolation), [0, beforeIsolation]);
  assert.deepEqual(select(executor, "revoke", tip, beforeIsolation), [0, beforeIsolation]);
  assert.deepEqual(select(isolation, "undo", tip, beforeIsolation), [1, tip]);
  write(isolation, `${read(`../${isolation}`)}\n# changed isolation dispatcher\n`);
  git("commit", "-qam", "changed isolation dispatcher");
  const changedIsolationWorkflow = git("rev-parse", "HEAD");
  assert.deepEqual(select(isolation, "undo", changedIsolationWorkflow, approved), [
    1,
    changedIsolationWorkflow,
  ]);
  git("checkout", "--detach", tip);
  write(isolationSelector, `${read(`../${isolationSelector}`)}\n# changed isolation selector\n`);
  git("commit", "-qam", "changed isolation selector");
  const changedIsolation = git("rev-parse", "HEAD");
  assert.deepEqual(select(isolation, "undo", changedIsolation, approved), [1, changedIsolation]);
  write(repair, `${read(`../${repair}`)}\n# changed dispatcher\n`);
  git("commit", "-qam", "changed dispatcher");
  const changed = git("rev-parse", "HEAD");
  assert.deepEqual(select(repair, "undo", changed, approved), [1, changed]);
  assert.equal(compare(changed).undo, "Workflow or selector changed");
  assert.deepEqual(compare(changed).changedRecoveryPaths, [repair]);
  git("checkout", "--detach", tip);
  write(selector, `${read(`../${selector}`)}\n# changed selector\n`);
  git("commit", "-qam", "changed selector");
  const changedSelector = git("rev-parse", "HEAD");
  assert.deepEqual(select(executor, "revoke", changedSelector, approved), [1, changedSelector]);
  assert.deepEqual(select(repair, "undo", changedSelector, approved), [1, changedSelector]);
  assert.deepEqual(compare(changedSelector).changedRecoveryPaths, [selector]);

  git("checkout", "--detach", tip);
  chmodSync(join(cwd, selector), 0o755);
  git("update-index", "--chmod=+x", selector);
  git("commit", "-qm", "made selector executable");
  const executableSelector = git("rev-parse", "HEAD");
  const executable = compare(executableSelector, executableSelector);
  assert.equal(executable.undo, "Revision check matches");
  assert.deepEqual(executable.unavailableDispatchPaths, []);

  git("checkout", "--detach", tip);
  git("rm", selector);
  git("commit", "-qm", "removed selector");
  const removedSelector = git("rev-parse", "HEAD");
  assert.deepEqual(select(repair, "undo", removedSelector, approved), [1, removedSelector]);
  const removed = compare(removedSelector);
  assert.equal(removed.undo, "Workflow or selector unavailable at dispatch");
  assert.deepEqual(removed.unavailableDispatchPaths, [selector]);
  assert.deepEqual(removed.changedRecoveryPaths, [selector]);
  const stillMissing = compare(removedSelector, removedSelector);
  assert.equal(stillMissing.forward, "Workflow or selector unavailable at dispatch");
  assert.equal(stillMissing.undo, removed.undo);
  assert.deepEqual(stillMissing.changedRecoveryPaths, []);

  const nestedPath = `${selector}/placeholder`;
  write(nestedPath, "A directory cannot serve as the selector.\n");
  git("add", nestedPath);
  git("commit", "-qm", "replaced selector with a directory");
  const directorySelector = git("rev-parse", "HEAD");
  assert.deepEqual(select(repair, "undo", directorySelector, approved), [1, directorySelector]);
  const directory = compare(directorySelector);
  assert.equal(directory.undo, removed.undo);
  assert.deepEqual(directory.unavailableDispatchPaths, [selector]);
  assert.ok(directory.changedPaths.includes(nestedPath));
});

test("repair refuses missing plan provenance and stale live identity before a write", async () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const inventory = JSON.parse(read("db-permissions-repair-inventory.json"));
  const plan = JSON.stringify({
    before: "a".repeat(64),
    after: "b".repeat(64),
    identity: hash("postgres\0approved_executor"),
    owners: inventory.map(() => "approved_executor"),
  });
  const env = {
    PRODUCTION_DB_REPAIR_PLAN: plan,
    PRODUCTION_DB_REPAIR_PLAN_SHA256: hash(plan),
    PRODUCTION_DB_REPAIR_DATABASE_URL: `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:synthetic@${PLANETSCALE_PRODUCTION_HOST}/postgres?sslmode=verify-full`,
  };
  const staleIdentity = {
    database: "postgres",
    authenticated: "stale_executor",
    effective: "stale_executor",
  };

  for (const operation of ["forward", "undo"]) {
    await assert.rejects(
      runRepair(operation, { ...env, PRODUCTION_DB_REPAIR_PLAN_SHA256: "" }, () =>
        assert.fail("Unexpected connection without pinned plan bytes"),
      ),
      /raw && raw.length/,
    );

    const statements = [];
    let closed = false;
    await assert.rejects(
      runRepair(operation, env, () => ({
        begin: async (_, run) =>
          run(([sql]) => {
            statements.push(sql);
            return sql.startsWith("select pg_catalog.current_database()") ? [staleIdentity] : [];
          }),
        end: async () => {
          closed = true;
        },
      })),
      /database or role identity did not match/,
    );
    assert.equal(statements.length, 5);
    assert.ok(statements.slice(0, 4).every((sql) => sql.startsWith("set local ")));
    assert.match(statements.at(-1), /^select pg_catalog\.current_database\(\)/);
    assert.equal(closed, true);
  }
});

test("serving isolation refuses duplicate ACL entries in a digest-matched plan", async (t) => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const acl = { column: "", grantor: "fixture_owner", grantable: false };
  const plan = {
    identity: hash("postgres\0fixture_owner"),
    version: "00000000-0000-4000-8000-000000000001",
    artifact: { sourceSha: "a".repeat(40), digest: "b".repeat(64) },
    before: "c".repeat(64),
    after: "d".repeat(64),
    add: [{ ...acl, kind: "table", name: "events", right: "SELECT" }],
    remove: [{ ...acl, kind: "schema", name: "drizzle", right: "USAGE" }],
    membership: [],
  };
  const reachedConnector = new Error("Reached the synthetic connector");
  const connect = t.mock.fn(() => {
    throw reachedConnector;
  });
  const fetchImpl = t.mock.fn(() => assert.fail("Unexpected serving read"));
  const run = (operation, input) => {
    const raw = JSON.stringify(input);
    return runServingIsolation(
      operation,
      "1033_session-roles-checked-at",
      {
        PRODUCTION_DB_ISOLATION_PLAN: raw,
        PRODUCTION_DB_ISOLATION_PLAN_SHA256: hash(raw),
        PRODUCTION_DB_ISOLATION_DATABASE_URL: `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:synthetic@${PLANETSCALE_PRODUCTION_HOST}/postgres?sslmode=verify-full`,
      },
      { connect, fetchImpl },
    );
  };

  for (const operation of ["forward", "undo"]) {
    await assert.rejects(run(operation, plan), (error) => error === reachedConnector);
    connect.mock.resetCalls();
    for (const list of ["add", "remove"]) {
      const duplicate = { ...plan, [list]: [...plan[list], { ...plan[list][0] }] };
      await assert.rejects(
        run(operation, duplicate),
        { code: "ERR_ASSERTION", operator: "strictEqual", actual: 2, expected: 3 },
        `${operation} with a duplicate ${list} entry`,
      );
    }
    assert.equal(connect.mock.callCount(), 0);
  }
  assert.equal(fetchImpl.mock.callCount(), 0);
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
