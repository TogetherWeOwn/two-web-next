import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const ledger = "drizzle.__drizzle_migrations";
const lockKey = 11161001;

class MigrationError extends Error {}
const refuse = (message) => { throw new MigrationError(message); };

export function migrationConfig(env, { testDatabase = false } = {}) {
  const target = env.MIGRATION_TARGET;
  if (!["staging", "production"].includes(target)) refuse("Target must be staging or production.");
  // Gate before URL parsing, driver construction, or any database work.
  if (target === "production" && env.PRODUCTION_DEPLOY_ENABLED !== "true") {
    refuse("Production migrations require PRODUCTION_DEPLOY_ENABLED=true.");
  }
  if (env.GITHUB_REF !== "refs/heads/main") refuse("Migrations require the reviewed main branch.");
  const secret = target === "staging" ? "NEON_STAGING_DATABASE_URL" : "NEON_PRODUCTION_DATABASE_URL";
  if (!env[secret]) refuse(`Missing ${secret} Environment secret; no fallback is permitted.`);
  let url;
  try { url = new URL(env[secret]); } catch { refuse("Invalid migration URL; value withheld."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash
    || (url.port && url.port !== "5432") || !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    refuse("Invalid migration endpoint; value withheld.");
  }
  if (testDatabase) {
    const agent = url.hostname === "agent-testdb" && url.username === "agent_test" && url.password === "";
    const ci = env.GITHUB_ACTIONS === "true" && env.CI === "true"
      && url.hostname === "postgres" && url.username === "postgres" && url.password === "ci";
    if ((!agent && !ci) || url.search || !/^\/web_migrate_test_[a-f0-9]+$/.test(url.pathname)) {
      refuse("Selftest requires its owned database on agent-testdb or the CI Postgres service.");
    }
  } else if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)
    || url.hostname.split(".")[0].endsWith("-pooler") || !url.username || !url.password
    || !["require", "verify-full"].includes(url.searchParams.get("sslmode"))
    || [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))) {
    refuse("Migrations require a direct Neon endpoint with TLS; value withheld.");
  }
  const bindings = url.searchParams.getAll("channel_binding");
  if (bindings.includes("require")) refuse("Required channel binding is unsupported by the migration driver.");
  if (bindings.some((value) => !["prefer", "disable"].includes(value))) refuse("Invalid channel binding option; value withheld.");
  // postgres.js forwards unknown URL options as startup settings, not libpq flags.
  url.searchParams.delete("channel_binding");
  url.port = "5432";
  return { target, url, testDatabase };
}

function journal() {
  const entries = JSON.parse(readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8")).entries;
  const migrations = readMigrationFiles({ migrationsFolder });
  const sqlFiles = readdirSync(migrationsFolder).filter((name) => name.endsWith(".sql")).sort();
  const trackedFiles = entries.map((entry) => `${entry.tag}.sql`).sort();
  if (JSON.stringify(sqlFiles) !== JSON.stringify(trackedFiles)) refuse("SQL files and migration journal differ.");
  for (const [index, entry] of entries.entries()) {
    const bootstrap = index === 0 && entry.tag === "0000_init-users"
      || index === 1 && entry.tag === "0001_agent-events";
    if (entry.idx !== index || (!bootstrap && !/^1\d{3}_[a-zA-Z0-9_-]+$/.test(entry.tag))
      || !Number.isSafeInteger(entry.when) || (index > 0 && entry.when <= entries[index - 1].when)) {
      refuse("Invalid web migration journal order or numbering.");
    }
  }
  return entries.map((entry, index) => ({ ...migrations[index], tag: entry.tag }));
}

async function pendingMigrations(client, migrations) {
  const [exists] = await client`select to_regclass(${ledger}) as ledger`;
  const applied = exists.ledger ? await client`select hash, created_at from drizzle.__drizzle_migrations order by created_at, id` : [];
  // Drizzle uses a timestamp high-water mark. Require an exact checksum prefix so
  // edited SQL, missing history, bot entries, or a newer release cannot hide work.
  for (const [index, row] of applied.entries()) {
    const migration = migrations[index];
    if (!migration || Number(row.created_at) !== migration.folderMillis || row.hash !== migration.hash) {
      refuse("Migration history is not an exact prefix of this release; coordinate with web/bot owners, do not repair automatically.");
    }
  }
  return migrations.slice(applied.length);
}

export function safeMigrationError(error) {
  if (error instanceof MigrationError) return error.message;
  // Never log driver errors: they can contain URLs, credentials, SQL or row data.
  return "Migration failed; database details withheld. Stop and investigate with the authorized database operator; do not substitute credentials.";
}

export function migrationClient(config) {
  return postgres(config.url.href, {
    port: 5432, max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10,
    password: () => decodeURIComponent(config.url.password),
    ssl: config.testDatabase ? false : { rejectUnauthorized: true },
    // Canonical migration SQL uses unqualified identifiers intending `public`.
    // postgres.js merges `connection` into the startup packet (see StartupMessage
    // in node_modules/postgres/src/connection.js), so pin per-connection GUCs
    // here: a hostile role/database `search_path` or `DateStyle` must not
    // misroute DDL or skew the PITR receipt. Never ALTER ROLE/DATABASE defaults.
    connection: { statement_timeout: 120000, lock_timeout: 10000, search_path: "public", datestyle: "ISO, YMD" },
    onnotice: () => {},
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
  const client = migrationClient(config);
  const plan = async (connection) => {
    const pending = await pendingMigrations(connection, migrations);
    await summary(`### Web migrations: ${config.target} / ${mode}`);
    await summary(`Pending: ${pending.length}${pending.length ? ` (${pending.map((entry) => entry.tag).join(", ")})` : ""}`);
    return pending;
  };
  try {
    if (mode !== "apply") {
      const pending = await plan(client);
      if (mode === "verify" && pending.length) refuse("Post-check failed: web migrations remain pending.");
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
      const [lock] = await transaction`select pg_try_advisory_xact_lock(${lockKey}) as acquired`;
      if (!lock.acquired) refuse("Another web migration holds the database lock; retry only after it finishes.");
      const pending = await plan(transaction);
      // to_char text is immune to the server DateStyle: the driver parses
      // timestamptz via `new Date(text)` (postgres/src/types.js), which swaps
      // month/day on SQL/DMY output and shifts the PITR receipt by months.
      const [clock] = await transaction`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as timestamp`;
      await summary(`Pre-migration Neon PITR timestamp (UTC): ${clock.timestamp}`);
      await summary(`Release: ${/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : "local selftest"}`);
      // Keep Drizzle's journal SQL/hash/timestamp and default ledger format, but
      // include ledger setup and history validation in the same locked transaction.
      // Source: https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/dialect.ts
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
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runMigration(process.argv[2]); }
  catch (error) { console.error(safeMigrationError(error)); process.exitCode = 1; }
}
