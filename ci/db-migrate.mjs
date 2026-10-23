import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { assertMigrationAdmission } from "./migration-admission.mjs";
import { DefaultAclRefusal, assertRuntimeDefaultAcl } from "./migration-runtime-rights.mjs";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const ledger = "drizzle.__drizzle_migrations";
const lockKey = 11161001;

// PlanetScale Postgres identity pins (infrastructure identifiers, not secrets).
// Usernames carry the branch as <role-credential>.<branch_id>, so the username
// suffix is the branch identity even if branch hosts ever converge. Both pins
// are required: the suffix proves the branch, the host pin keeps a
// mis-provisioned production endpoint out. Update both when the staging branch
// is recreated (its roles and secrets rotate then too).
export const PLANETSCALE_STAGING_HOST = "aws-us-east-1-4.pg.psdb.cloud";
export const PLANETSCALE_STAGING_BRANCH_ID = "4vmu64sp52p4";
export const PLANETSCALE_PRODUCTION_HOST = "aws-us-east-1-1.pg.psdb.cloud";
export const PLANETSCALE_PRODUCTION_BRANCH_ID = "mmzi498bs6m5";

const branchIdOf = (username) => username.split(".").pop() ?? "";

// A production URL in the staging secret must fail closed: staging migrations
// run automatically on every push to main with no reviewers.
const isProductionIdentity = (url) =>
  /^[a-z0-9-]+\.pg\.psdb\.cloud$/.test(url.hostname) &&
  (url.hostname === PLANETSCALE_PRODUCTION_HOST ||
    branchIdOf(url.username) === PLANETSCALE_PRODUCTION_BRANCH_ID);

// Staging is the pinned PlanetScale staging branch only: the username suffix
// carries the branch id and the host pin keeps a mis-provisioned production
// endpoint out. Retired Neon endpoints are refused.
const isStagingEndpoint = (url) =>
  url.hostname === PLANETSCALE_STAGING_HOST &&
  branchIdOf(url.username) === PLANETSCALE_STAGING_BRANCH_ID;

class MigrationError extends Error {}
const refuse = (message) => {
  throw new MigrationError(message);
};

// Pending GRANTs to the runtime role need the operator-provisioned two_web_app
// role (docs/db-migrations.md "Runtime role bootstrap"). Refuse with the exact
// remedy instead of failing mid-apply behind the masked driver error. The
// pattern is a tripwire, not a parser: the guard owns GRANT syntax, and an
// over-match only requires a role the next real GRANT needs anyway.
// The trailing boundary applies to the bare spelling only: a closing quote is
// self-delimiting and never forms a word boundary with what follows it.
const RUNTIME_GRANT_TRIPWIRE = /\bgrant\b[\s\S]*?\bto\s+("two_web_app"|two_web_app\b)/i;

export function pendingGrantsRuntimeRole(pending) {
  return pending.some((entry) =>
    entry.sql.some((statement) => RUNTIME_GRANT_TRIPWIRE.test(statement)),
  );
}

export async function assertRuntimeRolePresent(connection, pending) {
  if (!pendingGrantsRuntimeRole(pending)) return;
  const [role] = await connection`select 1 as ok from pg_roles where rolname = 'two_web_app'`;
  if (!role)
    refuse(
      'Missing two_web_app role: the authorized database operator must run CREATE ROLE "two_web_app" NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION on this target before pending GRANT-bearing migrations can apply.',
    );
}

