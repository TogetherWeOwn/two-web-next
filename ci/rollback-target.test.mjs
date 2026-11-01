import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ROLLBACK_ENVIRONMENTS,
  assertRollbackDrillGreen,
  checkRollbackTarget,
  destructiveStatements,
  liveVersion,
  previousVersion,
  rollbackAction,
  rollbackCompatibility,
  rollbackEnvironment,
  stagingBusyRuns,
} from "./rollback-target.mjs";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";
const V4 = "44444444-4444-4444-8444-444444444444";
const TARGET = "a".repeat(40);
const PREVIOUS = "b".repeat(40);

const full = (id, created_on) => ({ created_on, versions: [{ version_id: id, percentage: 100 }] });
const split = (a, b, created_on) => ({
  created_on,
  versions: [
    { version_id: a, percentage: 50 },
    { version_id: b, percentage: 50 },
  ],
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("each environment maps to its own Worker and origin; anything else refuses", () => {
  assert.deepEqual(rollbackEnvironment("production"), {
    name: "production",
    worker: "two-web-next-production",
    origin: "https://togetherweown.com",
    indexable: true,
  });
  assert.deepEqual(rollbackEnvironment("staging"), {
    name: "staging",
    worker: "two-web-next",
    origin: "https://next.togetherweown.com",
    indexable: false,
  });
  for (const name of [undefined, "", "Production", "preview", "toString", "__proto__"]) {
    assert.throws(() => rollbackEnvironment(name), /Rollback environment must be one of/);
  }
  assert.deepEqual(Object.keys(ROLLBACK_ENVIRONMENTS), ["production", "staging"]);
});

test("live version is the newest deployment by created_on, single-version 100% only", () => {
  // wrangler prints oldest first; order never decides.
  const list = [full(V1, "2026-11-01T01:00:00Z"), full(V2, "2026-11-01T02:00:00Z")];
  assert.equal(liveVersion(list), V2);
  assert.equal(liveVersion([...list].reverse()), V2);
  assert.throws(
    () => liveVersion([...list, split(V2, V3, "2026-11-01T03:00:00Z")]),
    /not a single-version 100% deployment/,
  );
  assert.throws(() => liveVersion([]), /non-empty deployments list/);
  assert.throws(() => liveVersion([full("not-a-uuid", "2026-11-01T01:00:00Z")]));
});

test("previous version skips split rollouts and redeploys of the live version", () => {
  const list = [
    full(V1, "2026-11-01T01:00:00Z"),
    split(V1, V2, "2026-11-01T02:00:00Z"),
    full(V2, "2026-11-01T03:00:00Z"),
    split(V2, V3, "2026-11-01T04:00:00Z"),
    full(V3, "2026-11-01T05:00:00Z"),
    full(V3, "2026-11-01T06:00:00Z"),
  ];
  assert.equal(previousVersion(list), V2);
  assert.throws(
    () => previousVersion([full(V1, "2026-11-01T01:00:00Z"), full(V1, "2026-11-01T02:00:00Z")]),
    /No earlier single-version 100% deployment/,
  );
});

test("rollback guard: rollback while expected is live, skip when target serves, refuse otherwise", () => {
  const live = (id) => [full(V4, "2026-11-01T00:00:00Z"), full(id, "2026-11-01T01:00:00Z")];
  assert.equal(rollbackAction(live(V2), { expected: V2, target: V1 }), "rollback");
  assert.equal(rollbackAction(live(V1), { expected: V2, target: V1 }), "skip");
  assert.throws(
    () => rollbackAction(live(V3), { expected: V2, target: V1 }),
    /neither the expected .* nor the target/,
  );
  assert.throws(() => rollbackAction(live(V2), { expected: "", target: V1 }), /lowercase UUID/);
  assert.throws(() => rollbackAction(live(V2), { expected: V2, target: "x;id" }), /lowercase UUID/);
});

test("destructive statements refuse; comments, triggers and additive DDL do not", () => {
  assert.deepEqual(destructiveStatements('CREATE TABLE "a" ("id" text);'), []);
  assert.deepEqual(destructiveStatements('ALTER TABLE "a" ADD COLUMN "b" text;'), []);
  assert.deepEqual(
    destructiveStatements(
      '-- UPDATE and TRUNCATE are refused\nCREATE TRIGGER "t" BEFORE TRUNCATE ON "a" FOR EACH STATEMENT EXECUTE FUNCTION f();',
    ),
    [],
  );
  assert.deepEqual(destructiveStatements("/* DROP TABLE a; */ SELECT 1;"), []);
  for (const sql of [
    'DROP TABLE "agent_events";',
    'ALTER TABLE "a" DROP COLUMN "b";',
    'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
    'ALTER TABLE "a" RENAME TO "z";',
    'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;',
    'ALTER TABLE "a" ALTER COLUMN b TYPE integer;',
    'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
    "TRUNCATE a;",
    'CREATE TABLE "x" ("id" text);\n--> statement-breakpoint\nDROP VIEW "web_v1"."events";',
  ]) {
    assert.equal(destructiveStatements(sql).length, 1, sql);
  }
  // A reviewed note (at least 10 characters of reason) clears the migration.
  assert.deepEqual(
    destructiveStatements(
      '-- rollback-safe: agent_events moved in 1018; no deployed code reads it\nDROP TABLE "agent_events";',
    ),
    [],
  );
  assert.equal(destructiveStatements('-- rollback-safe: ok\nDROP TABLE "a";').length, 1);
  assert.equal(destructiveStatements('--rollback-safe\nDROP TABLE "a";').length, 1);
});

test("the checked-in migrations classify as expected", () => {
  // 1019 drops the old agent_events table; 1018 only mentions TRUNCATE in
  // comments and BEFORE TRUNCATE triggers.
  assert.equal(destructiveStatements(read("../drizzle/1019_shared-agent-events.sql")).length, 1);
  assert.deepEqual(destructiveStatements(read("../drizzle/1018_audit-immutability.sql")), []);
});

function journal(tags) {
  return Buffer.from(
    JSON.stringify({ entries: tags.map((tag, i) => ({ tag, when: 1000 + i })) }),
  ).toString("base64");
}

function stubRepo({ target, previous, sql, up, drill, seen = {} }) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/up") {
      seen.up = (seen.up ?? 0) + 1;
      return { ok: true, json: async () => up };
    }
    if (parsed.pathname.endsWith("/contents/drizzle/meta/_journal.json")) {
      const ref = parsed.searchParams.get("ref");
      const tags = ref === TARGET ? target : ref === PREVIOUS ? previous : assert.fail(ref);
      return { ok: true, json: async () => ({ encoding: "base64", content: journal(tags) }) };
    }
    const tag = parsed.pathname.match(/\/contents\/drizzle\/([^/]+)\.sql$/)?.[1];
    if (tag) {
      assert.equal(parsed.searchParams.get("ref"), TARGET);
      seen.sql = [...(seen.sql ?? []), decodeURIComponent(tag)];
      if (!(tag in sql)) return { ok: false, status: 404 };
      return { ok: true, text: async () => sql[tag] };
    }
    if (parsed.pathname.endsWith("/workflows/staging-rollback-drill.yml/runs")) {
      assert.equal(parsed.searchParams.get("branch"), "main");
      if (drill === 404) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ workflow_runs: drill }) };
    }
    assert.fail(`unexpected path ${parsed.pathname}`);
  };
}

