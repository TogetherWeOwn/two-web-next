import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertMigrationAdmission, assertStagingDeployHold } from "./migration-admission.mjs";
import {
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
  migrationConfig,
  safeMigrationError,
} from "./db-migrate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const STAGING_URL = `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`;
const PROD_URL = "postgres://user:stub@stub-1.pg.psdb.cloud/db?sslmode=require";
const mainRef = "refs/heads/main";

function env(overrides = {}) {
  return {
    GITHUB_REF: mainRef,
    MIGRATION_TARGET: "staging",
    STAGING_MIGRATION_HOLD: "false",
    ...overrides,
  };
}

// Absent/false/true/malformed hold contract: only exactly "false" releases.
test("staging hold is fail-closed: only exactly false releases", () => {
  assertMigrationAdmission(env({ STAGING_MIGRATION_HOLD: "false" }));
  for (const held of [undefined, "", "true", "TRUE", "0", "1", "false ", " false", "no", "off"]) {
    assert.throws(
      () => assertMigrationAdmission(env({ STAGING_MIGRATION_HOLD: held })),
      /Staging migrations are held/,
      `hold=${String(held)} must refuse`,
    );
  }
});

test("staging hold refusal withholds secrets and survives repeated attempts", () => {
  for (let i = 0; i < 2; i += 1) {
    assert.throws(
      () => assertMigrationAdmission(env({ STAGING_MIGRATION_HOLD: "true" })),
      /Staging migrations are held/,
    );
  }
  // Hold release allows, re-hold refuses again.
  assertMigrationAdmission(env({ STAGING_MIGRATION_HOLD: "false" }));
  assert.throws(
    () => assertMigrationAdmission(env({ STAGING_MIGRATION_HOLD: "true" })),
    /Staging migrations are held/,
  );
  try {
    assertMigrationAdmission(
      env({
        STAGING_MIGRATION_HOLD: "true",
        PLANETSCALE_STAGING_DATABASE_URL: `postgres://user:DO_NOT_ECHO@${PLANETSCALE_STAGING_HOST}/db`,
      }),
    );
    assert.fail("expected hold refusal");
  } catch (error) {
    assert.doesNotMatch(safeMigrationError(error), /DO_NOT_ECHO/);
  }
});

test("production path ignores the staging hold and keeps the existing enable gate", () => {
  // Enabled production passes under any hold value: the hold must not disable it.
  for (const hold of [undefined, "", "true", "false", "malformed"]) {
    assertMigrationAdmission(
      env({
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
        STAGING_MIGRATION_HOLD: hold,
      }),
    );
  }
  // Disabled production still refuses regardless of hold release.
  for (const flag of [undefined, "", "false", "TRUE", "1"]) {
    assert.throws(
      () =>
        assertMigrationAdmission(
          env({
            MIGRATION_TARGET: "production",
            PRODUCTION_DEPLOY_ENABLED: flag,
            STAGING_MIGRATION_HOLD: "false",
          }),
        ),
      /PRODUCTION_DEPLOY_ENABLED=true/,
    );
  }
});

test("unknown target and non-main ref stay fail-closed", () => {
  assert.throws(
    () => assertMigrationAdmission(env({ MIGRATION_TARGET: "other" })),
    /Target must be staging or production/,
  );
  assert.throws(
    () => assertMigrationAdmission(env({ GITHUB_REF: "refs/heads/topic" })),
    /Migrations require the reviewed main branch/,
  );
  assert.throws(
    () =>
      assertMigrationAdmission(
        env({ MIGRATION_TARGET: "production", GITHUB_REF: "refs/heads/topic" }),
      ),
    /Migrations require the reviewed main branch/,
  );
});

