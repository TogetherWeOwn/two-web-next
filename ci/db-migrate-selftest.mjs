import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
  captureDriverRaceCrashes,
  isDriverConnectionRaceCrash,
  migrationClient,
  migrationConfig,
  runMigration,
  safeMigrationError,
} from "./db-migrate.mjs";
import { DefaultAclRefusal, assertRuntimeDefaultAcl } from "./migration-runtime-rights.mjs";

const mainEnv = {
  GITHUB_REF: "refs/heads/main",
  MIGRATION_TARGET: "staging",
  STAGING_MIGRATION_HOLD: "false",
};
const script = fileURLToPath(new URL("./db-migrate.mjs", import.meta.url));
const source = fileURLToPath(new URL("../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));

function testAdminUrl() {
  const raw =
    process.env.MIGRATION_TEST_DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/postgres";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid test URL; value withheld.");
  }
  const agent =
    url.hostname === "agent-testdb" && url.username === "agent_test" && url.password === "";
  const ci =
    process.env.CI === "true" &&
    process.env.GITHUB_ACTIONS === "true" &&
    url.hostname === "postgres" &&
    url.username === "postgres" &&
    url.password === "ci";
  assert.ok(
    (agent || ci) &&
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.pathname === "/postgres" &&
      (!url.port || url.port === "5432") &&
      !url.search &&
      !url.hash,
    "Selftest refuses any database other than agent-testdb or CI Postgres before connecting.",
  );
  return url;
}

async function dropOwnedRuntimeRole(admin, fixtureFailed = false) {
  try {
    await admin.unsafe("DROP ROLE two_web_app");
  } catch (error) {
    // A 2BP01 here means a concurrent suite on a shared cluster adopted the
    // role and recorded grants in its own database; leave it like any adopted
    // leftover instead of failing teardown.
    if (error?.code === "2BP01") return;
    if (!fixtureFailed) throw error;
    // Keep the fixture's pending rejection as the primary failure. Report
    // this teardown error without leaking driver text or hiding a clean-run
    // failure: a failed role drop still rejects when the fixture succeeded.
    console.error("Runtime-role cleanup failed after an earlier fixture failure.");
  }
}

test("runtime-role cleanup preserves an earlier fixture failure but fails on its own", async (t) => {
  const diagnostics = [];
  t.mock.method(console, "error", (message) => diagnostics.push(message));
  const cleanupError = new Error("fixture role-drop failure");
  const admin = {
    async unsafe() {
      throw cleanupError;
    },
  };
  await assert.rejects(dropOwnedRuntimeRole(admin), (error) => error === cleanupError);
  await assert.doesNotReject(dropOwnedRuntimeRole(admin, true));
  await assert.doesNotReject(
    dropOwnedRuntimeRole({
      async unsafe() {
        throw Object.assign(new Error("adopted role"), { code: "2BP01" });
      },
    }),
  );
  assert.deepEqual(diagnostics, ["Runtime-role cleanup failed after an earlier fixture failure."]);
});

