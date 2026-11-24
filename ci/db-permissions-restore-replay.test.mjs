import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PLANETSCALE_PRODUCTION_BRANCH_ID, PLANETSCALE_PRODUCTION_HOST } from "./db-migrate.mjs";
import { runRepair } from "./db-permissions-repair.mjs";
import { runExecutorAuthority } from "./db-repair-executor.mjs";
import { bootstrap, fixtureCluster, newPassword } from "./fixtures/db-restore-replay/cluster.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const hash = (input) => createHash("sha256").update(input).digest("hex");
const inventory = JSON.parse(read("db-permissions-repair-inventory.json"));
const snapshotSql = read("db-permissions-repair-state.sql");
const [app, backup, migrator] = ["two_web_app", "two_web_backup", "two_web_migrate"];
const webRoles = [app, backup, migrator];
const executor = "fixture_executor";
const otherOwner = "fixture_other";
const provisioner = "fixture_provisioner";
const customer = "fixture_customer";
const bot = "fixture_bot";
const botReader = "fixture_bot_reader";
const botTables = [
  "event_store",
  "events",
  "guild_members",
  "guild_settings",
  "members",
  "scheduled_events",
];
const names = [...webRoles, executor, otherOwner, provisioner, customer, bot, botReader];
const MISSING_EDGE = [true, false, false];
const owners = inventory.map(([name]) =>
  name === "public.agent_event_grants" ? otherOwner : executor,
);