test("migrationConfig is wired to the single admission source", () => {
  const neon = readFileSync(new URL("./db-migrate.mjs", import.meta.url), "utf8");
  assert.match(neon, /assertMigrationAdmission/);
  // migrationConfig must delegate rather than carry a second inline copy.
  assert.doesNotMatch(neon, /STAGING_MIGRATION_HOLD !== "false"/);
  const admission = readFileSync(new URL("./migration-admission.mjs", import.meta.url), "utf8");
  assert.match(admission, /assertStagingDeployHold\(env\)/);
});

test("deploy direct staging path enforces the same hold without touching production", () => {
  assertStagingDeployHold({ STAGING_MIGRATION_HOLD: "false" });
  for (const held of [undefined, "", "true", "malformed"]) {
    assert.throws(
      () => assertStagingDeployHold({ STAGING_MIGRATION_HOLD: held }),
      /Staging migrations are held/,
    );
  }
});

test("migrationConfig refuses held staging before URL parsing or connection", () => {
  // Released staging with a valid stub URL passes config (pure, no connection).
  assert.equal(
    migrationConfig(env({ PLANETSCALE_STAGING_DATABASE_URL: STAGING_URL })).target,
    "staging",
  );
  // Held staging with an otherwise-valid URL refuses with the hold message.
  for (const held of [undefined, "", "true", "malformed"]) {
    assert.throws(
      () =>
        migrationConfig(
          env({ STAGING_MIGRATION_HOLD: held, PLANETSCALE_STAGING_DATABASE_URL: STAGING_URL }),
        ),
      /Staging migrations are held/,
    );
  }
  // Held staging refuses even when the URL itself is malformed: hold is checked first.
  assert.throws(
    () =>
      migrationConfig(
        env({ STAGING_MIGRATION_HOLD: "true", PLANETSCALE_STAGING_DATABASE_URL: "bad" }),
      ),
    /Staging migrations are held/,
  );
  // Production config still honors the enable gate and ignores the hold.
  assert.equal(
    migrationConfig(
      env({
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
        PRODUCTION_DATABASE_URL: PROD_URL,
        STAGING_MIGRATION_HOLD: "true",
      }),
    ).target,
    "production",
  );
});

// Workflow admission: both manual/called staging db-migrate and the direct
// staging deploy path must hold BEFORE dependencies, DB or Cloudflare work.
const dbMigrate = readFileSync(join(root, ".github/workflows/db-migrate.yml"), "utf8");
const deploy = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");

