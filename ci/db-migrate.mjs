import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { assertMigrationAdmission } from "./migration-admission.mjs";
import { OwnershipRefusal, assertMigratorOwnership } from "./migration-ownership.mjs";
import {
  DefaultAclRefusal,
  assertRuntimeDefaultAcl,
  assertRuntimeLedgerAcl,
} from "./migration-runtime-rights.mjs";

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
  const identity = target === "production" ? env.PRODUCTION_MIGRATION_IDENTITY_SHA256 : undefined;
  if (target === "production" && !/^[a-f0-9]{64}$/.test(identity ?? ""))
    refuse("Production migration identity setting is missing or malformed.");
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
    (url.hostname !== PLANETSCALE_PRODUCTION_HOST ||
      branchIdOf(url.username) !== PLANETSCALE_PRODUCTION_BRANCH_ID)
  ) {
    refuse("Migrations require the pinned direct production PlanetScale endpoint; value withheld.");
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
  return { target, url, testDatabase, identity };
}

export async function assertProductionIdentity(connection, config, summary) {
  if (config.target !== "production") return;
  const [actual] = await connection`select pg_catalog.current_database()::text as database,
    session_user::text as authenticated, current_user::text as effective`;
  // Fingerprint the approved database and role, rather than putting either
  // name in Actions step metadata. PostgreSQL identifiers cannot contain NUL.
  if (
    !actual ||
    actual.database !== config.url.pathname.slice(1) ||
    !actual.authenticated ||
    actual.authenticated !== actual.effective ||
    createHash("sha256").update(`${actual.database}\0${actual.authenticated}`).digest("hex") !==
      config.identity
  ) {
    refuse("Production migration database or role identity did not match; values withheld.");
  }
  await summary("Production migration database and role identity matched.");
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

function approvedRange(migrations, pin) {
  const tags = typeof pin === "string" ? pin.split(",") : [];
  const start = migrations.findIndex((entry) => entry.tag === tags[0]);
  const end = start + tags.length;
  if (start < 0 || tags.some((tag, index) => migrations[start + index]?.tag !== tag)) {
    refuse(
      "Production migration scope must pin an exact contiguous segment of the release journal.",
    );
  }
  return { start, end };
}

export async function runMigration(mode, env = process.env, options = {}) {
  if (!["plan", "apply", "verify", "verify-scope"].includes(mode))
    refuse("Mode must be plan, apply, verify or verify-scope.");
  const config = migrationConfig(env, options);
  const migrations = journal();
  const scope =
    config.target === "production"
      ? approvedRange(migrations, env.PRODUCTION_MIGRATION_APPROVED_PENDING_TAGS)
      : undefined;
  if (mode === "verify-scope" && !scope) refuse("Scoped readback is production-only.");
  const report = options.report ?? console.log;
  const summary = async (text) => {
    await report(text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  const postCheck = (remaining, approvedEnd) => {
    if (approvedEnd === undefined) {
      if (remaining.length) refuse("Post-check failed: web migrations remain pending.");
      return;
    }
    // pendingMigrations validated every row against the full canonical journal.
    // Its tail length identifies the exact prefix, not just tag membership.
    const prefix = migrations.length - remaining.length;
    if (prefix < approvedEnd)
      refuse("Scoped post-check failed: ledger has not reached the approved end.");
    if (prefix > approvedEnd)
      refuse("Scoped post-check failed: ledger has advanced past the approved end.");
  };
  const reportPostCheck = async (remaining) => {
    if (!scope) {
      await summary("Post-check: zero pending web migrations.");
      return;
    }
    const endTag = migrations[scope.end - 1].tag;
    await summary(
      `Scoped ${mode === "apply" ? "apply" : "readback"}: ledger matches the approved end (${endTag}).`,
    );
    const deferred = remaining.map((entry) => entry.tag).join(", ");
    await summary(`Deferred web migrations: ${deferred || "none"}.`);
    if (remaining.length) await summary("This is not full-release migration verification.");
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
    // Same surfacing rule as the default-ACL guard: a reviewed object the
    // migrator cannot ALTER (owned by a role it does not inherit) must
    // refuse here, named, instead of failing inside the apply transaction
    // behind the masked driver message. plan() also runs under the apply
    // lock before any DDL, so apply stays covered without a second call.
    try {
      await assertMigratorOwnership(connection);
    } catch (error) {
      if (error instanceof OwnershipRefusal) refuse(error.message);
      throw error;
    }
    const pending = await pendingMigrations(connection, migrations);
    if (mode === "verify-scope") return pending;
    let selected = pending;
    if (scope && mode !== "verify") {
      if (migrations.length - pending.length !== scope.start) {
        refuse("Production migration pending tags do not match the approved scope.");
      }
      selected = pending.slice(0, scope.end - scope.start);
    }
    const tags = selected.map((entry) => entry.tag);
    const label = selected === pending ? "Pending" : "Pending in approved scope";
    await summary(`### Web migrations: ${config.target} / ${mode}`);
    await summary(`${label}: ${tags.length}${tags.length ? ` (${tags.join(", ")})` : ""}`);
    return selected;
  };
  try {
    if (mode !== "apply") {
      // In production, a dropped connection must not resume on a new session
      // after the identity check, even for a read-only plan or verification.
      const pending =
        config.target === "production"
          ? await client.begin("read only", async (transaction) => {
              await assertProductionIdentity(transaction, config, summary);
              const pending = await plan(transaction);
              if (mode === "verify-scope") postCheck(pending, scope.end);
              return pending;
            })
          : await plan(client);
      if (mode === "verify") postCheck(pending);
      if (mode === "verify-scope") await reportPostCheck(pending);
      return pending;
    }
    // sql.begin pins one connection and rejects on loss: never resume unlocked.
    // Sources: https://github.com/porsager/postgres#transactions
    // https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS
    const apply = async (transaction) => {
      await assertProductionIdentity(transaction, config, summary);
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
      // A default ACL that fired on this bootstrap (or an older exposed
      // ledger) must roll the whole transaction back before any migration
      // statement runs. Surface only the intentional refusal, as in plan.
      try {
        await assertRuntimeLedgerAcl(transaction);
      } catch (error) {
        if (error instanceof DefaultAclRefusal) refuse(error.message);
        throw error;
      }
      for (const migration of pending) {
        for (const statement of migration.sql) await transaction.unsafe(statement);
        await transaction`insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${migration.hash}, ${migration.folderMillis})`;
      }
      const remaining = await pendingMigrations(transaction, migrations);
      postCheck(remaining, scope?.end);
      return remaining;
    };
    // The locked production scope check must see commits made after the
    // identity read, even when the role or database defaults to a fixed snapshot.
    const remaining =
      config.target === "production"
        ? await client.begin("isolation level read committed", apply)
        : await client.begin(apply);
    await reportPostCheck(remaining);
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
    if (!settled) console.error(safeMigrationError(error));
    process.exitCode = 1;
  } finally {
    settled = true;
  }
}