async function using(sql, work) {
  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function denies(query, code = "42501") {
  await assert.rejects(query, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

// DDL requires a literal. Passwords are run-generated hex and never passed
// through an assertion, subprocess argument, or unsanitized error.
const setPassword = (sql, role, password) =>
  sql`alter role ${sql(role)} password ${sql.unsafe(`'${password}'`)}`;

async function grantAdmin(sql, member, grantor) {
  for (const role of webRoles) {
    await sql`grant ${sql(role)} to ${sql(member)}
      with admin true, inherit false, set false granted by ${sql(grantor)}`;
  }
}

async function seed(cluster, sourcePasswords, source) {
  const credentials = Object.fromEntries(
    names.map((name) => [name, sourcePasswords[name] ?? newPassword()]),
  );
  await using(cluster.admin(), async (sql) => {
    const [{ major }] =
      await sql`select current_setting('server_version_num')::int / 10000 as major`;
    assert.equal(major, 18);
    for (const role of names) {
      // The clone keeps LOGIN. Its retained Web roles start with no password
      // and no incoming grants.
      await sql`create role ${sql(role)} login`;
      if (source || !webRoles.includes(role)) await setPassword(sql, role, credentials[role]);
    }
    await sql
      .unsafe(`
      alter role fixture_provisioner createrole;
      alter role fixture_customer nosuperuser createdb createrole inherit replication bypassrls;
      grant pg_read_all_data, pg_write_all_data, pg_read_all_settings, pg_read_all_stats,
        pg_stat_scan_tables, pg_monitor, pg_signal_backend, pg_checkpoint, pg_maintain,
        pg_use_reserved_connections, pg_create_subscription to fixture_customer;
      grant fixture_other, pg_maintain, pg_read_all_stats, pg_read_all_data to fixture_executor;
      create schema drizzle authorization fixture_executor;
      grant create on database postgres to two_web_migrate;
      grant usage, create on schema public to fixture_executor, fixture_other, two_web_migrate;
      grant usage on schema drizzle to two_web_app;
      create table public.web_session_grace (id int);
      create table drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint);
      alter table drizzle.__drizzle_migrations owner to fixture_executor;
      grant select on drizzle.__drizzle_migrations to two_web_app;
      alter default privileges for role two_web_migrate in schema public
        grant select, insert, update, delete on tables to two_web_app;
      alter default privileges for role two_web_migrate in schema public
        grant select, usage on sequences to two_web_app;
      alter default privileges for role two_web_migrate in schema public
        grant select on tables to two_web_backup;
      alter default privileges for role two_web_migrate in schema public
        grant select, usage on sequences to two_web_backup;
    `)
      .simple();
    const serialParents = new Set(inventory.map(([, , parent]) => parent));
    for (const [index, [name, kind]] of inventory.entries()) {
      if (kind !== "TABLE" || name.startsWith("drizzle.")) continue;
      const type = serialParents.has(name) ? "serial" : "int";
      await sql`create table ${sql(name)} (id ${sql.unsafe(type)} primary key)`;
      await sql`alter table ${sql(name)} owner to ${sql(owners[index])}`;
    }
    const { entries } = JSON.parse(read("../drizzle/meta/_journal.json"));
    assert.equal(entries[33].tag.split("_")[0], "1033");
    const ledger = entries.slice(0, 34).map(({ when, tag }) => ({
      created_at: when,
      hash: hash(read(`../drizzle/${tag}.sql`)),
    }));
    await sql`insert into drizzle.__drizzle_migrations ${sql(ledger, "hash", "created_at")}`;
    await sql
      .unsafe(`
      insert into public.events (id) values (1), (2);
      insert into public.rsvps (id) values (1);
      insert into public.queue_jobs (id) values (1);
      grant select, insert, update, delete on public.events, public.rsvps, public.queue_jobs to two_web_app;
      grant select on public.events, public.rsvps to two_web_backup;
      grant usage, select on sequence public.events_id_seq to two_web_backup;
      grant select (id) on public.web_session_grace to two_web_backup;
      create function public.fixture_audit() returns trigger language plpgsql
        as $$begin return new; end$$;
      create trigger fixture_audit before update on public.activity_log
        for each row execute function public.fixture_audit();
    `)
      .simple();
    await sql`create database two_bot`;
    if (source) await grantAdmin(sql, provisioner, bootstrap);
  });
  await using(cluster.admin("two_bot"), async (sql) => {
    for (const table of botTables) {
      const name = sql(`public.${table}`);
      await sql`create table ${name} (id int primary key)`;
      await sql`insert into ${name} values (1), (2)`;
      await sql`grant select on ${name} to ${sql(bot)}`;
    }
    await sql
      .unsafe(`
      create schema web_v1;
      create view web_v1.live_counts as select count(*)::int as count from public.events;
      create view web_v1.rank_counts as select count(*)::int as count from public.members;
      grant usage on schema web_v1 to fixture_bot_reader;
      grant select on web_v1.live_counts, web_v1.rank_counts to fixture_bot_reader;
    `)
      .simple();
  });
  return (role, database) => cluster.connect(role, credentials[role], database);
}

async function roleCatalog(sql) {
  const roles = await sql`select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
    rolcanlogin, rolreplication, rolbypassrls from pg_roles order by rolname`;
  const edges = (
    await sql`select jsonb_build_array(r.rolname, m.rolname, g.rolname,
      admin_option, inherit_option, set_option) as edge
    from pg_auth_members
    join pg_roles r on roleid = r.oid
    join pg_roles m on member = m.oid
    join pg_roles g on grantor = g.oid
    order by r.rolname, m.rolname, g.rolname`
  ).map(({ edge }) => edge);
  const authority = (
    await sql`select jsonb_build_array(p.rolname, r.rolname,
      pg_has_role(p.oid, r.oid, 'MEMBER'), pg_has_role(p.oid, r.oid, 'USAGE'),
      pg_has_role(p.oid, r.oid, 'SET'), pg_has_role(p.oid, r.oid, 'MEMBER WITH ADMIN OPTION')) as rights
    from pg_roles p cross join pg_roles r
    where p.rolname = any(${names}::text[])
    order by p.rolname, r.rolname`
  ).map(({ rights }) => rights);
  return { roles, edges, authority };
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
  return using(connect(role, database), (sql) =>
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
      assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
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
    assert.deepEqual(await tx`select id from public.events order by id`, [{ id: 1 }, { id: 2 }]);
    const [row] =
      await tx`select has_table_privilege(current_user, 'public.events', 'INSERT') as writes`;
    assert.equal(row.writes, false);
  });
  await readAs(connect, migrator, "postgres", async (tx) => {
    if (repaired) {
      assert.deepEqual(await tx`select count(*)::int as count from drizzle.__drizzle_migrations`, [
        { count: 34 },
      ]);
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
    const readSource = () => using(source.admin(), roleCatalog);
    const readRestore = () => using(restore.admin(), roleCatalog);
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
    await using(connect(customer), (sql) => denies(grantAdmin(sql, provisioner, customer)));
    await using(connect(provisioner), async (sql) => {
      for (const role of webRoles) await denies(setPassword(sql, role, newPassword()));
    });
    await assert.rejects(runAuthority(connect, "provision"), /approved scope/);
    for (const role of webRoles) {
      await using(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
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
    await using(restore.admin(), (sql) => grantAdmin(sql, customer, bootstrap));
    await using(connect(customer), async (sql) => {
      await denies(sql`grant two_web_app to fixture_provisioner
        with admin true, inherit false, set false granted by fixture_bootstrap`);
      await grantAdmin(sql, provisioner, customer);
    });
    // Change passwords as the re-authorized provisioner, using the random
    // password each connection will actually present to the SCRAM listener.
    const webPasswords = Object.fromEntries(webRoles.map((role) => [role, newPassword()]));
    await using(connect(provisioner), async (sql) => {
      for (const role of webRoles) await setPassword(sql, role, webPasswords[role]);
    });
    const fresh = (role, database) =>
      webPasswords[role]
        ? restore.connect(role, webPasswords[role], database)
        : connect(role, database);
    for (const role of webRoles) {
      await using(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
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
    const expected = await using(connect(executor), expectedForward);
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

    phase = "forward and revoke while retaining repaired state";
    await runAuthority(connect, "provision");
    assert.equal(await repair("forward"), "committed");
    await runAuthority(connect, "revoke");
    const { state: repaired } = await inspect(connect);
    assert.deepEqual(repaired, { ...expected.state, memberships: unprovisioned.state.memberships });
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
