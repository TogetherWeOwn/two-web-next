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
  migrationClient,
  migrationConfig,
  runMigration,
  safeMigrationError,
} from "./neon-migrate.mjs";

const mainEnv = { GITHUB_REF: "refs/heads/main", MIGRATION_TARGET: "staging" };
const script = fileURLToPath(new URL("./neon-migrate.mjs", import.meta.url));
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
  try {
    await admin.unsafe(`create database "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    client = postgres(url.href, options);
    const output = [];
    const env = {
      ...mainEnv,
      CI: process.env.CI,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      NEON_STAGING_DATABASE_URL: url.href,
      NEON_PRODUCTION_DATABASE_URL: url.href,
    };
    const run = (mode, overrides = {}) =>
      runMigration(
        mode,
        { ...env, ...overrides },
        { testDatabase: true, report: (line) => output.push(line) },
      );
    await callback({ client, run, env, output });
  } finally {
    try {
      if (client) await client.end();
      if (created) await admin.unsafe(`drop database "${name}" with (force)`);
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
    assert.ok(workflow.includes(`node ci/neon-migrate.mjs ${mode}`));
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
      NEON_PRODUCTION_DATABASE_URL: "postgres://stub:DO_NOT_ECHO@invalid.test/db",
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
    /Missing NEON_STAGING/,
  );
  assert.throws(
    () =>
      migrationConfig({
        ...mainEnv,
        MIGRATION_TARGET: "production",
        PRODUCTION_DEPLOY_ENABLED: "true",
        NEON_STAGING_DATABASE_URL: "unused",
      }),
    /Missing NEON_PRODUCTION/,
  );
  for (const raw of [
    "secret-value",
    "postgres://user:DO_NOT_ECHO@localhost/postgres",
    "postgres://user:DO_NOT_ECHO@ep-stub-pooler.eu.aws.neon.tech/db?sslmode=require",
    "postgres://user:DO_NOT_ECHO@ep-stub.eu.aws.neon.tech/db?sslmode=disable",
  ]) {
    assert.throws(
      () => migrationConfig({ ...mainEnv, NEON_STAGING_DATABASE_URL: raw }),
      (error) => {
        assert.doesNotMatch(safeMigrationError(error), /DO_NOT_ECHO|secret-value|postgres:\/\//);
        return true;
      },
    );
  }
  const staging = "postgres://user:stub@ep-stub.eu.aws.neon.tech/db?sslmode=require";
  assert.equal(
    migrationConfig({ ...mainEnv, NEON_STAGING_DATABASE_URL: staging }).target,
    "staging",
  );
  assert.equal(
    migrationConfig({
      ...mainEnv,
      MIGRATION_TARGET: "production",
      PRODUCTION_DEPLOY_ENABLED: "true",
      NEON_PRODUCTION_DATABASE_URL: staging,
    }).target,
    "production",
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
    const staging = "postgres://user:stub@ep-stub.eu.aws.neon.tech/db?sslmode=require";
    for (const binding of [
      "",
      "&channel_binding=require",
      "&channel_binding=prefer",
      "&channel_binding=disable",
    ]) {
      const config = migrationConfig({ ...mainEnv, NEON_STAGING_DATABASE_URL: staging + binding });
      assert.equal(config.url.searchParams.has("channel_binding"), false);
      const client = migrationClient(config); // Lazy constructor only: no Neon connection.
      try {
        assert.deepEqual(client.options.port, [5432]);
        assert.equal(client.options.connection.channel_binding, undefined);
        assert.equal(client.options.ssl.rejectUnauthorized, true);
      } finally {
        await client.end();
      }
    }
    // `require` (the Neon default) is accepted wherever it appears and stripped;
    // only unknown values are still refused.
    for (const binding of ["invalid", "prefer&channel_binding=bogus"]) {
      assert.throws(
        () =>
          migrationConfig({
            ...mainEnv,
            NEON_STAGING_DATABASE_URL: `${staging}&channel_binding=${binding}`,
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
          NEON_STAGING_DATABASE_URL: url.href,
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
    await run("apply");
    // The canonical Drizzle migrator must recognize this runner's exact ledger.
    await migrate(drizzle(client), { migrationsFolder: source });
    assert.equal(
      Number((await client`select count(*) from drizzle.__drizzle_migrations`)[0].count),
      journal.entries.length,
    );
    assert.ok(
      output.some((line) => /Pre-migration Neon PITR timestamp \(UTC\): \d{4}-.*Z/.test(line)),
    );
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

test("connection loss after the PITR receipt fails closed while another session owns the lock", async () => {
  await fixture(async ({ client, env, output }) => {
    let interrupted;
    try {
      const operation = runMigration("apply", env, {
        testDatabase: true,
        report: (line) => {
          output.push(line);
          if (!line.startsWith("Pre-migration Neon PITR timestamp")) return;
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
      } finally {
        await client`select pg_advisory_unlock(11161001)`;
      }
    }
  });
});

test("hostile database search_path cannot misroute canonical DDL into a shadow schema", async () => {
  await fixture(async ({ client, run, output }) => {
    await client`create schema "other"`;
    const [db] = await client`select current_database() as name`;
    // A hostile role/database default, as Neon staging could carry. The
    // runner must still apply unqualified canonical SQL to `public`.
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
    const line = output.find((entry) =>
      entry.startsWith("Pre-migration Neon PITR timestamp (UTC): "),
    );
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
    assert.ok(output.some((line) => line.startsWith("Pre-migration Neon PITR timestamp")));
  });
});