export function migrationConfig(env, { testDatabase = false } = {}) {
  // Single admission source: the contract owner is assertMigrationAdmission
  // (ci/migration-admission.mjs). Re-throw as MigrationError so CLI masking
  // in safeMigrationError keeps the specific operator-facing message.
  // Gate before URL parsing, driver construction, or any database work.
  try {
    assertMigrationAdmission(env);
  } catch (error) {
    refuse(error instanceof Error ? error.message : "Migration admission refused.");
  }
  const target = env.MIGRATION_TARGET;
  const secret =
    target === "staging" ? "PLANETSCALE_STAGING_DATABASE_URL" : "PRODUCTION_DATABASE_URL";
  if (!env[secret]) refuse(`Missing ${secret} Environment secret; no fallback is permitted.`);
  let url;
  try {
    url = new URL(env[secret]);
  } catch {
    refuse("Invalid migration URL; value withheld.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)
  ) {
    refuse("Invalid migration endpoint; value withheld.");
  }
  if (testDatabase) {
    const agent =
      url.hostname === "agent-testdb" && url.username === "agent_test" && url.password === "";
    const ci =
      env.GITHUB_ACTIONS === "true" &&
      env.CI === "true" &&
      url.hostname === "postgres" &&
      url.username === "postgres" &&
      url.password === "ci";
    if ((!agent && !ci) || url.search || !/^\/web_migrate_test_[a-f0-9]+$/.test(url.pathname)) {
      refuse("Selftest requires its owned database on agent-testdb or the CI Postgres service.");
    }
  } else if (target === "staging" && isProductionIdentity(url)) {
    refuse("Refusing staging migration against the production database; value withheld.");
  } else if (target === "staging" && !isStagingEndpoint(url)) {
    refuse("Migrations require the pinned staging endpoint with TLS; value withheld.");
  } else if (
    target === "production" &&
    // PlanetScale Postgres direct endpoint: <id>.pg.psdb.cloud:5432.
    // The pooled 6432 port and -pooler hosts are refused: DDL and the
    // transaction advisory lock must bypass transaction pooling.
    (!/^[a-z0-9-]+\.pg\.psdb\.cloud$/.test(url.hostname) ||
      url.hostname.split(".")[0].endsWith("-pooler"))
  ) {
    refuse("Production migrations require a direct PlanetScale endpoint with TLS; value withheld.");
  }
  // Disposable test databases carry no TLS params or password; their strict
  // hostname/principal check above is the whole gate. Live targets always
  // need credentials and verified TLS.
  if (
    !testDatabase &&
    (!url.username ||
      !url.password ||
      !["require", "verify-full"].includes(url.searchParams.get("sslmode")) ||
      [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)))
  ) {
    refuse("Migrations require a direct endpoint with TLS; value withheld.");
  }
  const bindings = url.searchParams.getAll("channel_binding");
  if (bindings.some((value) => !["require", "prefer", "disable"].includes(value)))
    refuse("Invalid channel binding option; value withheld.");
  // postgres.js forwards unknown URL options as startup settings, not libpq flags,
  // and does not implement SCRAM channel binding. Strip the libpq-only flag here
  // (including `require`, a common libpq default); TLS stays enforced via
  // sslmode=require|verify-full + rejectUnauthorized:true in migrationClient.
  url.searchParams.delete("channel_binding");
  url.port = "5432";
  return { target, url, testDatabase };
}

function journal() {
  const entries = JSON.parse(
    readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
  ).entries;
  const migrations = readMigrationFiles({ migrationsFolder });
  const sqlFiles = readdirSync(migrationsFolder)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const trackedFiles = entries.map((entry) => `${entry.tag}.sql`).sort();
  if (JSON.stringify(sqlFiles) !== JSON.stringify(trackedFiles))
    refuse("SQL files and migration journal differ.");
  for (const [index, entry] of entries.entries()) {
    const bootstrap =
      (index === 0 && entry.tag === "0000_init-users") ||
      (index === 1 && entry.tag === "0001_agent-events");
    if (
      entry.idx !== index ||
      (!bootstrap && !/^1\d{3}_[a-zA-Z0-9_-]+$/.test(entry.tag)) ||
      !Number.isSafeInteger(entry.when) ||
      (index > 0 && entry.when <= entries[index - 1].when)
    ) {
      refuse("Invalid web migration journal order or numbering.");
    }
  }
  return entries.map((entry, index) => ({ ...migrations[index], tag: entry.tag }));
}

async function pendingMigrations(client, migrations) {
  const [exists] = await client`select to_regclass(${ledger}) as ledger`;
  const applied = exists.ledger
    ? await client`select hash, created_at from drizzle.__drizzle_migrations order by created_at, id`
    : [];
  // Drizzle uses a timestamp high-water mark. Require an exact checksum prefix so
  // edited SQL, missing history, bot entries, or a newer release cannot hide work.
  for (const [index, row] of applied.entries()) {
    const migration = migrations[index];
    if (
      !migration ||
      Number(row.created_at) !== migration.folderMillis ||
      row.hash !== migration.hash
    ) {
      refuse(
        "Migration history is not an exact prefix of this release; coordinate with web/bot owners, do not repair automatically.",
      );
    }
  }
  return migrations.slice(applied.length);
}

