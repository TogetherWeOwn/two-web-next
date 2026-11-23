import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProductionIdentity,
  migrationClient,
  migrationConnectionConfig,
  webMigrationLockKey,
} from "./db-migrate.mjs";

const digest = /^[a-f0-9]{64}$/;
const reservedRoles = ["postgres", "two_web_app", "two_web_backup", "two_web_migrate"];

function approvedPlan(operation, env) {
  assert.ok(["provision", "revoke"].includes(operation));
  const raw = env.PRODUCTION_DB_EXECUTOR_PLAN;
  assert.ok(raw && raw.length <= 1024);
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    env.PRODUCTION_DB_EXECUTOR_PLAN_SHA256,
  );
  const plan = JSON.parse(raw);
  assert.deepEqual(Object.keys(plan).sort(), ["executor", "identity", "operation"]);
  assert.equal(plan.operation, operation);
  assert.match(plan.identity, digest);
  assert.match(plan.executor, /^[a-z][a-z_0-9-]{0,62}$/);
  assert.ok(!reservedRoles.includes(plan.executor));
  return plan;
}

async function membership(tx, executor) {
  const [row] = await tx`
    select current_user::text as provisioner,
      e.rolcanlogin and not e.rolsuper and not p.rolsuper
      and not pg_has_role(p.oid, e.oid, 'MEMBER')
      and not pg_has_role(e.oid, p.oid, 'MEMBER')
      and not exists (select from pg_auth_members where roleid = e.oid)
      and exists (select from pg_auth_members
        where roleid = m.oid and member = p.oid and admin_option)
      and not pg_has_role(p.oid, m.oid, 'USAGE')
      and not pg_has_role(p.oid, m.oid, 'SET') as authorized,
      pg_has_role(e.oid, m.oid, 'MEMBER') as member,
      pg_has_role(e.oid, m.oid, 'USAGE') as inherits,
      pg_has_role(e.oid, m.oid, 'SET') as can_set,
      (select coalesce(jsonb_agg(jsonb_build_array(
          grantor::regrole::text, admin_option, inherit_option, set_option)), '[]'::jsonb)
        from pg_auth_members where roleid = m.oid and member = e.oid) as edges
    from pg_namespace n
    join pg_roles e on e.oid = n.nspowner
    join pg_roles m on m.rolname = 'two_web_migrate'
    join pg_roles p on p.rolname = current_user
    where n.nspname = 'drizzle' and e.rolname = ${executor} and e.oid <> p.oid`;
  assert.ok(row?.authorized, "Executor or provisioner does not match the approved scope");
  const present = row.edges.length !== 0;
  assert.deepEqual(row.edges, present ? [[row.provisioner, false, true, true]] : []);
  assert.deepEqual([row.member, row.inherits, row.can_set], [present, present, present]);
  return present;
}

export async function runExecutorAuthority(operation, env, connect = migrationClient) {
  const plan = approvedPlan(operation, env);
  const config = migrationConnectionConfig(
    { PRODUCTION_DATABASE_URL: env.PRODUCTION_DB_EXECUTOR_DATABASE_URL },
    "production",
    plan.identity,
  );
  assert.equal(config.url.pathname, "/postgres");
  const client = connect(config);
  try {
    await client.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path = pg_catalog`;
      await tx`set local lock_timeout = '2s'`;
      await tx`set local statement_timeout = '10s'`;
      await tx`set local transaction_timeout = '20s'`;
      await assertProductionIdentity(tx, config);
      const [{ acquired }] =
        await tx`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
      assert.equal(acquired, true);
      const wanted = operation === "provision";
      if ((await membership(tx, plan.executor)) === wanted) return;
      if (wanted) {
        await tx`grant two_web_migrate to ${tx(plan.executor)}
          with admin false, inherit true, set true granted by current_user`;
      } else {
        await tx`revoke two_web_migrate from ${tx(plan.executor)} granted by current_user restrict`;
      }
      assert.equal(await membership(tx, plan.executor), wanted);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runExecutorAuthority(process.argv[2], process.env);
  } catch {
    process.exitCode = 1;
  }
}
