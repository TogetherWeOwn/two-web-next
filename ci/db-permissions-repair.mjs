import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProductionIdentity,
  migrationClient,
  migrationConnectionConfig,
  webMigrationLockKey,
} from "./db-migrate.mjs";

const readSource = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const inventory = JSON.parse(readSource("db-permissions-repair-inventory.json"));
const transferred = new Set(inventory.map(([name]) => name));
const snapshotSql = readSource("db-permissions-repair-state.sql");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ledgerDigest = "b1d91750ac74a8ad4744bb603bcae55bd23b919ecdae7621c54ff0fece4b245c";
const migrator = "two_web_migrate";
const originalOwner = /^[a-z_][a-z_0-9-]{0,62}$/;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const relation = (name) => name.split(".").map(quote).join(".");
const preservedFields = [
  "app",
  "audit",
  "dependencies",
  "ledger",
  "memberships",
  "namespaces",
  "policies",
  "roles",
];
// The protected workflow maps these codes to fixed messages and discards both
// process streams. Never encode a driver message, SQL, or catalog value here.
const failure = {
  admission: 30,
  session: 31,
  migrationLock: 32,
  snapshotLock: 33,
  catalogLocks: 34,
  writerGuard: 35,
  precondition: 36,
  mutation: 37,
  verification: 38,
  transactionEnd: 39,
  readback: 40,
  snapshotLockUnavailable: 41,
  catalogLockUnavailable: 42,
};
const defaults = [
  ["r", "TABLES", "two_web_app", ["INSERT", "SELECT", "UPDATE", "DELETE"]],
  ["r", "TABLES", "two_web_backup", ["SELECT"]],
  ["S", "SEQUENCES", "two_web_backup", ["SELECT", "USAGE"]],
];

function parsePlan(raw, digest) {
  assert.ok(raw && raw.length <= 8192 && isDigest(digest) && sha256(raw) === digest);
  const plan = JSON.parse(raw);
  assert.deepEqual(Object.keys(plan).sort(), ["after", "before", "identity", "owners"]);
  assert.ok([plan.before, plan.after, plan.identity].every(isDigest) && plan.before !== plan.after);
  assert.ok(Array.isArray(plan.owners) && plan.owners.length === inventory.length);
  const positions = new Map(inventory.map(([name], index) => [name, index]));
  for (const [index, [, , parent]] of inventory.entries()) {
    const owner = plan.owners[index];
    assert.ok(typeof owner === "string" && originalOwner.test(owner) && owner !== migrator);
    if (parent) assert.equal(owner, plan.owners[positions.get(parent)]);
  }
  return plan;
}