test("db-migrate admits staging and production through one explicit gate before checkout", () => {
  assert.match(dbMigrate, /workflow_dispatch:/);
  assert.match(dbMigrate, /options: \[staging, production\]/);
  assert.match(dbMigrate, /workflow_call:/);
  const gateIndex = dbMigrate.indexOf("Ref and production enable gate");
  const checkoutIndex = dbMigrate.indexOf("actions/checkout");
  assert.ok(gateIndex > 0 && checkoutIndex > gateIndex, "gate must run before checkout");
  const gate = dbMigrate.slice(gateIndex, checkoutIndex);
  assert.match(gate, /Migrations require main/);
  assert.match(gate, /Unknown migration target/);
  assert.match(gate, /Production migrations are disabled/);
  assert.match(gate, /STAGING_MIGRATION_HOLD/);
  assert.match(gate, /Staging migrations are held/);
  // Exact-string release only: no case-insensitive or trimmed fallback.
  assert.doesNotMatch(gate, /tr \[|tolower|ToLower|trim/i);
  assert.match(dbMigrate, /environment: \$\{\{ inputs\.target \}\}/);
  assert.match(dbMigrate, /cancel-in-progress: false/);
  // Pin each env wiring site: the gate step and the shared migrator env anchor
  // must each carry the hold variable, so dropping either line fails this test.
  assert.match(gate, /STAGING_MIGRATION_HOLD: \$\{\{ vars\.STAGING_MIGRATION_HOLD \}\}/);
  const migrationEnvAt = dbMigrate.indexOf("env: &migration-env");
  assert.ok(migrationEnvAt > 0, "db-migrate needs a shared &migration-env anchor");
  const migrationEnvEnd = dbMigrate.indexOf("\n      - ", migrationEnvAt + 1);
  const migrationEnv = dbMigrate.slice(
    migrationEnvAt,
    migrationEnvEnd > migrationEnvAt ? migrationEnvEnd : undefined,
  );
  assert.match(migrationEnv, /STAGING_MIGRATION_HOLD: \$\{\{ vars\.STAGING_MIGRATION_HOLD \}\}/);
  for (const mode of ["plan", "apply", "verify"])
    assert.ok(dbMigrate.includes(`node ci/db-migrate.mjs ${mode}`));
});

test("deploy holds the direct staging migration path before dependencies or mutations", () => {
  const holdIndex = deploy.indexOf("Staging admission hold");
  assert.ok(holdIndex > 0, "deploy needs an explicit staging admission hold step");
  const checkoutIndex = deploy.indexOf("actions/checkout");
  assert.ok(checkoutIndex < holdIndex, "hold step follows the read-only checkout");
  const setupIndex = deploy.indexOf("actions/setup-node");
  assert.ok(holdIndex < setupIndex, "hold must run before dependency install");
  const planIndex = deploy.indexOf("node ci/db-migrate.mjs plan");
  assert.ok(holdIndex < planIndex, "hold must run before the staging DB plan");
  const wranglerIndex = deploy.indexOf("npx wrangler deploy");
  assert.ok(holdIndex < wranglerIndex, "hold must run before any Cloudflare mutation");
  const hold = deploy.slice(holdIndex, setupIndex);
  assert.match(hold, /STAGING_MIGRATION_HOLD/);
  assert.match(hold, /Staging migrations are held/);
  // The deploy-staging job runs in a container whose default shell is sh
  // (dash): the hold script must stay POSIX so it passes under sh and bash.
  // Scope the bash-ism check to the script body: the comments above it name
  // the forbidden constructs.
  assert.match(hold, /shell: bash/);
  const holdScript = hold.slice(hold.indexOf("run: |"));
  assert.doesNotMatch(holdScript, /\[\[/);
  assert.doesNotMatch(holdScript, /pipefail/);
  // Pin each env wiring site: the hold step and the shared staging migrator env
  // anchor must each carry the hold variable, so dropping either line fails.
  assert.match(hold, /STAGING_MIGRATION_HOLD: \$\{\{ vars\.STAGING_MIGRATION_HOLD \}\}/);
  const stagingEnvAt = deploy.indexOf("env: &staging-migration-env");
  assert.ok(stagingEnvAt > 0, "deploy needs a shared &staging-migration-env anchor");
  const stagingEnvEnd = deploy.indexOf("\n      - ", stagingEnvAt + 1);
  const stagingEnv = deploy.slice(
    stagingEnvAt,
    stagingEnvEnd > stagingEnvAt ? stagingEnvEnd : undefined,
  );
  assert.match(stagingEnv, /STAGING_MIGRATION_HOLD: \$\{\{ vars\.STAGING_MIGRATION_HOLD \}\}/);
  assert.match(deploy, /MIGRATION_TARGET: staging/);
});

function shellScript(workflow, marker) {
  const start = workflow.indexOf(marker);
  assert.ok(start > 0, `missing workflow gate: ${marker}`);
  const runAt = workflow.indexOf("run: |", start);
  const blockEnd = workflow.indexOf("\n      - ", runAt);
  const block = workflow.slice(runAt, blockEnd > runAt ? blockEnd : undefined);
  const script = block
    .split("\n")
    .slice(1)
    .map((line) => line.slice(10))
    .join("\n");
  assert.ok(script.includes("STAGING_MIGRATION_HOLD") || script.includes("MIGRATION_TARGET"));
  return script;
}

function runShell(script, extra = {}, shell = "bash") {
  const env = {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    MIGRATION_TARGET: "staging",
    STAGING_MIGRATION_HOLD: "false",
    PRODUCTION_DEPLOY_ENABLED: "",
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  // Model an absent variable exactly: never inherit a leaked hold from CI.
  if (!Object.hasOwn(extra, "STAGING_MIGRATION_HOLD")) delete env.STAGING_MIGRATION_HOLD;
  else if (extra.STAGING_MIGRATION_HOLD === undefined) delete env.STAGING_MIGRATION_HOLD;
  return spawnSync(shell, ["-c", script], { env, encoding: "utf8" });
}

// The exact shell gates (workflow_dispatch and workflow_call share the same
// inputs.target gate; deploy hardcodes staging) refuse held staging without
// reaching install, DB or Cloudflare steps.
test("workflow shells refuse held staging and preserve production/invalid-target behavior", () => {
  const migrateGate = shellScript(dbMigrate, "Ref and production enable gate");
  const deployGate = shellScript(deploy, "Staging admission hold");
  // Staging held: absent, true and malformed all fail closed on both paths.
  for (const held of [undefined, "", "true", "TRUE", "malformed"]) {
    const extra =
      held === undefined ? { STAGING_MIGRATION_HOLD: undefined } : { STAGING_MIGRATION_HOLD: held };
    // spawnSync drops undefined env values, which models an absent variable.
    if (held === undefined) delete extra.STAGING_MIGRATION_HOLD;
    const migrated = runShell(migrateGate, { ...extra, MIGRATION_TARGET: "staging" });
    assert.equal(migrated.status, 1, `db-migrate staging hold=${String(held)} must refuse`);
    assert.match(migrated.stderr, /Staging migrations are held/);
    const direct = runShell(deployGate, extra);
    assert.equal(direct.status, 1, `deploy staging hold=${String(held)} must refuse`);
    assert.match(direct.stderr, /Staging migrations are held/);
  }
  // Hold release allows repeated staging attempts on both paths.
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      runShell(migrateGate, { MIGRATION_TARGET: "staging", STAGING_MIGRATION_HOLD: "false" })
        .status,
      0,
    );
    assert.equal(runShell(deployGate, { STAGING_MIGRATION_HOLD: "false" }).status, 0);
  }
  // Production keeps the existing enable gate and ignores the hold.
  assert.equal(
    runShell(migrateGate, {
      MIGRATION_TARGET: "production",
      PRODUCTION_DEPLOY_ENABLED: "true",
      STAGING_MIGRATION_HOLD: "true",
    }).status,
    0,
  );
  const disabled = runShell(migrateGate, {
    MIGRATION_TARGET: "production",
    PRODUCTION_DEPLOY_ENABLED: "",
    STAGING_MIGRATION_HOLD: "false",
  });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /Production migrations are disabled/);
  // Invalid target and non-main ref stay fail-closed.
  assert.equal(runShell(migrateGate, { MIGRATION_TARGET: "other" }).status, 1);
  assert.equal(runShell(migrateGate, { GITHUB_REF: "refs/heads/topic" }).status, 1);
  // The deploy gate runs in a container whose default shell is sh (dash):
  // it must refuse held staging and release on exactly "false" under sh too,
  // so a bash-only construct fails CI here instead of staging deploys.
  for (const held of [undefined, "", "true", "malformed"]) {
    const extra =
      held === undefined ? { STAGING_MIGRATION_HOLD: undefined } : { STAGING_MIGRATION_HOLD: held };
    if (held === undefined) delete extra.STAGING_MIGRATION_HOLD;
    const direct = runShell(deployGate, extra, "sh");
    assert.equal(direct.status, 1, `deploy sh staging hold=${String(held)} must refuse`);
    assert.match(direct.stderr, /Staging migrations are held/);
  }
  assert.equal(runShell(deployGate, { STAGING_MIGRATION_HOLD: "false" }, "sh").status, 0);
});
