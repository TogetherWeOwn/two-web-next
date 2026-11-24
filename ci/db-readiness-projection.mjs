import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  assertMigrationPrefix,
  assertProductionIdentity,
  migrationClient,
  migrationConnectionConfig,
  webMigrationLockKey,
} from "./db-migrate.mjs";
import { assertRollbackVersionId } from "./production-deploy-gate.mjs";
import { liveVersion, rollbackEnvironment } from "./rollback-target.mjs";

const source = new URL("../docs/web-readiness-projection.sql", import.meta.url);
const reviewedSqlHash = "d202ac7d38a6c932276e8e90d3fee049e4cf700b261952106f722deb7c9615ec";
const marker = "two-web readiness projection installation v1";
const definition = "SELECT created_at FROM drizzle.__drizzle_migrations OFFSET 0;";
export const approvedEnds = new Set(["1033_session-roles-checked-at", "1037_waitlist-offers"]);

function parsePlan(operation, raw, digest) {
  assert.ok(
    raw && raw.length <= 2048 && createHash("sha256").update(raw).digest("hex") === digest,
    "Readiness plan digest did not match",
  );
  const plan = JSON.parse(raw);
  const fields = "identity ledger operation servingRole webVersion".split(" ");
  assert.deepEqual(Object.keys(plan).sort(), fields);
  assert.ok(
    ["forward", "undo"].includes(operation) &&
      plan.operation === operation &&
      approvedEnds.has(plan.ledger) &&
      typeof plan.identity === "string" &&
      /^[a-f0-9]{64}$/.test(plan.identity) &&
      typeof plan.servingRole === "string" &&
      /^[a-z_][a-z_0-9-]{0,62}$/.test(plan.servingRole),
    "Invalid readiness plan",
  );
  if (operation === "undo") assertRollbackVersionId(plan.webVersion);
  else assert.equal(plan.webVersion, null);
  return plan;
}