// Reviewed scope: the database already grants CREATE to the migrator. Only
// drizzle schema USAGE/CREATE, listed owners and public defaults change.
function statements(plan, forward) {
  const schema = ["USAGE", "CREATE"];
  const changes = inventory.flatMap(([name, kind, parent], index) =>
    parent ? [] : [[name, kind, plan.owners[index]]],
  );
  const grants = schema.map((privilege) =>
    forward
      ? `GRANT ${privilege} ON SCHEMA drizzle TO ${migrator}`
      : `REVOKE ${privilege} ON SCHEMA drizzle FROM ${migrator}`,
  );
  const alter = (objects) =>
    objects.map(
      ([name, kind, owner]) =>
        `ALTER ${kind} ${relation(name)} OWNER TO ${quote(forward ? migrator : owner)}`,
    );
  const defaultChanges = defaults.map(
    ([, kind, grantee, rights]) =>
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public ${forward ? "REVOKE" : "GRANT"} ${rights.join(", ")} ON ${kind} ${forward ? "FROM" : "TO"} ${grantee}`,
  );
  return forward
    ? [...grants, ...alter(changes), ...defaultChanges]
    : [...defaultChanges, ...alter(changes.reverse()), ...grants.reverse()];
}

async function readState(tx) {
  const [row] = await tx.unsafe(snapshotSql);
  assert.ok(row && isDigest(row.digest));
  const state = JSON.parse(row.state);
  assert.equal(state.ledger.count, 34);
  assert.equal(state.ledger.digest, ledgerDigest);
  assert.ok(isDigest(state.ledger.ids));
  return { ...state, digest: row.digest };
}

function checkInventory(state, plan, forwardState) {
  for (const [index, [name, kind, parent]] of inventory.entries()) {
    assert.deepEqual(state.inventory[name], [
      kind === "TABLE" ? "r" : "S",
      forwardState ? migrator : plan.owners[index],
      parent,
    ]);
  }
  assert.deepEqual(
    Object.keys(state.inventory).sort(),
    [...inventory.map(([name]) => name), "public.web_session_grace"].sort(),
  );
  const expectedDefaults = [
    ["S", null, "two_web_app", ["SELECT", "USAGE"]],
    ...(forwardState ? [] : defaults),
  ].flatMap(([kind, , grantee, rights]) =>
    rights.map((privilege) => `${kind}/${grantee}/${privilege}`),
  );
  const actualDefaults = state.defaults
    .filter(({ owner }) => owner === migrator)
    .map(({ schema, grantor, is_grantable, kind, grantee, privilege_type }) => {
      assert.ok(schema === "public" && grantor === migrator && is_grantable === false);
      return `${kind}/${grantee}/${privilege_type}`;
    });
  assert.deepEqual(actualDefaults.sort(), expectedDefaults.sort());
  assert.deepEqual(state.drizzle_access, [forwardState, forwardState]);
}

async function checkAuthority(tx, plan) {
  const destinations = [
    ...new Set(inventory.map(([name], index) => `${name.split(".")[0]}:${plan.owners[index]}`)),
  ];
  const [row] = await tx`select
    pg_has_role(current_user, 'two_web_migrate', 'USAGE') and
    pg_has_role(current_user, 'two_web_migrate', 'SET') and
    has_schema_privilege(current_user, 'drizzle', 'USAGE WITH GRANT OPTION') and
    has_schema_privilege(current_user, 'drizzle', 'CREATE WITH GRANT OPTION') and
    has_schema_privilege('two_web_migrate', 'public', 'CREATE') and
    has_database_privilege('two_web_migrate', current_database(), 'CREATE') and
    (
      select bool_and(
        pg_has_role(current_user, owner, 'USAGE') and pg_has_role(current_user, owner, 'SET') and
        has_schema_privilege(owner, namespace, 'CREATE')
      )
      from (
        select split_part(destination, ':', 1) namespace, split_part(destination, ':', 2) owner
        from jsonb_array_elements_text(${JSON.stringify(destinations)}::text::jsonb) as d(destination)
      ) as scope
    ) as authorized`;
  assert.equal(row.authorized, true);
}

async function awaitWriterGuard(tx) {
  // A short unrelated writer may finish while the snapshot drain is held.
  // Sustained writers still refuse the repair before any mutation.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await tx`select pg_sleep(0.25)`;
    // GRANT can release catalog locks before committing, but keeps its transaction lock.
    const [{ clear }] = await tx`select not exists (
      select from pg_locks l left join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted
        and (a.datname is null or a.datname = current_database())) as clear`;
    if (clear) return;
  }
  assert.fail("A database writer is active");
}

async function executeRepair(tx, config, plan, direction, enterPhase) {
  await tx`set local search_path = pg_catalog`;
  await tx`set local lock_timeout = '2s'`;
  await tx`set local statement_timeout = '15s'`;
  await tx`set local transaction_timeout = '30s'`;
  await assertProductionIdentity(tx, config);
  if (direction === "readback") {
    enterPhase(failure.readback);
    const state = await readState(tx);
    if (state.digest === plan.before) return "before";
    if (state.digest === plan.after) return "after";
    throw new Error("Unclassified repair state");
  }

  enterPhase(failure.migrationLock);
  const [{ acquired }] =
    await tx`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
  assert.equal(acquired, true);
  // Drain snapshot mutations before the guard in both directions. EXCLUSIVE
  // conflicts with row writes and SELECT FOR UPDATE, while admitting plain
  // reads. The transaction releases the drain on both commit and rollback.
  enterPhase(failure.snapshotLock);
  await tx`lock table public.discord_event_snapshots in exclusive mode`;
  // Keep the ledger stable and block concurrent GRANTs, which lock catalogs directly.
  enterPhase(failure.catalogLocks);
  await tx`lock table drizzle.__drizzle_migrations, pg_catalog.pg_class, pg_catalog.pg_attribute in share row exclusive mode nowait`;
  enterPhase(failure.writerGuard);
  await awaitWriterGuard(tx);
  enterPhase(failure.precondition);
  const forward = direction === "forward";
  const initial = await readState(tx);
  assert.equal(initial.digest, forward ? plan.before : plan.after);
  checkInventory(initial, plan, !forward);
  if (forward) {
    // PostgreSQL can merge an explicit ACL edge with the rewritten owner edge.
    assert.ok(
      !initial.object_acl.some(
        ({ name, grantee, grantor }) =>
          transferred.has(name) && (grantee === migrator || grantor === migrator),
      ),
      "Migrator ACL overlaps ownership transfer",
    );
  }
  await checkAuthority(tx, plan);

  enterPhase(failure.mutation);
  for (const statement of statements(plan, forward)) {
    await tx.unsafe(statement);
  }

  enterPhase(failure.verification);
  const final = await readState(tx);
  assert.equal(final.digest, forward ? plan.after : plan.before);
  checkInventory(final, plan, forward);
  for (const field of preservedFields) assert.deepEqual(final[field], initial[field]);
  assert.equal(forward ? final.migrator_ready : initial.migrator_ready, true);
  return "committed";
}

class RepairCloseError extends Error {
  constructor(outcome) {
    super("Database permissions connection cleanup failed after an acknowledged outcome.");
    this.outcome = outcome;
  }
}

export async function runRepair(direction, env, connect = migrationClient, enterPhase = () => {}) {
  assert.ok(["forward", "undo", "readback"].includes(direction));
  const plan = parsePlan(env.PRODUCTION_DB_REPAIR_PLAN, env.PRODUCTION_DB_REPAIR_PLAN_SHA256);
  const config = migrationConnectionConfig(
    { PRODUCTION_DATABASE_URL: env.PRODUCTION_DB_REPAIR_DATABASE_URL },
    "production",
    plan.identity,
  );
  assert.equal(config.url.pathname, "/postgres");
  const readOnly = direction === "readback";
  enterPhase(failure.session);
  const client = connect(config, { readOnly });
  let outcome;
  let closeFailed = false;
  try {
    outcome = await client.begin(
      readOnly ? "isolation level repeatable read read only" : "isolation level read committed",
      async (tx) => {
        const result = await executeRepair(tx, config, plan, direction, enterPhase);
        enterPhase(failure.transactionEnd);
        return result;
      },
    );
  } finally {
    try {
      await client.end({ timeout: 5 });
    } catch {
      closeFailed = true;
    }
  }
  // Only reached when begin() acknowledged the outcome.
  if (closeFailed) throw new RepairCloseError(outcome);
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let phase = failure.admission;
  try {
    // Exit codes convey only fixed states. The workflow suppresses both streams.
    const result = await runRepair(process.argv[2], process.env, migrationClient, (current) => {
      phase = current;
    });
    process.exitCode = { committed: 0, before: 10, after: 11 }[result] ?? 1;
  } catch (error) {
    // Cleanup failure stays non-success even with an acknowledged outcome.
    if (error instanceof RepairCloseError) {
      process.exitCode = { committed: 12, before: 13, after: 14 }[error.outcome] ?? 1;
    } else if (error?.code === "55P03" && phase === failure.snapshotLock) {
      process.exitCode = failure.snapshotLockUnavailable;
    } else if (error?.code === "55P03" && phase === failure.catalogLocks) {
      process.exitCode = failure.catalogLockUnavailable;
    } else {
      process.exitCode = phase;
    }
  }
}
