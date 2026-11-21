import assert from "node:assert/strict";

// Disposable census, not the migration lint allowlist: includes the historical
// grace table, audit exceptions and the four tables added through 1037.
const tables = {
  "SELECT, INSERT, UPDATE, DELETE":
    "users profiles discord_event_snapshots job_unique_locks queue_jobs featured_contents rsvps join_attempts web_throttle_hits web_sessions web_oauth_journeys web_session_grace",
  "SELECT, INSERT, UPDATE":
    "events event_sync_attempts event_echoes bot_reconciliation_intents waitlist_offers announcement_send_claims",
  "SELECT, INSERT, DELETE":
    "agent_event_idempotency_keys agent_event_audits agent_event_hits member_data_access_logs event_search_logs board_view_logs queue_failed_jobs event_echo_members",
  "SELECT, INSERT": "activity_log",
  SELECT: "agent_event_grants",
};
const sequences = {
  USAGE: "activity_log agent_event_audits member_data_access_logs",
  "USAGE, SELECT":
    "events featured_contents rsvps event_search_logs board_view_logs agent_event_idempotency_keys agent_event_hits queue_failed_jobs join_attempts web_throttle_hits event_echoes event_echo_members",
};

export async function grantScopedAcl(sql, login) {
  for (const [kind, groups] of [
    ["TABLE", tables],
    ["SEQUENCE", sequences],
  ]) {
    for (const [rights, names] of Object.entries(groups)) {
      const suffix = kind === "SEQUENCE" ? "_id_seq" : "";
      const objects = names.split(" ").map((name) => `public.${name}${suffix}`);
      await sql`GRANT ${sql.unsafe(rights)} ON ${sql.unsafe(kind)} ${sql.unsafe(objects.join(", "))} TO ${sql(login)}`;
    }
  }
  await sql`GRANT UPDATE (updated_at) ON public.agent_event_grants TO ${sql(login)}`;
}

export async function assertScopedAcl(sql, login, owner) {
  const [role] = await sql`SELECT
    NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
    AND rolcanlogin AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS scoped
    FROM pg_roles r WHERE rolname = ${login}`;
  assert.equal(role.scoped, true);
  const [view] = await sql`SELECT pg_get_userbyid(c.relowner) AS owner,
    pg_get_userbyid(n.nspowner) AS schema_owner, c.relkind::text AS kind,
    pg_relation_is_updatable(c.oid, true) AS updatable,
    ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = 'web_readiness.migration_timestamps'::regclass`;
  assert.deepEqual(view, {
    owner,
    schema_owner: owner,
    kind: "v",
    updatable: 0,
    columns: ["created_at"],
  });
  const census = await sql`SELECT c.relname::text AS name, c.relkind::text AS kind,
    pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')`;
  const expected = [
    "web_readiness.migration_timestamps:SELECT",
    "public.agent_event_grants.updated_at:UPDATE",
  ];
  const objects = [];
  for (const [groups, kind] of [
    [tables, "r"],
    [sequences, "S"],
  ]) {
    for (const [rights, names] of Object.entries(groups)) {
      for (const leaf of names.split(" ")) {
        const name = kind === "S" ? `${leaf}_id_seq` : leaf;
        objects.push(`${name}:${kind}:${owner}`);
        expected.push(...rights.split(", ").map((right) => `public.${name}:${right}`));
      }
    }
  }
  const inventory = census.map((row) => `${row.name}:${row.kind}:${row.owner}`);
  assert.deepEqual(inventory.sort(), objects.sort());
  const acl = await sql`WITH relations AS (
    SELECT c.*, n.nspname || '.' || c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'web_readiness')
  ), rights AS (
    SELECT name, p.* FROM relations r CROSS JOIN LATERAL aclexplode(r.relacl) p
    UNION ALL
    SELECT name || '.' || a.attname, p.* FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
    CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE NOT a.attisdropped
  ) SELECT name, privilege_type, grantee = 0 AS public, is_grantable FROM rights
    WHERE grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${login}))`;
  assert.ok(acl.every((right) => !right.public && !right.is_grantable));
  const grants = acl.map(({ name, privilege_type }) => `${name}:${privilege_type}`);
  assert.deepEqual(grants.sort(), expected.sort());
  const schemaAcl = await sql`SELECT nspname::text AS name, privilege_type,
    grantee = 0 AS public, is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl)
    WHERE nspname IN ('public', 'web_readiness') AND grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${login}))`;
  assert.ok(schemaAcl.every((right) => !right.is_grantable));
  const schemas = schemaAcl.map((r) => `${r.name}:${r.privilege_type}:${r.public}`);
  assert.deepEqual(schemas.sort(), [
    "public:USAGE:false",
    "public:USAGE:true",
    "web_readiness:USAGE:false",
  ]);
}

