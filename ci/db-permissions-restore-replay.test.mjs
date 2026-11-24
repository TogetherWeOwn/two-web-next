import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PLANETSCALE_PRODUCTION_BRANCH_ID, PLANETSCALE_PRODUCTION_HOST } from "./db-migrate.mjs";
import { runRepair } from "./db-permissions-repair.mjs";
import { runExecutorAuthority } from "./db-repair-executor.mjs";
import {
  bootstrap,
  fixtureCluster,
  newPassword,
  withClient,
} from "./fixtures/db-restore-replay/cluster.mjs";
import {
  app,
  backup,
  bot,
  botReader,
  botTables,
  customer,
  executor,
  grantAdmin,
  inventory,
  migrator,
  owners,
  provisioner,
  roleCatalog,
  seed,
  setPassword,
  webRoles,
} from "./fixtures/db-restore-replay/seed.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const hash = (input) => createHash("sha256").update(input).digest("hex");
const snapshotSql = read("db-permissions-repair-state.sql");
const MISSING_EDGE = [true, false, false];

async function denies(query, code = "42501") {
  await assert.rejects(query, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function changes(before, after, removed, added) {
  const encoded = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  const difference = (left, right) => {
    const other = new Set(encoded(right));
    return encoded(left).filter((row) => !other.has(row));
  };
  assert.deepEqual(difference(before, after), encoded(removed));
  assert.deepEqual(difference(after, before), encoded(added));
}

async function readAs(connect, role, database, readRows) {
  return withClient(connect(role, database), (sql) =>
    sql.begin("read only", async (tx) => {
      const [identity] =
        await tx`select session_user::text as login, current_user::text as effective,
        current_database()::text as database`;
      assert.deepEqual(identity, { login: role, effective: role, database });
      return readRows(tx);
    }),
  );
}

async function botReads(connect) {
  await readAs(connect, bot, "two_bot", async (tx) => {
    for (const table of botTables) {
      const rows = await tx`select id from ${tx(`public.${table}`)} order by id`;
      assert.deepEqual(
        rows.map(({ id }) => id),
        [1, 2],
      );
    }
  });
  await readAs(connect, botReader, "two_bot", async (tx) => {
    const [row] = await tx`select
      (select count from web_v1.live_counts) as live,
      (select count from web_v1.rank_counts) as ranks,
      exists (select from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
        and has_table_privilege(current_user, c.oid, 'SELECT')) as base_read`;
    assert.deepEqual(row, { live: 2, ranks: 2, base_read: false });
    await denies(tx.savepoint((sp) => sp`select id from public.events`));
  });
}

async function webReads(connect, repaired) {
  await readAs(connect, app, "postgres", async (tx) => {
    const [counts] = await tx`select (select count(*)::int from public.events) as events,
      (select count(*)::int from public.rsvps) as rsvps, (select count(*)::int from public.queue_jobs) as jobs,
      (select count(*)::int from drizzle.__drizzle_migrations) as ledger`;
    assert.deepEqual(counts, { events: 2, rsvps: 1, jobs: 1, ledger: 34 });
  });
  await readAs(connect, backup, "postgres", async (tx) => {
    const rows = await tx`select id from public.events order by id`;
    assert.deepEqual(
      rows.map(({ id }) => id),
      [1, 2],
    );
    const [row] =
      await tx`select has_table_privilege(current_user, 'public.events', 'INSERT') as writes`;
    assert.equal(row.writes, false);
  });
  await readAs(connect, migrator, "postgres", async (tx) => {
    if (repaired) {
      const [{ count }] = await tx`select count(*)::int as count from drizzle.__drizzle_migrations`;
      assert.equal(count, 34);
    } else {
      await denies(tx.savepoint((sp) => sp`select id from drizzle.__drizzle_migrations`));
    }
  });
}

async function observeRepair(tx) {
  const [{ digest, state }] = await tx.unsafe(snapshotSql);
  return { digest, state: JSON.parse(state) };
}

const inspect = (connect) =>
  readAs(connect, executor, "postgres", async (tx) => {
    await tx`set local search_path = pg_catalog`;
    return observeRepair(tx);
  });

function namedRepairScope({ state }) {
  const {
    inventory,
    schema_db_acl,
    object_acl,
    defaults,
    app,
    ledger,
    drizzle_access,
    migrator_ready,
  } = state;
  return {
    inventory,
    schema_db_acl,
    object_acl,
    defaults,
    app,
    ledger,
    drizzle_access,
    migrator_ready,
  };
}

async function expectedForward(sql) {
  const rollback = new Error("discard expected catalog");
  let observed;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`set local search_path = pg_catalog`;
      await tx`grant usage, create on schema drizzle to two_web_migrate`;
      for (const [name, type, parent] of inventory) {
        if (!parent) await tx`alter ${tx.unsafe(type)} ${tx(name)} owner to two_web_migrate`;
      }
      await tx
        .unsafe(`
      alter default privileges for role two_web_migrate in schema public
        revoke select, insert, update, delete on tables from two_web_app;
      alter default privileges for role two_web_migrate in schema public
        revoke select on tables from two_web_backup;
      alter default privileges for role two_web_migrate in schema public
        revoke select, usage on sequences from two_web_backup;
    `)
        .simple();
      observed = await observeRepair(tx);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  return observed;
}

// The real runner validates its normal plan/identity. Only the injected
// connector redirects it to a fresh, authenticated session on the Unix socket.
const planUrl = `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:synthetic@${PLANETSCALE_PRODUCTION_HOST}/postgres?sslmode=verify-full`;
const identity = (role) => hash(`postgres\0${role}`);
const runAuthority = (connect, operation) => {
  const plan = JSON.stringify({ operation, executor, identity: identity(provisioner) });
  return runExecutorAuthority(
    operation,
    {
      PRODUCTION_DB_EXECUTOR_PLAN: plan,
      PRODUCTION_DB_EXECUTOR_PLAN_SHA256: hash(plan),
      PRODUCTION_DB_EXECUTOR_DATABASE_URL: planUrl,
    },
    () => connect(provisioner),
  );
};
const run = (connect, direction, before, after) => {
  const plan = JSON.stringify({ before, after, owners, identity: identity(executor) });
  return runRepair(
    direction,
    {
      PRODUCTION_DB_REPAIR_PLAN: plan,
      PRODUCTION_DB_REPAIR_PLAN_SHA256: hash(plan),
      PRODUCTION_DB_REPAIR_DATABASE_URL: planUrl,
    },
    () => connect(executor),
  );
};

test("PostgreSQL 18 branch replay preserves repair and Bot scope with alternate ADMIN authority", async (t) => {
  const directory = mkdtempSync("/tmp/two-web-replay-");
  const clusters = [];
  t.after(() => {
    for (const cluster of clusters.reverse()) cluster.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  let phase = "synthetic source and restore setup";
  try {
    const source = fixtureCluster(join(directory, "source"));
    clusters.push(source);
    const restore = fixtureCluster(join(directory, "restore"));
    clusters.push(restore);
    const sourcePasswords = Object.fromEntries(webRoles.map((role) => [role, newPassword()]));
    const sourceConnect = await seed(source, sourcePasswords, true);
    const connect = await seed(restore, sourcePasswords, false);
    const readSource = () => withClient(source.admin(), roleCatalog);
    const readRestore = () => withClient(restore.admin(), roleCatalog);
    const original = await readSource();
    const originalRepairState = await inspect(sourceConnect);
    const incoming = webRoles.map((role) => [role, provisioner, bootstrap, ...MISSING_EDGE]);
    await webReads(sourceConnect, false);
    await botReads(sourceConnect);

    phase = "deny without ADMIN on retained Web roles";
    const missing = await readRestore();
    assert.deepEqual(missing.roles, original.roles);
    changes(original.edges, missing.edges, incoming, []);
    changes(
      original.authority,
      missing.authority,
      webRoles.map((role) => [provisioner, role, true, false, false, true]),
      webRoles.map((role) => [provisioner, role, false, false, false, false]),
    );
    assert.ok(!missing.edges.some(([role]) => webRoles.includes(role)));
    await botReads(connect);
    await withClient(connect(customer), (sql) => denies(grantAdmin(sql, provisioner, customer)));
    await withClient(connect(provisioner), async (sql) => {
      for (const role of webRoles) await denies(setPassword(sql, role, newPassword()));
    });
    await assert.rejects(runAuthority(connect, "provision"), /approved scope/);
    for (const role of webRoles) {
      await withClient(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
    }
    assert.deepEqual(await readRestore(), missing);
    assert.deepEqual(
      namedRepairScope(await inspect(connect)),
      namedRepairScope(originalRepairState),
    );
    t.diagnostic(
      "Three incoming edges missing. Customer replay, password rotation and provisioning denied.",
    );

    phase = "alternate replay and fresh Web credentials";
    // Fixture premise: the bootstrap user seeds three ADMIN-only edges on the
    // customer in this cluster. PlanetScale documents CREATEROLE and built-in
    // role privileges but no way to acquire these edges on retained custom roles.
    await withClient(restore.admin(), (sql) => grantAdmin(sql, customer, bootstrap));
    await withClient(connect(customer), async (sql) => {
      await denies(sql`grant two_web_app to fixture_provisioner
        with admin true, inherit false, set false granted by fixture_bootstrap`);
      await grantAdmin(sql, provisioner, customer);
    });
    // The re-authorized provisioner assigns the random passwords that the
    // fresh connections will present to the SCRAM listener.
    const webPasswords = Object.fromEntries(webRoles.map((role) => [role, newPassword()]));
    await withClient(connect(provisioner), async (sql) => {
      for (const role of webRoles) await setPassword(sql, role, webPasswords[role]);
    });
    const fresh = (role, database) =>
      webPasswords[role]
        ? restore.connect(role, webPasswords[role], database)
        : connect(role, database);
    for (const role of webRoles) {
      await withClient(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
    }
    const replayed = await readRestore();
    assert.deepEqual(replayed.roles, original.roles);
    changes(
      original.edges,
      replayed.edges,
      incoming,
      webRoles.flatMap((role) => [
        [role, customer, bootstrap, ...MISSING_EDGE],
        [role, provisioner, customer, ...MISSING_EDGE],
      ]),
    );
    changes(
      original.authority,
      replayed.authority,
      webRoles.map((role) => [customer, role, false, false, false, false]),
      webRoles.map((role) => [customer, role, true, false, false, true]),
    );
    assert.deepEqual(await readSource(), original);
    await webReads(fresh, false);
    t.diagnostic(
      "Seeded ADMIN permits alternate replay and fresh SCRAM logins. The original grantor is still denied.",
    );

    phase = "forward, exact undo and revoke";
    const unprovisioned = await inspect(connect);
    assert.deepEqual(namedRepairScope(unprovisioned), namedRepairScope(originalRepairState));
    await runAuthority(connect, "provision");
    const { digest: before } = await inspect(connect);
    const expected = await withClient(connect(executor), expectedForward);
    const repair = (direction) => run(connect, direction, before, expected.digest);
    assert.equal(await repair("readback"), "before");
    assert.equal(await repair("forward"), "committed");
    assert.equal(await repair("readback"), "after");
    await webReads(fresh, true);
    await botReads(connect);
    assert.equal(await repair("undo"), "committed");
    assert.equal(await repair("readback"), "before");
    await runAuthority(connect, "revoke");
    assert.deepEqual(await inspect(connect), unprovisioned);
    assert.deepEqual(await readRestore(), replayed);
    await webReads(fresh, false);
    await botReads(connect);
    t.diagnostic(
      "Exact undo restored the original digest and the first revoke removed temporary authority.",
    );

    phase = "forward and revoke while retaining repaired state";
    await runAuthority(connect, "provision");
    // The second provision creates a new pg_auth_members OID, which the
    // unchanged repair includes in its digest. Pin this attempt separately.
    const reprovisioned = await inspect(connect);
    assert.notEqual(reprovisioned.digest, before);
    const retained = await withClient(connect(executor), expectedForward);
    assert.equal(await run(connect, "forward", reprovisioned.digest, retained.digest), "committed");
    await runAuthority(connect, "revoke");
    const { state: repaired } = await inspect(connect);
    assert.deepEqual(repaired, { ...retained.state, memberships: unprovisioned.state.memberships });
    assert.deepEqual(await readRestore(), replayed);
    await webReads(fresh, true);
    await botReads(connect);
    assert.deepEqual(await readSource(), original);
    assert.deepEqual(await inspect(sourceConnect), originalRepairState);
    await botReads(sourceConnect);
    t.diagnostic(
      "Forward, exact undo, both revocations, scoped catalog and Bot read parity passed.",
    );
  } catch (error) {
    // PostgreSQL errors can include the failed statement, including ALTER ROLE.
    if (error.code === "ERR_ASSERTION") throw error;
    throw new Error(`${phase} failed${error.code ? ` (SQLSTATE ${error.code})` : ""}`);
  }
});