export function safeMigrationError(error) {
  if (error instanceof MigrationError) return error.message;
  // Never log driver errors: they can contain URLs, credentials, SQL or row data.
  return "Migration failed; database details withheld. Stop and investigate with the authorized database operator; do not substitute credentials.";
}

// postgres.js surfaces kill-backend timing as an uncaught driver-internal
// crash when a write is scheduled after the socket closed: `closed()` nulls
// the socket, a later `write()` buffers and queues `nextWrite`, and the
// immediate throws `TypeError: Cannot read properties of null (reading
// 'write')` instead of rejecting the query. Inside `client.begin` the
// automatic rollback is the write that loses this race, so the migration
// itself still rejects fail-closed while the stray crash would kill the
// process with a raw driver stack. Recognize that exact signature so the
// CLI and the selftest can fail closed on it; anything else rethrows.
export function isDriverConnectionRaceCrash(error) {
  return (
    error instanceof TypeError &&
    /Cannot read propert\w+ of null \(reading 'write'\)/.test(error.message) &&
    (error.stack ?? "").includes("nextWrite") &&
    (error.stack ?? "").includes("postgres/src/connection.js")
  );
}

// Capture the driver race crash for a bounded window. Returns the captured
// crashes and a release function; the caller must release in a finally so a
// late crash cannot leak into unrelated work, and must yield to the event
// loop before releasing so a pending crash lands inside the window.
// Merely adding a listener is not enough under `node --test`: the runner
// attributes every emitted uncaughtException to the running test through its
// own plain listener, so the capture temporarily replaces the listener set
// (Node 22/24 use a plain listener, not a capture callback) and restores it
// on release. Anything that does not match the exact driver race signature
// restores the listeners and rethrows to crash loudly.
export function captureDriverRaceCrashes() {
  const crashes = [];
  const saved = process.rawListeners("uncaughtException");
  let released = false;
  const restore = () => {
    if (released) return;
    released = true;
    process.removeListener("uncaughtException", onCrash);
    for (const listener of saved) process.on("uncaughtException", listener);
  };
  const onCrash = (error) => {
    if (!isDriverConnectionRaceCrash(error)) {
      restore();
      throw error;
    }
    crashes.push(error);
  };
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", onCrash);
  return { crashes, release: restore };
}

export function migrationClient(config, hooks = {}) {
  return postgres(config.url.href, {
    port: 5432,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: 10,
    password: () => decodeURIComponent(config.url.password),
    ssl: config.testDatabase ? false : { rejectUnauthorized: true },
    // Canonical migration SQL uses unqualified identifiers intending `public`.
    // postgres.js merges `connection` into the startup packet (see StartupMessage
    // in node_modules/postgres/src/connection.js), so pin per-connection GUCs
    // here: a hostile role/database `search_path` or `DateStyle` must not
    // misroute DDL or skew the PITR receipt, and `standard_conforming_strings`
    // must stay on because the runtime-rights guard lexes plain strings
    // without backslash escapes. Never ALTER ROLE/DATABASE defaults.
    connection: {
      statement_timeout: 120000,
      lock_timeout: 10000,
      search_path: "public",
      datestyle: "ISO, YMD",
      standard_conforming_strings: "on",
    },
    onnotice: () => {},
    onclose: () => hooks.onclose?.(),
  });
}