export async function probeWorkloads(owner, runtime) {
  const denied = { code: "42501" };
  const [grant] = await owner`INSERT INTO agent_event_grants
    (agent_id, company_id, guild_id, verifier_hash) VALUES ('fixture', 'fixture', 'fixture', 'fixture') RETURNING id`;
  const one = async (query) => assert.equal((await query).count, 1);
  await runtime.begin(async (tx) => {
    await one(tx`SELECT id FROM agent_event_grants WHERE id = ${grant.id} FOR SHARE`);
    await one(tx`SELECT id FROM agent_event_grants WHERE id = ${grant.id} FOR KEY SHARE`);
  });
  await assert.rejects(
    runtime`UPDATE agent_event_grants SET disabled_at = now() WHERE id = ${grant.id}`,
    denied,
  );
  await assert.rejects(runtime`DELETE FROM agent_event_grants WHERE id = ${grant.id}`, denied);

  await runtime`INSERT INTO users (id, username) VALUES ('fixture', 'member')`;
  await runtime`INSERT INTO web_oauth_journeys (state_hash, flow, expires_at) VALUES ('state', 'auth', now() + interval '1 hour')`;
  await one(runtime`UPDATE web_oauth_journeys SET consumed_at = now() WHERE state_hash = 'state'`);
  await runtime`INSERT INTO web_sessions (token_hash, user_id, username, member, expires_at)
    VALUES ('successor', 'fixture', 'member', true, now() + interval '1 hour')`;
  await runtime`INSERT INTO web_session_grace
    (predecessor_hash, successor_hash, status_hash, user_id, username, member, expires_at, grace_expires_at)
    VALUES ('predecessor', 'successor', 'status', 'fixture', 'member', true, now() + interval '1 hour', now())`;
  const [session] = await runtime`SELECT s.user_id FROM web_sessions s JOIN web_session_grace g
    ON s.token_hash = g.successor_hash WHERE g.predecessor_hash = 'predecessor'`;
  assert.equal(session.user_id, "fixture");
  await one(runtime`DELETE FROM web_session_grace WHERE grace_expires_at <= now()`);
  const [event] = await runtime`INSERT INTO events (event_key, title, starts_at, ends_at)
    VALUES ('fixture', 'Fixture', now(), now() + interval '1 hour') RETURNING id`;
  const [rsvp] = await runtime`INSERT INTO rsvps (event_id, user_id, status)
    VALUES (${event.id}, 'fixture', 'going') RETURNING id`;
  await one(runtime`DELETE FROM rsvps WHERE id = ${rsvp.id}`);
  const [job] = await runtime`INSERT INTO queue_jobs (job_id, kind, available_at)
    VALUES (gen_random_uuid(), 'fixture', now()) RETURNING job_id`;
  await one(
    runtime`UPDATE queue_jobs SET reserved_at = now() WHERE job_id = ${job.job_id} RETURNING job_id`,
  );
  await one(runtime`DELETE FROM queue_jobs WHERE job_id = ${job.job_id}`);
  await runtime`INSERT INTO bot_reconciliation_intents (idempotency_key, verb, subject, last_attempt_at, attempts)
    VALUES (${job.job_id}, 'event.upsert', 'fixture', now(), 1)`;
  const [intent] = await runtime`UPDATE bot_reconciliation_intents SET resolved_at = now()
    WHERE idempotency_key = ${job.job_id} RETURNING attempts`;
  assert.equal(intent.attempts, 1);
  await runtime`INSERT INTO announcement_send_claims (idempotency_key, send_attempts, state, started_at)
    VALUES (${job.job_id}, 1, 'sending', now())`;
  const [claim] = await runtime`UPDATE announcement_send_claims SET state = 'closed'
    WHERE idempotency_key = ${job.job_id} RETURNING send_attempts`;
  assert.equal(claim.send_attempts, 1);

  await runtime`INSERT INTO activity_log (description, created_at) VALUES ('fixture', now() - interval '91 days')`;
  await runtime`INSERT INTO agent_event_audits (operation, request_id, result, created_at)
    SELECT 'fixture', 'fixture', 'ok', now() - age FROM unnest(ARRAY[interval '0', interval '91 days']) AS age`;
  await runtime`INSERT INTO member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
    SELECT 'fixture', 'fixture', 'view', '[]'::jsonb, 0, now() - age FROM unnest(ARRAY[interval '0', interval '91 days']) AS age`;
  for (const [table, age] of [
    ["activity_log", "created_at"],
    ["agent_event_audits", "created_at"],
    ["member_data_access_logs", "occurred_at"],
  ]) {
    const [triggers] = await owner`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgrelid = ${`public.${table}`}::regclass AND NOT tgisinternal AND tgenabled = 'O'`;
    assert.equal(triggers.count, 2);
    await assert.rejects(runtime`UPDATE ${runtime(table)} SET id = id`, denied);
    await assert.rejects(runtime`TRUNCATE ${runtime(table)}`, denied);
    await assert.rejects(runtime`SELECT last_value FROM ${runtime(`${table}_id_seq`)}`, denied);
    await assert.rejects(runtime`SELECT setval(${`${table}_id_seq`}, 1)`, denied);
    if (table === "activity_log") {
      await assert.rejects(runtime`DELETE FROM activity_log`, denied);
    } else {
      await assert.rejects(
        runtime`DELETE FROM ${runtime(table)} WHERE ${runtime(age)} >= now() - interval '90 days'`,
        /append-only/,
      );
      await one(
        runtime`DELETE FROM ${runtime(table)} WHERE ${runtime(age)} < now() - interval '90 days'`,
      );
    }
  }
}