async function fixture(callback) {
  const url = testAdminUrl();
  const name = `web_migrate_test_${randomUUID().replaceAll("-", "")}`;
  const options = {
    port: 5432,
    max: 1,
    password: () => decodeURIComponent(url.password),
    onnotice: () => {},
    connect_timeout: 5,
  };
  const admin = postgres(url.href, options);
  let client;
  let created = false;
  // Migrations carry runtime GRANTs to two_web_app
  // (ci/migration-runtime-rights.mjs), so every apply target provisions the
  // role first: CI workflows create it on the service cluster, staging/prod
  // carry it provisioned. The fixture mirrors that prerequisite for
  // standalone runs: adopt a pre-existing role, else create and own it.
  // Never drop a role this run did not create.
  let ownedRuntimeRole = false;
  let fixtureFailed = false;
  try {
    const [runtimeRole] = await admin`select 1 from pg_roles where rolname = 'two_web_app'`;
    if (!runtimeRole) {
      try {
        await admin.unsafe("CREATE ROLE two_web_app NOLOGIN");
        ownedRuntimeRole = true;
      } catch (error) {
        // Lost a concurrent create on a shared cluster; adopt the winner.
        if (error?.code !== "42710") throw error;
      }
    }
    await admin.unsafe(`create database "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    client = postgres(url.href, options);
    const output = [];
    const env = {
      ...mainEnv,
      CI: process.env.CI,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      PLANETSCALE_STAGING_DATABASE_URL: url.href,
      PRODUCTION_DATABASE_URL: url.href,
    };
    const run = (mode, overrides = {}) =>
      runMigration(
        mode,
        { ...env, ...overrides },
        { testDatabase: true, report: (line) => output.push(line) },
      );
    await callback({ client, run, env, output });
  } catch (error) {
    fixtureFailed = true;
    throw error;
  } finally {
    try {
      if (client) await client.end();
      if (created) await admin.unsafe(`drop database "${name}" with (force)`);
      // After the database drop: the grants this apply recorded are gone
      // with it. (The helper swallows 2BP01 for a concurrently adopted role;
      // it lives outside this finally so no throw sits inside it.)
      if (ownedRuntimeRole) await dropOwnedRuntimeRole(admin, fixtureFailed);
    } finally {
      await admin.end();
    }
  }
}

test("the workflow's actual shell gate denies disabled production and non-main refs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/db-migrate.yml", import.meta.url),
    "utf8",
  );
  const gate = workflow.match(/        run: \|\n([\s\S]*?)\n      - uses:/)?.[1];
  assert.ok(gate, "workflow gate must be present before checkout");
  const script = gate
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  for (const flag of ["", "false", "TRUE"]) {
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        ...mainEnv,
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: flag,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production migrations are disabled/);
  }
  assert.equal(
    spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        ...mainEnv,
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
      },
    }).status,
    0,
  );
  assert.equal(
    spawnSync("bash", ["-c", script], {
      env: { ...process.env, ...mainEnv, GITHUB_REF: "refs/heads/topic" },
    }).status,
    1,
  );
  assert.ok(
    workflow.includes(
      `runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`,
    ),
  );
  assert.match(workflow, /environment: \$\{\{ inputs.target \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /bash ci\/check-migration-numbers.sh/);
  for (const mode of ["plan", "apply", "verify"])
    assert.ok(workflow.includes(`node ci/db-migrate.mjs ${mode}`));
});

test("production is denied before connection for unset, false or non-exact flags", async () => {
  for (const flag of [undefined, "", "false", "TRUE", "1"]) {
    const env = { ...mainEnv, MIGRATION_TARGET: "production", PRODUCTION_DEPLOY_ENABLED: flag };
    await assert.rejects(runMigration("apply", env), /PRODUCTION_DEPLOY_ENABLED=true/);
  }
  const result = spawnSync(process.execPath, [script, "apply"], {
    env: {
      ...process.env,
      ...mainEnv,
      MIGRATION_TARGET: "production",
      PRODUCTION_DEPLOY_ENABLED: "",
      PRODUCTION_DATABASE_URL: "postgres://stub:DO_NOT_ECHO@invalid.test/db",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRODUCTION_DEPLOY_ENABLED=true/);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO|invalid.test/);
});

test("target/ref/secret/TLS/direct-endpoint checks are fail-closed without fallback", () => {
  assert.throws(() => migrationConfig({ ...mainEnv, MIGRATION_TARGET: "other" }), /Target/);
  assert.throws(() => migrationConfig({ ...mainEnv, GITHUB_REF: "refs/heads/topic" }), /main/);
  assert.throws(
    () => migrationConfig({ ...mainEnv, DATABASE_URL: "unused" }),
    /Missing PLANETSCALE_STAGING/,
  );
  assert.throws(
    () =>
      migrationConfig({
        ...mainEnv,
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
        PLANETSCALE_STAGING_DATABASE_URL: "unused",
      }),
    /Missing PRODUCTION_DATABASE_URL/,
  );
  for (const raw of [
    "secret-value",
    "postgres://user:DO_NOT_ECHO@localhost/postgres",
    "postgres://user:DO_NOT_ECHO@ep-stub-pooler.eu.aws.neon.tech/db?sslmode=require",
    "postgres://user:DO_NOT_ECHO@ep-stub.eu.aws.neon.tech/db?sslmode=disable",
  ]) {
    assert.throws(
      () => migrationConfig({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: raw }),
      (error) => {
        assert.doesNotMatch(safeMigrationError(error), /DO_NOT_ECHO|secret-value|postgres:\/\//);
        return true;
      },
    );
  }
  // Retired Neon endpoints are refused for staging: only the pinned
  // PlanetScale staging branch is accepted.
  const retiredNeon = "postgres://user:stub@ep-stub.eu.aws.neon.tech/db?sslmode=require";
  assert.throws(
    () => migrationConfig({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: retiredNeon }),
    /pinned staging endpoint/,
  );
  // Production is PlanetScale: a retired Neon URL must be refused, and a
  // direct PlanetScale URL (5432, pooled 6432 never) must be accepted.
  const production = "postgres://user:stub@stub-1.pg.psdb.cloud/db?sslmode=require";
  assert.equal(
    migrationConfig({
      ...mainEnv,
      MIGRATION_TARGET: "production",
      PRODUCTION_DEPLOY_ENABLED: "true",
      PRODUCTION_DATABASE_URL: production,
    }).target,
    "production",
  );
  assert.throws(
    () =>
      migrationConfig({
        ...mainEnv,
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
        PRODUCTION_DATABASE_URL: retiredNeon,
      }),
    /PlanetScale/,
  );
  // Only the pinned PlanetScale staging branch is accepted for staging: the
  // username suffix carries the branch id, so a production URL in the staging
  // secret fails closed even though staging migrations run automatically on
  // every push to main.
  const stagingPlanetScale = `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`;
  assert.equal(
    migrationConfig({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: stagingPlanetScale }).target,
    "staging",
  );
  // Production identity is refused explicitly, whether it arrives via the
  // production host, the production branch suffix, or both.
  const productionShaped = [
    `postgres://role-stub.${PLANETSCALE_PRODUCTION_BRANCH_ID}:stub@${PLANETSCALE_PRODUCTION_HOST}/db?sslmode=require`,
    `postgres://role-stub.${PLANETSCALE_PRODUCTION_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`,
    `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_PRODUCTION_HOST}/db?sslmode=require`,
  ];
  for (const raw of productionShaped) {
    assert.throws(
      () => migrationConfig({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: raw }),
      (error) => {
        assert.match(safeMigrationError(error), /production database/);
        assert.doesNotMatch(safeMigrationError(error), /stub|postgres:\/\//);
        return true;
      },
    );
  }
  // Unpinned PlanetScale hosts and pooled hosts are refused without naming
  // the production identity.
  for (const raw of [
    production,
    production.replace(".pg.psdb.cloud", "-pooler.pg.psdb.cloud"),
    stagingPlanetScale.replace(".pg.psdb.cloud", "-pooler.pg.psdb.cloud"),
  ]) {
    assert.throws(
      () => migrationConfig({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: raw }),
      (error) => {
        assert.doesNotMatch(safeMigrationError(error), /stub|postgres:\/\//);
        return true;
      },
    );
  }
  // A third branch on the pinned staging host is refused as a non-pinned
  // staging endpoint, not as the production identity: with Neon retired,
  // the host plus branch-id suffix is the whole staging identity.
  const thirdBranchOnStagingHost = `postgres://role-stub.9zzz9999zzzz:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`;
  assert.throws(
    () =>
      migrationConfig({
        ...mainEnv,
        PLANETSCALE_STAGING_DATABASE_URL: thirdBranchOnStagingHost,
      }),
    /pinned staging endpoint/,
  );
  assert.doesNotMatch(
    safeMigrationError(new Error("DO_NOT_ECHO postgres://credentials/ SQL")),
    /DO_NOT_ECHO|postgres:\/\/credentials|SQL/,
  );
});

test("driver configuration strips channel binding and pins the port despite PGPORT", async () => {
  const priorPort = process.env.PGPORT;
  process.env.PGPORT = "5433";
  try {
    const staging = `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`;
    for (const binding of [
      "",
      "&channel_binding=require",
      "&channel_binding=prefer",
      "&channel_binding=disable",
    ]) {
      const config = migrationConfig({
        ...mainEnv,
        PLANETSCALE_STAGING_DATABASE_URL: staging + binding,
      });
      assert.equal(config.url.searchParams.has("channel_binding"), false);
      const client = migrationClient(config); // Lazy constructor only: no live connection.
      try {
        assert.deepEqual(client.options.port, [5432]);
        assert.equal(client.options.connection.channel_binding, undefined);
        assert.equal(client.options.ssl.rejectUnauthorized, true);
      } finally {
        await client.end();
      }
    }
    // `require` (a common libpq default) is accepted wherever it appears and
    // stripped; only unknown values are still refused.
    for (const binding of ["invalid", "prefer&channel_binding=bogus"]) {
      assert.throws(
        () =>
          migrationConfig({
            ...mainEnv,
            PLANETSCALE_STAGING_DATABASE_URL: `${staging}&channel_binding=${binding}`,
          }),
        /channel binding/,
      );
    }
    const url = testAdminUrl();
    url.port = "";
    url.pathname = `/web_migrate_test_${randomUUID().replaceAll("-", "")}`;
    const client = migrationClient(
      migrationConfig(
        {
          ...mainEnv,
          CI: process.env.CI,
          GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
          PLANETSCALE_STAGING_DATABASE_URL: url.href,
        },
        { testDatabase: true },
      ),
    );
    try {
      assert.deepEqual(client.options.port, [5432]);
    } finally {
      await client.end();
    }
  } finally {
    if (priorPort === undefined) delete process.env.PGPORT;
    else process.env.PGPORT = priorPort;
  }
});

test("fresh database: plan is read-only, apply includes bootstraps, zero-pending and idempotent", async () => {
  await fixture(async ({ client, run, output }) => {
    assert.equal((await run("plan")).length, journal.entries.length);
    assert.equal(
      (await client`select to_regclass('drizzle.__drizzle_migrations') as ledger`)[0].ledger,
      null,
    );
    await assert.rejects(run("verify"), /remain pending/);
    await run("apply");
    assert.equal((await run("verify")).length, 0);
    assert.notEqual(
      (await client`select to_regclass('drizzle.__drizzle_migrations_id_seq') as sequence`)[0]
        .sequence,
      null,
      "fresh runner ledger keeps the canonical serial sequence both writers insert through",
    );
    await run("apply");
    // The canonical Drizzle migrator must recognize this runner's exact ledger.
    await migrate(drizzle(client), { migrationsFolder: source });
    assert.equal(
      Number((await client`select count(*) from drizzle.__drizzle_migrations`)[0].count),
      journal.entries.length,
    );
    assert.ok(output.some((line) => /Pre-migration PITR timestamp \(UTC\): \d{4}-.*Z/.test(line)));
    assert.ok(output.some((line) => line.includes("0000_init-users")));
    assert.ok(output.some((line) => line === "Post-check: zero pending web migrations."));
  });
});

test("partial journal prefix: remaining web SQL applies through the enabled production path on the test fixture", async () => {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "web-migrate-selftest-"),
  );
  try {
    mkdirSync(join(scratch, "meta"));
    const prefix = { ...journal, entries: journal.entries.slice(0, 3) };
    writeFileSync(join(scratch, "meta/_journal.json"), JSON.stringify(prefix));
    for (const entry of prefix.entries)
      copyFileSync(join(source, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
    await fixture(async ({ client, run }) => {
      await migrate(drizzle(client), { migrationsFolder: scratch });
      assert.equal((await run("plan")).length, journal.entries.length - 3);
      await run("apply", { MIGRATION_TARGET: "production", PRODUCTION_DEPLOY_ENABLED: "true" });
      assert.equal((await run("verify")).length, 0);
      await client`update drizzle.__drizzle_migrations set hash = 'edited' where id = 1`;
      await assert.rejects(run("apply"), /exact prefix/);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("canonical Drizzle migrator applies a pending migration after the runner", async () => {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "web-migrate-canonical-after-runner-"),
  );
  try {
    mkdirSync(join(scratch, "meta"));
    const extraTag = "1999_canonical-after-runner";
    const entries = [
      ...journal.entries,
      {
        idx: journal.entries.length,
        version: journal.version,
        when: journal.entries.at(-1).when + 1,
        tag: extraTag,
        breakpoints: true,
      },
    ];
    writeFileSync(
      join(scratch, "meta/_journal.json"),
      JSON.stringify({ version: journal.version, dialect: journal.dialect, entries }),
    );
    for (const entry of journal.entries)
      copyFileSync(join(source, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
    writeFileSync(
      join(scratch, `${extraTag}.sql`),
      "CREATE TABLE canonical_after_runner (id integer);\n--> statement-breakpoint\n",
    );
    await fixture(async ({ client, run }) => {
      await run("apply");
      await migrate(drizzle(client), { migrationsFolder: scratch });
      const rows =
        await client`select id, hash, created_at from drizzle.__drizzle_migrations order by id`;
      assert.equal(rows.length, journal.entries.length + 1);
      assert.ok(rows.every((row) => Number.isInteger(row.id)));
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("unreviewed default ACL refuses plan and apply with the offending reason", async () => {
  for (const grant of [
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON SEQUENCES TO PUBLIC",
  ]) {
    await fixture(async ({ client, run }) => {
      await client.unsafe(grant);
      for (const mode of ["plan", "apply"]) {
        let failure;
        try {
          await run(mode);
        } catch (error) {
          failure = error;
        }
        assert.ok(failure, `${grant} must refuse ${mode}`);
        assert.match(safeMigrationError(failure), /default-ACL guard refused/, `${grant} ${mode}`);
      }
      assert.equal(
        (await client`select to_regclass('drizzle.__drizzle_migrations') as ledger`)[0].ledger,
        null,
        "a refused apply must not create the ledger",
      );
    });
  }
});

test("another role's default ACL does not block this migration", async () => {
  await fixture(async ({ client, run }) => {
    const other = `preflight_other_${randomUUID().replaceAll("-", "")}`;
    await client.unsafe(`CREATE ROLE "${other}" NOLOGIN`);
    try {
      await client.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${other}" IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC`,
      );
      assert.equal((await run("plan")).length, journal.entries.length);
    } finally {
      await client.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${other}" IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC`,
      );
      await client.unsafe(`DROP ROLE "${other}"`);
    }
  });
});

test("runtime-role connection is refused while the reviewed sequence default passes", async () => {
  await fixture(async ({ client, run }) => {
    // The fixture provisions two_web_app (adopted or owned); this test only
    // uses it and never drops it, so it runs on provisioned clusters instead
    // of skipping. The fixture drops the role only when it created it.
    try {
      await client.unsafe(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO two_web_app",
      );
      await client.unsafe(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO two_web_app",
      );
      assert.equal((await run("plan")).length, journal.entries.length);
      await client.unsafe(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM two_web_app",
      );
      await client.unsafe("SET ROLE two_web_app");
      try {
        await assert.rejects(assertRuntimeDefaultAcl(client), (error) => {
          assert.ok(error instanceof DefaultAclRefusal);
          assert.match(error.message, /must not run as the runtime role/);
          return true;
        });
      } finally {
        await client.unsafe("RESET ROLE");
      }
    } finally {
      await client
        .unsafe(
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM two_web_app",
        )
        .catch(() => {});
    }
  });
});

test("preflight driver failures propagate for masking instead of surfacing driver text", async () => {
  await fixture(async ({ client, run }) => {
    const [db] = await client`select current_database() as name`;
    // PostgreSQL refuses to disallow connections from inside the database
    // itself, so flip the switch from the admin database instead.
    const admin = postgres(testAdminUrl().href, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`alter database "${db.name}" with allow_connections false`);
      try {
        // A catch-all that wraps preflight errors as MigrationError would echo
        // the driver message to the operator; only intentional refusals may
        // surface, so the raw failure must reach the masked branch instead.
        await assert.rejects(run("plan"), (error) => {
          assert.match(safeMigrationError(error), /database details withheld/);
          assert.doesNotMatch(error.message, /database details withheld/);
          return true;
        });
      } finally {
        await admin.unsafe(`alter database "${db.name}" with allow_connections true`);
      }
    } finally {
      await admin.end();
    }
  });
});

test("gapped/newer history and concurrent migration lock are refused", async () => {
  await fixture(async ({ client, run }) => {
    await client`select pg_advisory_lock(11161001)`;
    try {
      await assert.rejects(run("apply"), /holds the database lock/);
    } finally {
      await client`select pg_advisory_unlock(11161001)`;
    }
    await run("apply");
    await client`delete from drizzle.__drizzle_migrations where id = 1`;
    await assert.rejects(run("plan"), /exact prefix/);
  });
  await fixture(async ({ client, run }) => {
    await run("apply");
    await client`insert into drizzle.__drizzle_migrations (hash, created_at) values ('unknown', 9999999999999)`;
    await assert.rejects(run("verify"), /exact prefix/);
  });
});

// The exact postgres-js 3.4.9 write-after-close signature: a rollback write
// scheduled after `closed()` nulled the socket throws from a queued
// `nextWrite` immediate instead of rejecting the query. Every guard pin
// below feeds this synthetic crash, so the suite goes red if the matcher,
// the capture window, or the fatal-by-default path regresses.
function driverRaceCrash() {
  const error = new TypeError("Cannot read properties of null (reading 'write')");
  error.stack = [
    "TypeError: Cannot read properties of null (reading 'write')",
    "    at Immediate.nextWrite (node_modules/postgres/src/connection.js:255:22)",
    "    at process.processImmediate (node:internal/timers:574:21)",
  ].join("\n");
  return error;
}

test("driver race guard matches only the exact postgres write-after-close signature", () => {
  assert.equal(isDriverConnectionRaceCrash(driverRaceCrash()), true);
  // V8 spells the slot as `properties` on current Node and `property` on
  // older ones; the guard tolerates both spellings.
  const singular = driverRaceCrash();
  singular.message = "Cannot read property of null (reading 'write')";
  assert.equal(isDriverConnectionRaceCrash(singular), true);
  // Anything else must stay fatal: a guard that matches too broadly would
  // swallow real crashes. Each negative below pins one matcher clause.
  const wrongSlot = driverRaceCrash();
  wrongSlot.message = "Cannot read properties of null (reading 'read')";
  const plainError = new Error("Cannot read properties of null (reading 'write')");
  plainError.stack = driverRaceCrash().stack;
  const missingFrame = driverRaceCrash();
  missingFrame.stack = missingFrame.stack.replace("nextWrite", "nextTick");
  const missingModule = driverRaceCrash();
  missingModule.stack = missingModule.stack.replace(
    "postgres/src/connection.js",
    "postgres/src/index.js",
  );
  const missingStack = driverRaceCrash();
  missingStack.stack = undefined;
  for (const value of [
    wrongSlot,
    plainError,
    missingFrame,
    missingModule,
    missingStack,
    new TypeError("other"),
    null,
    undefined,
    "Cannot read properties of null (reading 'write')",
    { message: "Cannot read properties of null (reading 'write')" },
  ]) {
    assert.equal(isDriverConnectionRaceCrash(value), false);
  }
});

test("driver race capture swallows the exact crash and restores listeners", async () => {
  const before = process.listeners("uncaughtException").slice();
  const race = captureDriverRaceCrashes();
  try {
    // The capture replaces the listener set (node --test attributes every
    // emitted crash to the running test through its own listener), so only
    // the capture handler is installed inside the window.
    assert.equal(process.listeners("uncaughtException").length, 1);
    setImmediate(() => {
      throw driverRaceCrash();
    });
    setImmediate(() => {
      throw driverRaceCrash();
    });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(race.crashes.length, 2);
    for (const crash of race.crashes) assert.equal(isDriverConnectionRaceCrash(crash), true);
  } finally {
    race.release();
  }
  assert.deepEqual(process.listeners("uncaughtException"), before);
  race.release();
  assert.deepEqual(process.listeners("uncaughtException"), before);
});

test("capture restores the saved raw listeners before rethrowing a nonmatching error", () => {
  const witness = () => assert.fail("restoration must not dispatch the error to saved listeners");
  process.prependOnceListener("uncaughtException", witness);
  const before = process.rawListeners("uncaughtException");
  const race = captureDriverRaceCrashes();
  try {
    const [handler] = process.listeners("uncaughtException");
    const error = new Error("not-the-driver-race");
    // Call the real handler synchronously: assert.throws observes the rethrow
    // without turning it into an uncaught error in node's own test listener.
    assert.throws(
      () => handler(error),
      (thrown) => {
        assert.equal(thrown, error);
        assert.deepEqual(process.rawListeners("uncaughtException"), before);
        return true;
      },
    );
    assert.deepEqual(race.crashes, []);
    race.release();
    assert.deepEqual(process.rawListeners("uncaughtException"), before);
  } finally {
    race.release();
    process.removeListener("uncaughtException", witness);
  }
});

// Replace only the external driver in a child; journal/admission/reporting and
// runMigration (or the actual CLI entrypoint) execute unchanged. This driver
// deliberately has no begin/onclose Promise.race: the live backend-kill case
// below covers the real driver, while this seam isolates our explicit guard.
function controlledDriver(_url, options) {
  const state = globalThis.migrationDriverFixture;
  state.constructed = true;
  const query = async (text) => {
    state.statements.push(text);
    if (state.closed) {
      state.afterLoss.push(text);
      throw new Error("statement attempted after connection loss");
    }
    if (
      text === "SET LOCAL search_path = public" ||
      text === "SET LOCAL datestyle = 'ISO, YMD'" ||
      text === "SET LOCAL standard_conforming_strings = on"
    )
      return [];
    if (text.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
    if (text === "select current_user as current_user") return [{ current_user: "agent_test" }];
    if (text.includes("FROM pg_default_acl AS d")) return [];
    if (text.includes("to_regclass")) return [{ ledger: null }];
    if (text.includes("clock_timestamp")) return [{ timestamp: "2026-10-21T00:00:00.000000Z" }];
    throw new Error(`unexpected fixture statement: ${text}`);
  };
  const client = (strings) => query(strings.join("?"));
  client.unsafe = query;
  client.begin = async (callback) => {
    if (process.env.MIGRATION_DRIVER_CRASH) {
      const crash = process.env.MIGRATION_DRIVER_CRASH;
      setImmediate(() => {
        if (crash === "matching" || crash === "matching-reject") {
          const error = new TypeError("Cannot read properties of null (reading 'write')");
          error.stack =
            "TypeError: Cannot read properties of null (reading 'write')\n" +
            "    at Immediate.nextWrite (node_modules/postgres/src/connection.js:255:22)";
          throw error;
        }
        throw new Error("cli-nonmatching-uncaught-exception");
      });
      await new Promise((resolve) => setImmediate(resolve));
      // A rejection after the crash exercises the catch-side dedup guard:
      // the uncaught handler already printed the diagnostic, so the catch
      // must not print it a second time.
      if (crash === "matching-reject") throw new Error("cli-post-crash-rejection");
      console.log("driver continuation after crash");
      return [];
    }
    return callback(client);
  };
  client.end = async () => {
    state.ended = true;
  };
  state.loseConnection = () => {
    state.closed = true;
    options.onclose();
  };
  return client;
}

function withControlledMigrationDriver(callback) {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "migration-driver-"),
  );
  try {
    const preload = join(dir, "driver-preload.mjs");
    const driverUrl = `data:text/javascript,${encodeURIComponent(`export default ${controlledDriver.toString()}`)}`;
    writeFileSync(
      preload,
      `
import { registerHooks } from "node:module";
globalThis.migrationDriverFixture = { statements: [], afterLoss: [], closed: false, ended: false };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres" && context.parentURL === ${JSON.stringify(new URL("./db-migrate.mjs", import.meta.url).href)})
      return { url: ${JSON.stringify(driverUrl)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
`,
    );
    return callback({ dir, preload });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withheld =
  "Migration failed; database details withheld. Stop and investigate with the authorized database operator; do not substitute credentials.";

test("the PITR connection-loss guard throws MigrationError before any ledger or migration statement", () => {
  withControlledMigrationDriver(({ dir, preload }) => {
    const entry = join(dir, "guard.mjs");
    writeFileSync(
      entry,
      `
import assert from "node:assert/strict";
import { runMigration, safeMigrationError } from ${JSON.stringify(script)};
const state = globalThis.migrationDriverFixture;
const env = ${JSON.stringify({ ...mainEnv, PLANETSCALE_STAGING_DATABASE_URL: "postgres://agent_test@agent-testdb:5432/web_migrate_test_abcdef" })};
let MigrationError;
try { await runMigration("invalid", env); } catch (error) { MigrationError = error.constructor; }
assert.equal(MigrationError.name, "MigrationError");
const reports = [];
let caught;
try {
  await runMigration("apply", env, { testDatabase: true, report: (line) => {
    reports.push(line);
    if (line.startsWith("Pre-migration PITR timestamp")) {
      state.receipt = true;
      state.loseConnection();
    }
  }});
} catch (error) { caught = error; }
assert.equal(state.constructed, true);
assert.equal(state.receipt, true, "the actual runner must reach the PITR receipt");
assert.equal(state.closed, true);
assert.deepEqual(state.afterLoss, [], "no ledger/schema/migration statements may be attempted after loss");
assert.ok(caught instanceof MigrationError, "the explicit guard must refuse with MigrationError, not a driver rejection");
assert.equal(caught.message, ${JSON.stringify(withheld)});
assert.equal(safeMigrationError(caught), ${JSON.stringify(withheld)});
assert.equal(state.ended, true, "the client is still closed in finally");
assert.deepEqual(state.statements, [
  "SET LOCAL search_path = public",
  "SET LOCAL datestyle = 'ISO, YMD'",
  "SET LOCAL standard_conforming_strings = on",
  "select pg_try_advisory_xact_lock(?) as acquired",
  "select current_user as current_user",
  ${JSON.stringify(`
  SELECT d.defaclobjtype AS object_type,
         CASE WHEN d.defaclnamespace = 0 THEN '(global)' ELSE n.nspname END AS schema_name,
         CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
         pg_get_userbyid(acl.grantor) AS grantor,
         acl.privilege_type,
         acl.is_grantable
    FROM pg_default_acl AS d
    LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
   WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND d.defaclobjtype IN ('r', 'S')
     AND (d.defaclnamespace = 0 OR n.nspname = 'public')
   ORDER BY 1, 2, 3, 4, 5, 6
`)},
  "select to_regclass(?) as ledger",
  ${JSON.stringify("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as timestamp")},
]);
assert.ok(reports.includes("Pending: ${journal.entries.length} (${journal.entries.map((entry) => entry.tag).join(", ")})"));
assert.ok(!reports.includes("Post-check: zero pending web migrations."));
console.log("guard refused before DDL");
`,
    );
    const result = spawnSync(process.execPath, ["--import", preload, entry], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /guard refused before DDL/);
  });
});

test("the actual CLI rethrows nonmatching uncaught exceptions instead of masking or continuing", () => {
  withControlledMigrationDriver(({ preload }) => {
    const cli = (crash) =>
      spawnSync(process.execPath, ["--import", preload, script, "apply"], {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          ...mainEnv,
          GITHUB_STEP_SUMMARY: "",
          // Synthetic credential accepted by admission only; the loader replaces
          // postgres before construction, so no DNS/socket/database is touched.
          PLANETSCALE_STAGING_DATABASE_URL: `postgres://fixture.${PLANETSCALE_STAGING_BRANCH_ID}:fixture@${PLANETSCALE_STAGING_HOST}/fixture?sslmode=require`,
          MIGRATION_DRIVER_CRASH: crash,
        },
      });
    const negative = cli("nonmatching");
    assert.equal(negative.error, undefined);
    assert.notEqual(negative.status, 0);
    assert.match(negative.stderr, /Error: cli-nonmatching-uncaught-exception/);
    assert.doesNotMatch(negative.stderr, /database details withheld/);
    assert.doesNotMatch(negative.stdout, /driver continuation after crash/);
    const matching = cli("matching");
    assert.equal(matching.error, undefined);
    assert.equal(matching.status, 1);
    assert.equal(matching.stderr.trim(), withheld);
    assert.match(matching.stdout, /driver continuation after crash/);
  });
});

test("a matching crash followed by a runner rejection prints exactly one diagnostic", () => {
  withControlledMigrationDriver(({ preload }) => {
    const result = spawnSync(process.execPath, ["--import", preload, script, "apply"], {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        ...mainEnv,
        GITHUB_STEP_SUMMARY: "",
        // Synthetic credential accepted by admission only; the loader replaces
        // postgres before construction, so no DNS/socket/database is touched.
        PLANETSCALE_STAGING_DATABASE_URL: `postgres://fixture.${PLANETSCALE_STAGING_BRANCH_ID}:fixture@${PLANETSCALE_STAGING_HOST}/fixture?sslmode=require`,
        MIGRATION_DRIVER_CRASH: "matching-reject",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), withheld);
  });
});

test("uncaught errors outside the driver race signature still fail the run", () => {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "driver-race-negative-"),
  );
  try {
    // A non-matching crash inside the window must stay fatal. This runs in a
    // child process because a fatal crash cannot be asserted in-process.
    const fatal = join(dir, "fatal.mjs");
    writeFileSync(
      fatal,
      [
        `import { captureDriverRaceCrashes } from ${JSON.stringify(script)};`,
        "const race = captureDriverRaceCrashes();",
        'setImmediate(() => { throw new Error("not-the-driver-race"); });',
        "for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));",
        "race.release();",
        'console.log("wrongly swallowed");',
        "",
      ].join("\n"),
    );
    const failure = spawnSync(process.execPath, [fatal], { encoding: "utf8" });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /not-the-driver-race/);
    assert.doesNotMatch(failure.stdout, /wrongly swallowed/);
    // The exact signature is still swallowed in a bare process with no test
    // runner listeners, proving the save/restore path with an empty set.
    const swallowed = join(dir, "swallowed.mjs");
    writeFileSync(
      swallowed,
      [
        `import { captureDriverRaceCrashes, isDriverConnectionRaceCrash } from ${JSON.stringify(script)};`,
        "const race = captureDriverRaceCrashes();",
        "setImmediate(() => {",
        "  const error = new TypeError(\"Cannot read properties of null (reading 'write')\");",
        "  error.stack = [",
        "    \"TypeError: Cannot read properties of null (reading 'write')\",",
        '    "    at Immediate.nextWrite (node_modules/postgres/src/connection.js:255:22)",',
        '    "    at process.processImmediate (node:internal/timers:574:21)",',
        '  ].join("\\n");',
        "  throw error;",
        "});",
        "for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));",
        "if (race.crashes.length !== 1 || !isDriverConnectionRaceCrash(race.crashes[0])) {",
        '  console.error("capture missed the exact signature");',
        "  process.exit(2);",
        "}",
        "race.release();",
        'console.log("captured 1");',
        "",
      ].join("\n"),
    );
    const success = spawnSync(process.execPath, [swallowed], { encoding: "utf8" });
    assert.equal(success.status, 0);
    assert.match(success.stdout, /captured 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connection loss after the PITR receipt fails closed while another session owns the lock", async (t) => {
  await fixture(async ({ client, env, output }) => {
    // Killing the lock holder can surface the driver race crash (a rollback
    // write scheduled after the socket closed) instead of only the clean
    // connection error. Capture that exact signature so the stray crash
    // cannot kill the selftest process; the fail-closed rejection below is
    // still required in both paths.
    const race = captureDriverRaceCrashes();
    let interrupted;
    try {
      const operation = runMigration("apply", env, {
        testDatabase: true,
        report: (line) => {
          output.push(line);
          if (!line.startsWith("Pre-migration PITR timestamp")) return;
          interrupted = (async () => {
            // Select only the lock holder in our UUID-owned fixture, never other backends.
            const holders =
              await client`select a.pid from pg_locks l join pg_stat_activity a using (pid)
            where a.datname = current_database() and l.locktype = 'advisory'
              and l.classid = 0 and l.objid = 11161001 and l.granted`;
            assert.equal(holders.length, 1);
            const [result] =
              await client`select pg_terminate_backend(${holders[0].pid}) as terminated`;
            assert.equal(result.terminated, true);
            await client`select pg_advisory_lock(11161001)`;
          })();
          return interrupted;
        },
      });
      await assert.rejects(operation, (error) => {
        assert.match(safeMigrationError(error), /database details withheld/);
        return true;
      });
      assert.ok(interrupted, "the actual runner reached its pre-DDL PITR receipt");
      await interrupted;
      assert.equal((await client`select to_regclass('public.users') as users`)[0].users, null);
      assert.equal(
        (await client`select to_regclass('drizzle.__drizzle_migrations') as ledger`)[0].ledger,
        null,
      );
      assert.ok(!output.includes("Post-check: zero pending web migrations."));
    } finally {
      try {
        if (interrupted) await interrupted;
        // Drain pending immediates while the capture is still attached: the
        // race crash fires from a queued immediate that can land after the
        // fail-closed rejection already resolved.
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
        if (race.crashes.length > 0)
          t.diagnostic(
            `driver race crash captured ${race.crashes.length}x; fail-closed rejection still held`,
          );
      } finally {
        race.release();
        await client`select pg_advisory_unlock(11161001)`;
      }
    }
  });
});

test("hostile database search_path cannot misroute canonical DDL into a shadow schema", async () => {
  await fixture(async ({ client, run, output }) => {
    await client`create schema "other"`;
    const [db] = await client`select current_database() as name`;
    // A hostile role/database default, as a mis-provisioned staging branch
    // could carry. The runner must still apply unqualified canonical SQL to
    // `public`.
    await client.unsafe(`alter database "${db.name}" set search_path = "other", public`);
    await run("apply");
    const columns = await client`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'events'`;
    assert.ok(
      columns.some((row) => row.column_name === "ics_sequence"),
      "migration 1014 must add ics_sequence to public.events",
    );
    const shadow = await client`select table_name from information_schema.tables
      where table_schema = 'other'`;
    assert.deepEqual(
      shadow.map((row) => row.table_name),
      [],
      "no canonical table may land in the shadow schema",
    );
    assert.equal((await run("verify")).length, 0);
    assert.ok(output.includes("Post-check: zero pending web migrations."));
  });
});

test("hostile database DateStyle cannot skew the PITR receipt", async () => {
  await fixture(async ({ client, run, output }) => {
    const [db] = await client`select current_database() as name`;
    await client.unsafe(`alter database "${db.name}" set datestyle to 'SQL, DMY'`);
    await run("apply");
    const line = output.find((entry) => entry.startsWith("Pre-migration PITR timestamp (UTC): "));
    assert.ok(line, "apply must record a PITR receipt");
    const stamp = line.match(/\(UTC\): (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+)Z/)?.[1];
    assert.ok(stamp, "PITR receipt must stay ISO UTC text under a hostile DateStyle");
    const reported = Date.parse(`${stamp.slice(0, 23)}Z`);
    // epoch extraction is numeric and immune to DateStyle: the receipt must
    // name the actual migration time, not a month/day-swapped impostor.
    const [now] = await client`select extract(epoch from clock_timestamp()) as epoch`;
    assert.ok(
      Math.abs(reported / 1000 - Number(now.epoch)) < 300,
      "PITR receipt must match the server clock within five minutes",
    );
    assert.equal((await run("verify")).length, 0);
  });
});

test("hostile database standard_conforming_strings cannot change migration string lexing", async () => {
  await fixture(async ({ client, run, env }) => {
    const [db] = await client`select current_database() as name`;
    // The runtime-rights guard lexes plain strings without backslash escapes;
    // a hostile database default must not reopen escapes for applied SQL.
    await client.unsafe(`alter database "${db.name}" set standard_conforming_strings = off`);
    const pinned = migrationClient(migrationConfig(env, { testDatabase: true }));
    try {
      const [row] = await pinned`show standard_conforming_strings`;
      assert.equal(row.standard_conforming_strings, "on");
    } finally {
      await pinned.end();
    }
    await run("apply");
    assert.equal((await run("verify")).length, 0);
  });
});

test("failed SQL rolls back the full pending batch; timestamp survives and errors withhold SQL", async () => {
  await fixture(async ({ client, run, output }) => {
    await client`create table profiles (fixture_only integer)`;
    let failure;
    try {
      await run("apply");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(safeMigrationError(failure), /database details withheld/);
    assert.equal((await client`select to_regclass('public.users') as users`)[0].users, null);
    assert.equal(
      (await client`select to_regclass('drizzle.__drizzle_migrations') as ledger`)[0].ledger,
      null,
    );
    assert.ok(output.some((line) => line.startsWith("Pre-migration PITR timestamp")));
  });
});