export async function runMigration(mode, env = process.env, options = {}) {
  if (!["plan", "apply", "verify"].includes(mode)) refuse("Mode must be plan, apply or verify.");
  const config = migrationConfig(env, options);
  const migrations = journal();
  const report = options.report ?? console.log;
  const summary = async (text) => {
    await report(text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  let connectionLost = false;
  const client = migrationClient(config, {
    onclose: () => {
      connectionLost = true;
    },
  });
  const plan = async (connection) => {
    // Surface only intentional refusals as MigrationError so the operator CLI
    // names the offending default ACL instead of masking it as withheld
    // driver details. The refusal names grantees and privileges only, never
    // credentials. Any other error is a driver failure: re-throw it unchanged
    // so safeMigrationError masks it instead of echoing driver text.
    try {
      await assertRuntimeDefaultAcl(connection);
    } catch (error) {
      if (error instanceof DefaultAclRefusal) refuse(error.message);
      throw error;
    }
    const pending = await pendingMigrations(connection, migrations);
    await assertRuntimeRolePresent(connection, pending);
    await summary(`### Web migrations: ${config.target} / ${mode}`);
    await summary(
      `Pending: ${pending.length}${pending.length ? ` (${pending.map((entry) => entry.tag).join(", ")})` : ""}`,
    );
    return pending;
  };
  try {
    if (mode !== "apply") {
      const pending = await plan(client);
      if (mode === "verify" && pending.length)
        refuse("Post-check failed: web migrations remain pending.");
      return pending;
    }
    // sql.begin pins one connection and rejects on loss: never resume unlocked.
    // Sources: https://github.com/porsager/postgres#transactions
    // https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS
    const remaining = await client.begin(async (transaction) => {
      // Defense in depth with the startup pin in migrationClient: even when
      // the role/database default search_path or DateStyle is hostile, this
      // transaction applies canonical SQL to `public`. Never ALTER ROLE or
      // DATABASE defaults as a fix; owned test fixtures may set hostile
      // defaults to prove the pin.
      await transaction.unsafe("SET LOCAL search_path = public");
      await transaction.unsafe("SET LOCAL datestyle = 'ISO, YMD'");
      await transaction.unsafe("SET LOCAL standard_conforming_strings = on");
      const [lock] = await transaction`select pg_try_advisory_xact_lock(${lockKey}) as acquired`;
      if (!lock.acquired)
        refuse("Another web migration holds the database lock; retry only after it finishes.");
      const pending = await plan(transaction);
      // to_char text is immune to the server DateStyle: the driver parses
      // timestamptz via `new Date(text)` (postgres/src/types.js), which swaps
      // month/day on SQL/DMY output and shifts the PITR receipt by months.
      const [clock] =
        await transaction`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as timestamp`;
      await summary(`Pre-migration PITR timestamp (UTC): ${clock.timestamp}`);
      await summary(
        `Release: ${/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : "local selftest"}`,
      );
      if (connectionLost) {
        // The server closed our only connection after the PITR receipt (failover,
        // backend termination). Fail closed here instead of issuing DDL on a dead
        // socket: postgres-js 3.4.9 crashes with TypeError on write-after-close
        // (null socket in nextWrite) instead of rejecting the query.
        refuse(safeMigrationError(new Error("connection lost after PITR receipt")));
      }
      // Keep Drizzle's journal SQL/hash/timestamp and default ledger format, but
      // include ledger setup and history validation in the same locked transaction.
      // Source: https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/dialect.ts
      // The serial ledger sequence is runner-owned infrastructure in the drizzle
      // schema, not a migration-created public object: both this runner and the
      // canonical drizzle-kit migrator insert (hash, created_at) through its
      // default, so explicit ids or an integer ledger would break the other writer.
      await transaction`create schema if not exists drizzle`;
      await transaction`create table if not exists drizzle.__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint
      )`;
      for (const migration of pending) {
        for (const statement of migration.sql) await transaction.unsafe(statement);
        await transaction`insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${migration.hash}, ${migration.folderMillis})`;
      }
      const remaining = await pendingMigrations(transaction, migrations);
      if (remaining.length) refuse("Post-check failed: web migrations remain pending.");
      return remaining;
    });
    await summary("Post-check: zero pending web migrations.");
    return remaining;
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A connection lost mid-migration can additionally surface the driver race
  // crash after the runner already rejected: swallow only that signature and
  // fail closed instead of dumping a raw driver stack. The natural
  // fail-closed rejection still carries the disposition; a crash landing
  // after it settled must not print twice or override success. A crash
  // landing first settles too, so a second stray crash cannot print again.
  let settled = false;
  process.on("uncaughtException", (error) => {
    if (!isDriverConnectionRaceCrash(error)) throw error;
    if (settled) return;
    console.error(safeMigrationError(error));
    process.exitCode = 1;
    settled = true;
  });
  try {
    await runMigration(process.argv[2]);
  } catch (error) {
    console.error(safeMigrationError(error));
    process.exitCode = 1;
  } finally {
    settled = true;
  }
}