async function readJson(url, options, fetchImpl, maxBytes) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  assert.ok(response.status === 200 && response.body, "Readiness traffic check unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      assert.ok(bytes <= maxBytes, "Oversized readiness traffic response");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}

export async function assertReadinessTraffic(version, timestamps, account, token, fetchImpl) {
  assert.match(account ?? "", /^[0-9a-f]{32}$/);
  assert.ok(token, "Missing Workers read credential");
  const { origin, worker } = rollbackEnvironment("production");
  const { success, result } = await readJson(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/deployments`,
    { headers: { authorization: `Bearer ${token}` } },
    fetchImpl,
    1024 * 1024,
  );
  assert.ok(
    success === true && liveVersion(result?.deployments) === version,
    "Approved Worker must serve all Web traffic",
  );
  const health = await readJson(
    new URL("/up", origin),
    { headers: { "cache-control": "no-cache" } },
    fetchImpl,
    16 * 1024,
  );
  assert.equal(health.revision?.version_id, version, "Readiness version mismatch");
  assert.equal(health.db, "ok");
  assert.equal(health.pending_migrations, 0, "Fallback Worker reports pending migrations");
  assert.deepEqual(health.migration_ledger, timestamps);
}

async function assertLedgerAndRole(tx, servingRole) {
  const [state] = await tx`select
    c.relkind = 'r' and c.relowner = (current_user::regrole)::oid and not c.relrowsecurity
      and not exists (select from pg_inherits where inhparent = c.oid or inhrelid = c.oid)
      and to_regclass('public.announcement_send_claims') is null as ledger,
    r.rolcanlogin and not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
      and not pg_has_role(r.oid, c.relowner, 'MEMBER') as serving,
    has_schema_privilege(r.oid, c.relnamespace, 'USAGE')
      and has_column_privilege(r.oid, c.oid, 'created_at', 'SELECT') as fallback
    from pg_class c cross join pg_roles r
    where c.oid = 'drizzle.__drizzle_migrations'::regclass and r.rolname = ${servingRole}`;
  assert.ok(state?.ledger && state.serving, "Unexpected ledger owner, shape, or serving role");
  assert.ok(state.fallback, "Serving role must already have direct ledger timestamp access");
}

export async function assertProjection(tx, servingRole, timestamps, owner = null) {
  const [state] = await tx`select pg_get_viewdef(c.oid, true) as definition,
    c.relkind = 'v' and n.nspowner = c.relowner
      and c.relowner = (coalesce(${owner}, current_user)::regrole)::oid
      and obj_description(c.oid, 'pg_class') = ${marker}
      and c.reloptions = array['security_invoker=false']
      and pg_relation_is_updatable(c.oid, true) = 0 and not c.relhastriggers
      and not exists (select from pg_rewrite where ev_class = c.oid and rulename <> '_RETURN')
      and not exists (select from pg_attribute where attrelid = c.oid and (attacl is not null or atthasdef))
      and not has_schema_privilege(r.oid, n.oid, 'CREATE, USAGE WITH GRANT OPTION')
      and not has_table_privilege(r.oid, c.oid, 'SELECT WITH GRANT OPTION') as intact,
    n.nspowner, r.oid as grantee,
    n.nspacl::text as schema_acl, c.relacl::text as view_acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join pg_roles r
    where c.oid = 'web_readiness.migration_timestamps'::regclass and r.rolname = ${servingRole}`;
  assert.ok(
    state?.intact && state.definition.trim().replace(/\s+/g, " ") === definition,
    "Readiness projection definition or authority drifted",
  );
  for (const [acl, kind, right] of [
    [state.schema_acl, "n", "USAGE"],
    [state.view_acl, "r", "SELECT"],
  ]) {
    const [row] =
      await tx`select array(select p::text from aclexplode(${acl}::aclitem[]) p order by p::text)
      = array(select right_row from (
        select p::text as right_row from aclexplode(acldefault(${kind}::"char", ${state.nspowner}::oid)) p
        union all
        select row(${state.nspowner}::oid, ${state.grantee}::oid, ${right}::text, false)::text
      ) expected order by right_row) as exact`;
    assert.equal(row.exact, true, "Readiness projection grants drifted");
  }
  const rows =
    await tx`select created_at from web_readiness.migration_timestamps order by created_at limit ${timestamps.length + 1}`;
  assert.deepEqual(
    rows.map(({ created_at }) => Number(created_at)),
    timestamps,
  );
}

export async function runReadinessProjection(operation, env, options = {}) {
  const { connect = migrationClient, fetchImpl = fetch } = options;
  const plan = parsePlan(
    operation,
    env.PRODUCTION_DB_READINESS_PLAN,
    env.PRODUCTION_DB_READINESS_PLAN_SHA256,
  );
  const config = migrationConnectionConfig(
    { PRODUCTION_DATABASE_URL: env.PRODUCTION_DB_READINESS_DATABASE_URL },
    "production",
    plan.identity,
  );
  assert.equal(config.url.pathname, "/postgres");
  const client = connect(config);
  try {
    await client.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path = pg_catalog, pg_temp`;
      await tx`set local lock_timeout = '500ms'`;
      await tx`set local statement_timeout = '5s'`;
      await tx`set local transaction_timeout = '20s'`;
      await assertProductionIdentity(tx, config);
      const [{ acquired }] =
        await tx`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
      assert.ok(acquired, "Web migration lock held");
      // SHARE keeps non-cooperating ledger writes out while allowing readiness reads.
      await tx`lock table drizzle.__drizzle_migrations in share mode nowait`;
      await assertLedgerAndRole(tx, plan.servingRole);
      const timestamps = await assertMigrationPrefix(tx, plan.ledger);

      if (operation === "forward") {
        const sql = options.projectionSql ?? readFileSync(source);
        assert.equal(
          createHash("sha256").update(sql).digest("hex"),
          reviewedSqlHash,
          "Readiness projection SQL differs from the reviewed definition",
        );
        await tx.unsafe(sql.toString("utf8")).simple();
        await tx`comment on view web_readiness.migration_timestamps is 'two-web readiness projection installation v1'`;
        await tx`grant usage on schema web_readiness to ${tx(plan.servingRole)}`;
        await tx`grant select on web_readiness.migration_timestamps to ${tx(plan.servingRole)}`;
        await assertProjection(tx, plan.servingRole, timestamps);
      } else {
        await assertReadinessTraffic(
          plan.webVersion,
          timestamps,
          env.PRODUCTION_DB_READINESS_CF_ACCOUNT_ID,
          env.PRODUCTION_DB_READINESS_CF_READ_TOKEN,
          fetchImpl,
        );
        await assertLedgerAndRole(tx, plan.servingRole);
        await assertProjection(tx, plan.servingRole, timestamps);
        await tx`drop view web_readiness.migration_timestamps restrict`;
        await tx`drop schema web_readiness restrict`;
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runReadinessProjection(process.argv[2], process.env);
  } catch {
    process.exitCode = 1;
  }
}
