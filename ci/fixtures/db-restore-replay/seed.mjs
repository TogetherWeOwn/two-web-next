import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bootstrap, newPassword, withClient } from "./cluster.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
export const inventory = JSON.parse(read("../../db-permissions-repair-inventory.json"));
export const [app, backup, migrator] = ["two_web_app", "two_web_backup", "two_web_migrate"];
export const webRoles = [app, backup, migrator];
export const executor = "fixture_executor";
const otherOwner = "fixture_other";
export const provisioner = "fixture_provisioner";
export const customer = "fixture_customer";
export const bot = "fixture_bot";
export const botReader = "fixture_bot_reader";
export const botTables = [
  "event_store",
  "events",
  "guild_members",
  "guild_settings",
  "members",
  "scheduled_events",
];
const names = [...webRoles, executor, otherOwner, provisioner, customer, bot, botReader];
export const owners = inventory.map(([name]) =>
  name === "public.agent_event_grants" ? otherOwner : executor,
);

// DDL requires a literal. Passwords are run-generated hex and never passed
// through an assertion, subprocess argument, or unsanitized error.
export const setPassword = (sql, role, password) =>
  sql`alter role ${sql(role)} password ${sql.unsafe(`'${password}'`)}`;

export async function grantAdmin(sql, member, grantor) {
  for (const role of webRoles) {
    await sql`grant ${sql(role)} to ${sql(member)}
      with admin true, inherit false, set false granted by ${sql(grantor)}`;
  }
}

export async function seed(cluster, sourcePasswords, source) {
  const credentials = Object.fromEntries(
    names.map((name) => [name, sourcePasswords[name] ?? newPassword()]),
  );
  await withClient(cluster.admin(), async (sql) => {
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
        pg_use_reserved_connections, pg_create_subscription to fixture_customer with admin true;
      -- Existing executor authority assumed by the reviewed repair. This
      -- covers the legacy owner, catalog locks, writer check and readback.
      grant fixture_other, pg_maintain, pg_read_all_stats, pg_read_all_data to fixture_executor;
      create schema drizzle authorization fixture_executor;
      grant create on database postgres to two_web_migrate;
      grant usage, create on schema public to fixture_executor, fixture_other, two_web_migrate;
      grant usage on schema drizzle to two_web_app;
      create table public.web_session_grace (id int);
      alter table public.web_session_grace owner to two_web_migrate;
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
    const { entries } = JSON.parse(read("../../../drizzle/meta/_journal.json"));
    assert.equal(entries[33].tag.split("_")[0], "1033");
    const ledger = entries.slice(0, 34).map(({ when, tag }) => ({
      created_at: when,
      hash: createHash("sha256")
        .update(read(`../../../drizzle/${tag}.sql`))
        .digest("hex"),
    }));
    await sql`insert into drizzle.__drizzle_migrations ${sql(ledger, "hash", "created_at")}`;
    await sql
      .unsafe(`
      insert into public.events (id) values (1), (2);
      insert into public.rsvps (id) values (1);
      insert into public.queue_jobs (id) values (1);
      alter table public.agent_event_grants add column updated_at timestamptz;
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
  await withClient(cluster.admin("two_bot"), async (sql) => {
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

export async function roleCatalog(sql) {
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