test("compatibility reads only the migrations the target adds since the rollback commit", async () => {
  const seen = {};
  const result = await rollbackCompatibility({
    repository: "fixture/repo",
    targetSha: TARGET,
    previousSha: PREVIOUS,
    token: "fixture-only",
    fetchImpl: stubRepo({
      target: ["1000_a", "1001_b", "1002_c"],
      previous: ["1000_a"],
      sql: { "1001_b": 'ALTER TABLE "a" ADD COLUMN "b" text;', "1002_c": 'DROP TABLE "z";' },
      seen,
    }),
  });
  assert.deepEqual(result, { added: ["1001_b", "1002_c"], unsafe: ["1002_c"] });
  assert.deepEqual(seen.sql, ["1001_b", "1002_c"]);
});

test("an unreadable migration file fails closed", async () => {
  await assert.rejects(
    rollbackCompatibility({
      repository: "fixture/repo",
      targetSha: TARGET,
      previousSha: PREVIOUS,
      token: "fixture-only",
      fetchImpl: stubRepo({ target: ["1000_a", "1001_b"], previous: ["1000_a"], sql: {} }),
    }),
    /Migration 1001_b lookup failed \(HTTP 404\)/,
  );
});

const upOk = { revision: { version_id: V1, commit: PREVIOUS } };
function target(overrides = {}, sql = { "1001_b": "SELECT 1;" }) {
  const { up = upOk, ...rest } = overrides;
  return checkRollbackTarget({
    origin: "https://togetherweown.com",
    repository: "fixture/repo",
    targetSha: TARGET,
    token: "fixture-only",
    fetchImpl: stubRepo({ target: ["1000_a", "1001_b"], previous: ["1000_a"], sql, up }),
    sleep: async () => {},
    ...rest,
  });
}

