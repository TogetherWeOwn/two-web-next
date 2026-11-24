import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  approvedEnds,
  assertProjection,
  assertReadinessTraffic,
} from "./db-readiness-projection.mjs";
import {
  assertMigrationPrefix,
  assertProductionIdentity,
  migrationClient,
  migrationConnectionConfig,
  webMigrationLockKey,
} from "./db-migrate.mjs";
import { assertServingLedgerIsolation } from "./migration-runtime-rights.mjs";
import { assertRollbackVersionId } from "./production-deploy-gate.mjs";
import { addedAfter1033, publicServingRights } from "./web-readiness-scoped-acl.mjs";

const app = "two_web_app";
const migrator = "two_web_migrate";
const originalEnd = "1033_session-roles-checked-at";
const ledgerTable = "__drizzle_migrations";
const ledgerSequence = "__drizzle_migrations_id_seq";
const broadRoles = ["pg_read_all_data", "pg_write_all_data"];
const digest = (s) => createHash("sha256").update(s).digest("hex");
const fingerprint = /^[a-f0-9]{64}$/;
const identifier = /^[a-z_][a-z_0-9-]{0,62}$/;
const baseRights = publicServingRights.filter(({ name }) => !addedAfter1033.has(name));
const edgeKey = (edge) => [edge.kind, edge.name, edge.column, edge.right].join("/");
const publicKeys = new Set(baseRights.map(edgeKey));
const order = (edges) =>
  edges.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));

async function catalog(tx, login) {
  const acl = await tx`with objects as (
    select 'schema' as kind, nspname::text as name, '' as "column", nspowner as owner, nspacl as acl
    from pg_namespace where nspname in ('public', 'drizzle')
    union all
    select case when c.relkind = 'S' then 'sequence' else 'table' end,
      c.relname::text, '', c.relowner, c.relacl
    from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where (n.nspname = 'public' and c.relkind in ('r', 'S'))
      or (n.nspname = 'drizzle' and c.relname in ('__drizzle_migrations', '__drizzle_migrations_id_seq'))
    union all
    select 'table', c.relname::text, a.attname::text, c.relowner, a.attacl
    from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on c.relnamespace = n.oid
    where a.attnum > 0 and not a.attisdropped and
      ((n.nspname = 'public' and c.relname = 'agent_event_grants') or
       (n.nspname = 'drizzle' and c.relname = '__drizzle_migrations'))
  )
  select kind, name, "column", pg_get_userbyid(owner) as owner,
    coalesce(privileges.direct, '[]'::jsonb) as direct
  from objects left join lateral (
    select jsonb_agg(jsonb_build_array(p.privilege_type, pg_get_userbyid(p.grantor), p.is_grantable)) as direct
    from aclexplode(objects.acl) p where p.grantee = ${login}::regrole
  ) privileges on true`;
  const membership = await tx`select role.rolname::text as role, grantor.rolname::text as grantor,
    m.admin_option as admin, m.inherit_option as inherit, m.set_option as "set"
    from pg_auth_members m join pg_roles role on m.roleid = role.oid
      join pg_roles grantor on m.grantor = grantor.oid
    where m.member = ${login}::regrole and role.rolname in ('pg_read_all_data','pg_write_all_data')`;
  const objects = acl.filter(
    ({ kind, name, column }) =>
      baseRights.some(
        (entry) => entry.kind === kind && entry.name === name && entry.column === column,
      ) ||
      name === "drizzle" ||
      name === ledgerTable ||
      name === ledgerSequence,
  );
  const direct = objects.flatMap(({ kind, name, column, direct }) =>
    direct.map(([right, grantor, grantable]) => ({
      kind,
      name,
      column,
      right,
      grantor,
      grantable,
    })),
  );
  const owners = objects.map(({ kind, name, column, owner }) => ({ kind, name, column, owner }));
  return { owners: order(owners), direct: order(direct), membership: order([...membership]) };
}

function isLedger({ name }) {
  return ["drizzle", ledgerTable, ledgerSequence].includes(name);
}