test("rollback target is the version /up names, with its commit, when no migration breaks it", async () => {
  assert.deepEqual(await target(), { versionId: V1, commit: PREVIOUS, added: ["1001_b"] });
});

test("no valid rollback target refuses promotion", async () => {
  for (const up of [
    {},
    { revision: { version_id: V1, commit: null } },
    { revision: { version_id: "nope", commit: PREVIOUS } },
    { revision: { version_id: V1, commit: "main" } },
  ]) {
    await assert.rejects(target({ up }), /No valid rollback target: \/up did not report/);
  }
  await assert.rejects(
    target({}, { "1001_b": 'ALTER TABLE "a" DROP COLUMN "b";' }),
    /No valid rollback target: 1001_b would break 11111111-.*rollback-safe/,
  );
  await assert.rejects(target({ targetSha: "main" }), /DEPLOY_SHA must be a full 40-hex commit/);
});

test("rollback target retries an unreadable /up before refusing", async () => {
  let reads = 0;
  const result = await target({
    readRevision: async () => {
      reads += 1;
      if (reads < 3) throw new Error("timeout");
      return { versionId: V1, commit: PREVIOUS };
    },
  });
  assert.equal(result.versionId, V1);
  assert.equal(reads, 3);
});

const drillRun = (id, conclusion) => ({ id, conclusion, status: "completed" });
function drill(runs) {
  return assertRollbackDrillGreen({
    repository: "fixture/repo",
    token: "fixture-only",
    fetchImpl: stubRepo({ drill: runs }),
  });
}

test("a red latest staging rollback drill holds promotion; none yet does not", async () => {
  assert.equal(await drill(404), null);
  assert.equal(await drill([]), null);
  assert.equal(await drill([drillRun(2, "success"), drillRun(1, "failure")]), 2);
  // Cancelled and skipped runs prove nothing either way.
  assert.equal(await drill([drillRun(3, "cancelled"), drillRun(2, "success")]), 2);
  for (const conclusion of ["failure", "timed_out", "action_required"]) {
    await assert.rejects(
      drill([drillRun(1, "success"), drillRun(2, conclusion)]),
      new RegExp(`run 2\\) concluded ${conclusion}`),
    );
  }
});