function delta(before) {
  const objects = new Map(
    before.owners.map((row) => [[row.kind, row.name, row.column].join("/"), row.owner]),
  );
  const present = new Set(before.direct.map(edgeKey));
  const add = baseRights.flatMap((row) => {
    const grantor = objects.get([row.kind, row.name, row.column].join("/"));
    assert.match(
      grantor ?? "",
      identifier,
      "Reviewed public object is missing or has an unexpected owner",
    );
    return present.has(edgeKey(row)) ? [] : [{ ...row, grantor, grantable: false }];
  });
  const remove = before.direct.filter(isLedger);
  assert.ok(
    remove.every(({ grantable }) => !grantable),
    "Refusing a delegable ledger ACL",
  );
  assert.deepEqual([...new Set(before.membership.map(({ role }) => role))].sort(), broadRoles);
  assert.ok(
    before.membership.every(({ admin }) => !admin),
    "Refusing a delegable role edge",
  );
  const after = {
    owners: before.owners,
    direct: order([...before.direct.filter((edge) => !isLedger(edge)), ...add]),
    membership: [],
  };
  return { add, remove, after };
}

async function changeEdges(tx, login, edges, grant, change) {
  for (const [grantor, grants] of Object.entries(Object.groupBy(edges, (edge) => edge.grantor))) {
    await tx`set local role ${tx(grantor)}`;
    for (const edge of grants) await change(tx, login, edge, grant);
    await tx`reset role`;
  }
}

async function aclChange(tx, login, edge, grant) {
  const { kind, name, column, right } = edge;
  const schema = isLedger(edge) ? "drizzle" : "public";
  const relation = kind === "schema" ? tx(name) : tx`${tx(schema)}.${tx(name)}`;
  const target = tx`${tx.unsafe(kind)} ${relation}`;
  const privilege = column ? tx`${tx.unsafe(right)} (${tx(column)})` : tx.unsafe(right);
  return grant
    ? tx`grant ${privilege} on ${target} to ${tx(login)}`
    : tx`revoke ${privilege} on ${target} from ${tx(login)} restrict`;
}

async function membershipChange(tx, login, edge, grant) {
  const { role, inherit, set } = edge;
  return grant
    ? tx`grant ${tx(role)} to ${tx(login)}
          with admin false, inherit ${tx.unsafe(inherit ? "true" : "false")}, set ${tx.unsafe(set ? "true" : "false")}`
    : tx`revoke ${tx(role)} from ${tx(login)} restrict`;
}

function aclId({ kind, name, column, right, grantor }) {
  return JSON.stringify([kind, name, column, right, grantor]);
}

async function assertPublicRights(tx, login) {
  // Verify required rights independently of direct ACL rows and membership.
  const [row] = await tx`select bool_and(case
    when kind = 'sequence' then has_sequence_privilege(${login}::text, 'public.' || name, "right")
    when "column" <> '' then has_column_privilege(${login}::text, 'public.' || name, "column", "right")
    else has_table_privilege(${login}::text, 'public.' || name, "right")
    end) as allowed from jsonb_to_recordset(${JSON.stringify(baseRights)}::text::jsonb)
    as r(kind text, name text, "column" text, "right" text)`;
  assert.equal(row.allowed, true, "Required Web/Jobs privileges are missing");
  const [role] = await tx`select rolcanlogin and not
    (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)
    and has_schema_privilege(oid, 'public', 'USAGE')
    and not has_schema_privilege(oid, 'public', 'CREATE') as scoped from pg_roles where rolname = ${login}`;
  assert.ok(role?.scoped, "Unexpected serving role authority");
}

// Capture only role and ACL metadata. The reviewed plan carries hashes of both
// endpoints and the exact delta, so an inverse can run after the journal grows.
export async function planServingIsolation(tx, identity, version, login = app) {
  const before = await catalog(tx, login);
  const { add, remove, after } = delta(before);
  return {
    identity,
    version,
    before: digest(JSON.stringify(before)),
    after: digest(JSON.stringify(after)),
    add: order(add),
    remove: order(remove),
    membership: before.membership,
  };
}