test("staging lane is busy while deploy or e2e-staging runs are queued or running", async () => {
  const asked = [];
  const busy = await stagingBusyRuns({
    repository: "fixture/repo",
    token: "fixture-only",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const file = parsed.pathname.match(/workflows\/([^/]+)\/runs$/)[1];
      const status = parsed.searchParams.get("status");
      asked.push(`${file}:${status}`);
      const runs = file === "e2e-staging.yml" && status === "in_progress" ? [{ id: 7 }] : [];
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    },
  });
  assert.deepEqual(busy, ["e2e-staging.yml run 7"]);
  assert.deepEqual(asked, [
    "deploy.yml:in_progress",
    "deploy.yml:queued",
    "deploy.yml:waiting",
    "e2e-staging.yml:in_progress",
    "e2e-staging.yml:queued",
    "e2e-staging.yml:waiting",
  ]);
});

function cli(args, { env = {}, input } = {}) {
  const output = join(mkdtempSync(join(tmpdir(), "rollback-target-")), "out");
  const result = spawnSync(process.execPath, ["ci/rollback-target.mjs", ...args], {
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
  });
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    written = "";
  }
  return { ...result, written };
}

test("CLI resolves the environment, the guard action and refuses unknown flags", () => {
  const staging = cli(["--environment"], { env: { ROLLBACK_ENVIRONMENT: "staging" } });
  assert.equal(staging.status, 0);
  assert.equal(
    staging.written,
    "worker=two-web-next\norigin=https://next.togetherweown.com\nindexable=false\n",
  );
  const bad = cli(["--environment"], { env: { ROLLBACK_ENVIRONMENT: "prod" } });
  assert.equal(bad.status, 1);
  assert.equal(bad.written, "");
  const deployments = JSON.stringify([full(V1, "2026-11-01T01:00:00Z")]);
  const skip = cli(["--action"], {
    env: { EXPECTED_CURRENT_VERSION_ID: V2, ROLLBACK_VERSION_ID: V1 },
    input: deployments,
  });
  assert.equal(skip.status, 0);
  assert.equal(skip.written, "action=skip\n");
  const refuse = cli(["--action"], {
    env: { EXPECTED_CURRENT_VERSION_ID: V2, ROLLBACK_VERSION_ID: V3 },
    input: deployments,
  });
  assert.equal(refuse.status, 1);
  assert.equal(refuse.written, "");
  assert.ok(!refuse.stderr.includes("created_on"), "never echo the wrangler listing");
  assert.equal(cli(["--live-version"], { input: deployments }).stdout, `${V1}\n`);
  assert.equal(cli(["--nope"]).status, 2);
  assert.equal(cli([]).status, 2);
});

test("the staging drill rolls back and forward through rollback-production.yml", () => {
  const workflow = read("../.github/workflows/staging-rollback-drill.yml");
  assert.match(workflow, /\n  schedule:\n    - cron: "41 3 \* \* \*"\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.ok(!/\n  (push|pull_request|workflow_run):/.test(workflow));
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n/m);
  const legs = [...workflow.matchAll(/uses: \.\/\.github\/workflows\/rollback-production\.yml\n/g)];
  assert.equal(legs.length, 2, "both legs call the production rollback workflow");
  const rollback = workflow.slice(
    workflow.indexOf("\n  rollback:\n"),
    workflow.indexOf("\n  restore:\n"),
  );
  const restore = workflow.slice(
    workflow.indexOf("\n  restore:\n"),
    workflow.indexOf("\n  verdict:\n"),
  );
  for (const leg of [rollback, restore]) {
    assert.match(leg, /environment: staging\n/);
    assert.match(leg, /ref: \$\{\{ needs\.plan\.outputs\.ref \}\}\n/);
    assert.match(leg, /secrets: inherit\n/);
    assert.ok(!/environment: production/.test(leg), "the drill never targets production");
  }
  assert.match(rollback, /version_id: \$\{\{ needs\.plan\.outputs\.previous \}\}/);
  assert.match(rollback, /expected_current_version_id: \$\{\{ needs\.plan\.outputs\.live \}\}/);
  assert.match(restore, /version_id: \$\{\{ needs\.plan\.outputs\.live \}\}/);
  assert.match(restore, /expected_current_version_id: \$\{\{ needs\.plan\.outputs\.previous \}\}/);
  // The restore runs even after a failed rollback leg.
  assert.match(restore, /if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' \}\}/);
  // A skipped leg is not a drill: the verdict needs traffic to move twice.
  const verdict = workflow.slice(workflow.indexOf("\n  verdict:\n"));
  assert.match(verdict, /if: \$\{\{ always\(\) \}\}/);
  assert.match(verdict, /"\$ROLLBACK_ACTION" != rollback/);
  assert.match(verdict, /"\$RESTORE_ACTION" != rollback/);
  // The plan waits for an idle staging lane, bounded.
  assert.match(workflow, /node ci\/rollback-target\.mjs --staging-busy/);
  assert.match(workflow, /for i in \$\(seq 1 30\)/);
  // Only staging (repo-level) credentials, never production ones.
  assert.ok(!/secrets\.PRODUCTION_/.test(workflow));
});

test("rollback-production exposes the guard inputs and reports whether traffic moved", () => {
  const workflow = read("../.github/workflows/rollback-production.yml");
  const call = workflow.slice(
    workflow.indexOf("\n  workflow_call:\n"),
    workflow.indexOf("\npermissions:"),
  );
  for (const input of ["environment", "version_id", "ref", "expected_current_version_id"]) {
    assert.match(call, new RegExp(`\\n      ${input}:\\n`));
  }
  assert.match(call, /value: \$\{\{ jobs\.rollback-production\.outputs\.action \}\}/);
  const guardAt = workflow.indexOf("- name: Refuse when an unexpected version is live");
  const secretsAt = workflow.indexOf(
    "run: node ci/check-production-secrets.mjs --rollback-version",
  );
  const rollbackAt = workflow.indexOf("- name: Roll back to the recorded Worker Version");
  assert.ok(guardAt > 0 && guardAt < secretsAt && secretsAt < rollbackAt);
  assert.match(
    workflow.slice(rollbackAt, rollbackAt + 200),
    /if: steps\.guard\.outputs\.action == 'rollback'/,
  );
  assert.match(
    workflow,
    /EXPECTED_CURRENT_VERSION_ID: \$\{\{ inputs\.expected_current_version_id \}\}/,
  );
});

test("promotion records a valid rollback target and honours the drill hold before deploying", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const preflight = workflow.slice(
    workflow.indexOf("\n  preflight:\n"),
    workflow.indexOf("\n  deploy-production:\n"),
  );
  // Both checks run from the tip checkout, before the target re-checkout,
  // so an older target cannot skip them.
  const retarget = preflight.indexOf("ref: ${{ steps.target.outputs.sha }}");
  const drillAt = preflight.indexOf("run: node ci/rollback-target.mjs --check-drill");
  const targetAt = preflight.indexOf("run: node ci/rollback-target.mjs --check-target");
  assert.ok(drillAt > 0 && targetAt > drillAt && retarget > targetAt);
  assert.match(
    preflight,
    /rollback_version_id: \$\{\{ steps\.rollback-target\.outputs\.version_id \}\}/,
  );
  const job = workflow.slice(
    workflow.indexOf("\n  deploy-production:\n"),
    workflow.indexOf("\n  release:\n"),
  );
  const confirmAt = job.indexOf(
    "- name: Confirm the recorded rollback target still exists with its secrets",
  );
  const tailAt = job.indexOf("- name: Deploy production alert Tail Worker first");
  assert.ok(confirmAt > 0 && confirmAt < tailAt);
  const confirm = job.slice(confirmAt, tailAt);
  assert.match(confirm, /--capture-rollback-target/);
  assert.match(confirm, /node ci\/check-production-secrets\.mjs --rollback-version/);
  assert.match(
    confirm,
    /ROLLBACK_VERSION_ID: \$\{\{ needs\.preflight\.outputs\.rollback_version_id \}\}/,
  );
});