function parsePlan(raw, hash) {
  assert.ok(raw && raw.length <= 24576 && hash === digest(raw));
  const plan = JSON.parse(raw);
  assert.deepEqual(Object.keys(plan).sort(), [
    "add",
    "after",
    "before",
    "identity",
    "membership",
    "remove",
    "version",
  ]);
  assert.ok(
    [plan.before, plan.after, plan.identity].every(
      (value) => typeof value === "string" && fingerprint.test(value),
    ) && plan.before !== plan.after,
  );
  assertRollbackVersionId(plan.version);
  assert.ok(
    plan.add.length <= baseRights.length && plan.remove.length <= 64 && plan.membership.length <= 8,
  );
  for (const edge of [...plan.add, ...plan.remove]) {
    assert.match(edge.grantor, identifier);
    assert.equal(edge.grantable, false);
  }
  assert.ok(plan.add.every((edge) => publicKeys.has(edgeKey(edge))));
  const ledgerRights = {
    schema: { drizzle: ["USAGE", "CREATE"] },
    table: {
      [ledgerTable]: [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ],
    },
    sequence: { [ledgerSequence]: ["USAGE", "SELECT", "UPDATE"] },
  };
  for (const { name, kind, right, column } of plan.remove) {
    assert.ok(Object.hasOwn(ledgerRights, kind) && Object.hasOwn(ledgerRights[kind], name));
    assert.ok(ledgerRights[kind][name].includes(right));
    assert.ok(
      column === "" ||
        (name === ledgerTable &&
          ["created_at", "hash", "id"].includes(column) &&
          ["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(right)),
    );
  }
  for (const { role, grantor, admin, inherit, set } of plan.membership) {
    assert.ok(
      broadRoles.includes(role) &&
        admin === false &&
        typeof inherit === "boolean" &&
        typeof set === "boolean",
    );
    assert.match(grantor, identifier);
  }
  assert.equal(
    new Set([...plan.add, ...plan.remove].map(aclId)).size,
    plan.add.length + plan.remove.length,
  );
  return plan;
}

export async function runServingIsolation(operation, end, env, options = {}) {
  const { connect = migrationClient, fetchImpl = fetch, login = app, owner = migrator } = options;
  assert.ok(["forward", "undo", "readback"].includes(operation) && approvedEnds.has(end));
  if (operation === "forward") assert.equal(end, originalEnd);
  const plan = parsePlan(env.PRODUCTION_DB_ISOLATION_PLAN, env.PRODUCTION_DB_ISOLATION_PLAN_SHA256);
  const config = migrationConnectionConfig(
    { PRODUCTION_DATABASE_URL: env.PRODUCTION_DB_ISOLATION_DATABASE_URL },
    "production",
    plan.identity,
  );
  assert.equal(config.url.pathname, "/postgres");
  const readOnly = operation === "readback";
  const client = connect(config, { readOnly });
  try {
    return await client.begin(
      readOnly ? "isolation level repeatable read read only" : "isolation level read committed",
      async (tx) => {
        await tx`set local search_path = pg_catalog, pg_temp`;
        await tx`set local lock_timeout = '500ms'`;
        await tx`set local statement_timeout = '5s'`;
        await tx`set local transaction_timeout = '25s'`;
        await assertProductionIdentity(tx, config);
        if (!readOnly) {
          const [{ acquired }] =
            await tx`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
          assert.ok(acquired, "Web migration lock held");
          await tx`lock table drizzle.__drizzle_migrations in share mode nowait`;
        }
        const timestamps = await assertMigrationPrefix(tx, end);
        await assertProjection(tx, login, timestamps, owner);
        const initial = await catalog(tx, login);
        const initialHash = digest(JSON.stringify(initial));
        if (readOnly) {
          if (initialHash === plan.before) return "before";
          assert.equal(initialHash, plan.after);
          await assertServingLedgerIsolation(tx, login);
          await assertPublicRights(tx, login);
          return "after";
        }

        const forward = operation === "forward";
        assert.equal(initialHash, forward ? plan.before : plan.after);
        if (forward) {
          const { add, remove, after } = delta(initial);
          assert.deepEqual(plan.add, order(add));
          assert.deepEqual(plan.remove, order(remove));
          assert.deepEqual(plan.membership, initial.membership);
          assert.equal(plan.after, digest(JSON.stringify(after)));
          await assertReadinessTraffic(
            plan.version,
            timestamps,
            env.PRODUCTION_DB_ISOLATION_CF_ACCOUNT_ID,
            env.PRODUCTION_DB_ISOLATION_CF_READ_TOKEN,
            fetchImpl,
          );
        }
        // Add the replacement path before removing the original one in both directions.
        await changeEdges(tx, login, forward ? plan.add : plan.remove, true, aclChange);
        await changeEdges(tx, login, plan.membership, !forward, membershipChange);
        await changeEdges(tx, login, forward ? plan.remove : plan.add, false, aclChange);
        const final = await catalog(tx, login);
        assert.equal(digest(JSON.stringify(final)), forward ? plan.after : plan.before);
        await assertPublicRights(tx, login);
        if (forward) await assertServingLedgerIsolation(tx, login);
        return "committed";
      },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runServingIsolation(process.argv[2], process.argv[3], process.env);
    process.exitCode = { committed: 0, before: 10, after: 11 }[result] ?? 1;
  } catch {
    process.exitCode = 1;
  }
}
