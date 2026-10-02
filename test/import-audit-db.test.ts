import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from './helpers/member-data-db';
import { DEFAULT_CONFIG, handleAgentEvent } from '../src/agent-events/service';
import { sha256Hex } from '../src/bot/signer';
// @ts-expect-error Standalone operator CLI has no declaration file.
import { importAudit } from '../bin/import/audit.mjs';

// Deliberately do not use inherited DATABASE_URL: this suite accepts only an
// explicit opt-in test URL, validated before connecting or creating any schema.
const raw = process.env.AUDIT_IMPORT_TEST_DATABASE_URL;
const suite = raw ? describe : describe.skip;
const now = new Date('2026-09-30T00:00:00Z');
const names = ['member_data_access_logs', 'activity_log', 'agent_event_grants',
  'agent_event_audits', 'agent_event_idempotency_keys'] as const;
const sourceSchema = `legacy_audit_${randomUUID().replaceAll('-', '')}`;
let fixture: MemberDataFixture;
let legacy: ReturnType<typeof postgres>;
let ingress: ReturnType<typeof postgres>;

suite('audit import into the migrated Next schema (disposable test DB only)', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl(raw!);
    if (url.hostname === 'agent-testdb' && url.pathname !== '/two_web_next') {
      throw new Error('Audit fixtures require agent-testdb database two_web_next');
    }
    fixture = await createMemberDataFixture(raw!);
    // Import and ingress must use raw postgres.js serializers like the CLI.
    // Drizzle overrides the fixture client's JSON and timestamp serializers.
    ingress = postgres(url.href, {
      max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {},
      connection: { search_path: fixture.schemaName, timezone: 'Asia/Tokyo' },
    });
    legacy = postgres(url.href, {
      max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {},
      connection: { timezone: 'Pacific/Honolulu' },
    });
    const ddl = await readFile(new URL('./fixtures/legacy/audit.sql', import.meta.url), 'utf8');
    await legacy.unsafe(ddl.replaceAll('CREATE SCHEMA legacy;', `CREATE SCHEMA "${sourceSchema}";`)
      .replaceAll('legacy.', `"${sourceSchema}".`));
  });

  afterAll(async () => {
    try {
      if (legacy) await legacy.unsafe(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    } finally {
      await legacy?.end();
      await ingress?.end();
      await fixture?.dispose();
    }
  });

  beforeEach(async () => {
    // Only the schemas created by this suite are mutable. The application
    // import itself never truncates, deletes, updates or disables triggers.
    await fixture.client.unsafe(`TRUNCATE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_grants SET verifier_hash = repeat('a', 64)
      WHERE id = '22222222-2222-4222-8222-222222222222'`);
  });

  const run = (opts: Record<string, unknown> = {}) => importAudit({
    legacy, target: ingress, legacySchema: sourceSchema,
    targetSchema: fixture.schemaName, now, ...opts,
  });

  const sourceState = async () => {
    const rows: Record<string, unknown> = {};
    const sequences: Record<string, unknown> = {};
    for (const name of names) {
      // Server-side text preserves JSON shape and timestamp microseconds.
      rows[name] = [...await legacy.unsafe(`SELECT row_to_json(evidence)::text AS row
        FROM "${sourceSchema}"."${name}" AS evidence ORDER BY id`)];
      if (name !== 'agent_event_grants') {
        sequences[name] = [...await legacy.unsafe(`SELECT last_value::text, is_called
          FROM "${sourceSchema}"."${name}_id_seq"`)];
      }
    }
    return { rows, sequences };
  };

  const seedSourceSequences = async () => {
    let index = 0;
    for (const name of names) {
      if (name === 'agent_event_grants') continue;
      // Exercise both is_called states, with last_value below historical IDs:
      // an aliased apply used to change all four sequences despite skipping IDs.
      await legacy`SELECT setval(${`"${sourceSchema}"."${name}_id_seq"`}::regclass,
        ${index + 1}, ${index % 2 === 1})`;
      index++;
    }
  };

  it.each([true, false])('refuses a same-schema alias before changing any source row or sequence (dryRun=%s)', async (dryRun) => {
    await seedSourceSequences();
    const before = await sourceState();
    let refused = false;
    try { await run({ targetSchema: sourceSchema, dryRun, enableGrants: true }); }
    catch { refused = true; }
    expect(await sourceState()).toEqual(before);
    expect(refused).toBe(true);
    for (const client of [legacy, ingress]) {
      const [locks] = await client`SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
      expect(locks!.n).toBe(0);
    }
  });

  it.each([true, false])('actual CLI refuses different URL strings for the same schema with static output (dryRun=%s)', async (dryRun) => {
    const url = testDatabaseUrl(raw!);
    const alias = new URL(url.href);
    alias.protocol = url.protocol === 'postgres:' ? 'postgresql:' : 'postgres:';
    // Both spellings are validated authorized synthetic targets; no DNS or
    // credential alias is resolved and no inherited environment is passed on.
    testDatabaseUrl(alias.href);
    expect(alias.href).not.toBe(url.href);
    await seedSourceSequences();
    const before = await sourceState();
    const result = await new Promise<{ code: number | string | undefined; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath,
        [fileURLToPath(new URL('../bin/import/audit.mjs', import.meta.url)), ...(dryRun ? [] : ['--apply'])], {
          timeout: 20000,
          env: { LEGACY_DATABASE_URL: url.href, DATABASE_URL: alias.href,
            LEGACY_DATABASE_SCHEMA: sourceSchema, DATABASE_SCHEMA: sourceSchema },
        }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }));
    });
    expect(await sourceState()).toEqual(before);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Audit import failed; no row data or connection details logged.\n');
  });

  it.each([true, false])('supports separate schemas without changing source rows or sequences (dryRun=%s)', async (dryRun) => {
    await seedSourceSequences();
    const before = await sourceState();
    const result = await run({ dryRun });
    expect(result.mode).toBe(dryRun ? 'dry-run' : 'apply');
    expect(await sourceState()).toEqual(before);
  });

  const expectPreservedEvidence = async () => {
    const [access] = await ingress`SELECT subject_user_ids, jsonb_typeof(subject_user_ids) AS type
      FROM member_data_access_logs WHERE id = 92001`;
    expect.soft(access).toEqual({ subject_user_ids: [91001], type: 'array' });
    const activities = await ingress`SELECT properties, jsonb_typeof(properties) AS type
      FROM activity_log ORDER BY id`;
    expect.soft([...activities]).toEqual([
      { properties: { attributes: { synthetic: true } }, type: 'object' },
      { properties: null, type: null },
    ]);
    const [replay] = await ingress`SELECT body, jsonb_typeof(body) AS type
      FROM agent_event_idempotency_keys WHERE id = 94001`;
    expect.soft(replay).toEqual({ body: { event_key: '01K5SYNTHETIC0000000000001' }, type: 'object' });
    const timestamps = {
      member_data_access_logs: ['occurred_at'],
      activity_log: ['created_at', 'updated_at'],
      agent_event_grants: ['expires_at', 'disabled_at', 'created_at', 'updated_at'],
      agent_event_audits: ['created_at', 'updated_at'],
      agent_event_idempotency_keys: ['created_at', 'updated_at'],
    };
    // Compare in Postgres at full precision, not through either client's Date parser.
    for (const [table, columns] of Object.entries(timestamps)) {
      for (const column of columns) {
        const mismatches = await ingress.unsafe(`SELECT s.id::text FROM "${sourceSchema}"."${table}" s
          JOIN "${fixture.schemaName}"."${table}" t ON t.id = s.id
          WHERE t."${column}" IS DISTINCT FROM (s."${column}" AT TIME ZONE 'UTC')
          ${table === 'agent_event_grants' && column === 'disabled_at' ? 'AND s.disabled_at IS NOT NULL' : ''}`);
        expect.soft([...mismatches], `${table}.${column}`).toEqual([]);
      }
    }
  };

  it('runs the actual CLI with raw clients, preserving JSON and every UTC timestamp on apply and rerun', async () => {
    const url = testDatabaseUrl(raw!);
    // Keep this real-clock CLI test within retention as the pinned fixture ages.
    await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_idempotency_keys
      SET created_at = date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day' + interval '0.123456 seconds'
      WHERE id = 94001`);
    const cli = async (args: string[]) => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL('../bin/import/audit.mjs', import.meta.url)), ...args], {
          timeout: 20000,
          env: { LEGACY_DATABASE_URL: url.href, DATABASE_URL: url.href,
            LEGACY_DATABASE_SCHEMA: sourceSchema, DATABASE_SCHEMA: fixture.schemaName, TZ: 'Pacific/Honolulu' },
        });
      expect(stderr).toBe('');
      return JSON.parse(stdout);
    };
    try {
      const preview = await cli([]);
      expect(preview.mode).toBe('dry-run');
      for (const name of names) expect(preview.tables[name]).toMatchObject({ inserted: 0, updated: 0 });
      const applied = await cli(['--apply']);
      for (const name of names) expect(applied.tables[name]).toMatchObject({
        inserted: name === 'agent_event_idempotency_keys' ? 1 : 2, updated: 0,
      });
      await expectPreservedEvidence();
      const again = await cli(['--apply']);
      for (const name of names) expect(again.tables[name]).toMatchObject({ inserted: 0, updated: 0 });
      await expectPreservedEvidence();
    } finally {
      await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_idempotency_keys
        SET created_at = timestamp '2026-09-29 00:00:00.123456' WHERE id = 94001`);
    }
  }, 30000);

  it('preserves the event-sync and RSVP schema additions preceding the audit migration', async () => {
    const columns = await fixture.client`SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = ${fixture.schemaName}
      AND ((table_name = 'events' AND column_name IN ('discord_sync_failed_at', 'discord_sync_failure_code'))
        OR (table_name = 'rsvps' AND column_name = 'legacy_id'))
      ORDER BY table_name, column_name`;
    expect([...columns]).toEqual([
      { table_name: 'events', column_name: 'discord_sync_failed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { table_name: 'events', column_name: 'discord_sync_failure_code', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'rsvps', column_name: 'legacy_id', data_type: 'bigint', is_nullable: 'YES' },
    ]);
  });

  it('previews counts without writes or sequence advancement', async () => {
    const before = await fixture.client`SELECT last_value, is_called FROM activity_log_id_seq`;
    const result = await run();
    expect(result.mode).toBe('dry-run');
    for (const name of names) {
      expect(result.tables[name]).toMatchObject({ read: 2, inserted: 0, updated: 0,
        would_insert: name === 'agent_event_idempotency_keys' ? 1 : 2 });
      const [row] = await fixture.client.unsafe(`SELECT count(*)::int AS n FROM "${name}"`);
      expect(row!.n).toBe(0);
    }
    expect(result.tables.agent_event_idempotency_keys.expired).toBe(1);
    expect(await fixture.client`SELECT last_value, is_called FROM activity_log_id_seq`).toEqual(before);
  });

  it('preserves evidence, IDs and microsecond UTC timestamps; defaults grants disabled', async () => {
    const result = await run({ dryRun: false });
    for (const name of names) {
      expect(result.tables[name]).toMatchObject({ updated: 0,
        inserted: name === 'agent_event_idempotency_keys' ? 1 : 2 });
    }
    const access = await fixture.client`SELECT id, viewer_user_id, subject_user_ids, route,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS occurred
      FROM member_data_access_logs ORDER BY id`;
    expect(access[0]).toMatchObject({ id: 92001, viewer_user_id: '91001',
      subject_user_ids: [91001], route: 'admin.members.view', occurred: '2026-09-01 10:11:12.123456' });
    expect(access[1]!.route).toBeNull();
    const activities = await fixture.client`SELECT *,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS updated
      FROM activity_log ORDER BY id`;
    expect(activities[0]).toMatchObject({ id: 93001, subject_id: '91001', causer_id: '91001',
      causer_type: 'App\\Models\\User', event: 'viewed',
      batch_uuid: '11111111-1111-4111-8111-111111111111', updated: '2026-09-01 10:11:12.234567',
      properties: { attributes: { synthetic: true } } });
    expect(activities[1]).toMatchObject({ log_name: null, updated_at: null, properties: null });
    const grants = await fixture.client`SELECT id, verifier_hash,
      to_char(disabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS disabled FROM agent_event_grants ORDER BY id`;
    expect(grants[0]).toMatchObject({ verifier_hash: 'a'.repeat(64), disabled: '2026-09-30 00:00:00' });
    expect(grants[1]!.disabled).toBe('2026-09-02 00:00:00');
    const audits = await fixture.client`SELECT id::text, discord_event_id,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS updated
      FROM agent_event_audits ORDER BY id`;
    expect(audits[0]).toMatchObject({ id: '95001', discord_event_id: '100000000000000003',
      updated: '2026-09-29 00:00:00.234567' });
    expect(audits[1]!.updated).toBeNull();
    expect(await fixture.client`SELECT key FROM agent_event_idempotency_keys`).toEqual([{ key: 'synthetic-recent' }]);
    // Explicit historical IDs must not make the next app INSERT collide.
    const [next] = await fixture.client`INSERT INTO activity_log (description) VALUES ('Synthetic post-import write') RETURNING id`;
    expect(next!.id).toBeGreaterThan(93002);
  });

  it('second apply inserts/updates zero, leaves existing evidence untouched, and works with immutability triggers', async () => {
    await fixture.client`INSERT INTO activity_log (id, description) VALUES (93001, 'Synthetic Next evidence')`;
    await fixture.client.unsafe(`CREATE FUNCTION "${fixture.schemaName}".reject_audit_mutation() RETURNS trigger
      LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''append only''; END';`);
    for (const name of ['member_data_access_logs', 'activity_log', 'agent_event_audits']) {
      await fixture.client.unsafe(`CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "${name}"
        FOR EACH ROW EXECUTE FUNCTION "${fixture.schemaName}".reject_audit_mutation()`);
    }
    try {
      const first = await run({ dryRun: false });
      expect(first.tables.member_data_access_logs.inserted).toBe(2);
      expect(first.tables.agent_event_audits.inserted).toBe(2);
      expect(first.tables.activity_log).toMatchObject({ inserted: 1, existing: 1, updated: 0 });
      const again = await run({ dryRun: false, enableGrants: true });
      for (const name of names) expect(again.tables[name]).toMatchObject({ inserted: 0, updated: 0 });
      const [row] = await fixture.client`SELECT description FROM activity_log WHERE id = 93001`;
      expect(row!.description).toBe('Synthetic Next evidence');
      const [grant] = await fixture.client`SELECT disabled_at FROM agent_event_grants WHERE verifier_hash = ${'a'.repeat(64)}`;
      expect(grant!.disabled_at).not.toBeNull(); // --enable-grants never updates an existing disabled grant.
    } finally {
      for (const name of ['member_data_access_logs', 'activity_log', 'agent_event_audits']) {
        await fixture.client.unsafe(`DROP TRIGGER immutable ON "${name}"`);
      }
      await fixture.client.unsafe(`DROP FUNCTION "${fixture.schemaName}".reject_audit_mutation()`);
    }
  });

  it('reads every mixed-width numeric ID across pages in preview, apply and rerun', async () => {
    await legacy.unsafe(`INSERT INTO "${sourceSchema}".activity_log (id, description, created_at)
      SELECT id, 'Synthetic pagination row', timestamp '2026-09-01' FROM generate_series(1, 1000) AS id`);
    try {
      const preview = await run();
      expect(preview.tables.activity_log).toMatchObject({ read: 1002, would_insert: 1002, inserted: 0 });
      const applied = await run({ dryRun: false });
      expect(applied.tables.activity_log).toMatchObject({ read: 1002, inserted: 1002, existing: 0 });
      const rows = await fixture.client`SELECT id FROM activity_log ORDER BY id`;
      expect(rows.map((r) => r.id)).toEqual([...Array.from({ length: 1000 }, (_, i) => i + 1), 93001, 93002]);
      const again = await run({ dryRun: false });
      expect(again.tables.activity_log).toMatchObject({ read: 1002, inserted: 0, updated: 0, existing: 1002 });
    } finally {
      await legacy.unsafe(`DELETE FROM "${sourceSchema}".activity_log WHERE id BETWEEN 1 AND 1000`);
    }
  }, 30000);

  const unusedId = '44444444-4444-4444-8444-444444444444';
  const unusedToken = 'synthetic-import-unused-token';
  const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: 'synthetic-agent',
    stagingGuildId: '100000000000000002' };
  const create = (token: string, key: string) => handleAgentEvent(ingress, cfg, {
    op: 'create', idempotency_key: key, fields: {
      title: 'Synthetic post-import event', location: 'Synthetic voice', timezone: 'UTC',
      starts_at: '2026-10-01 20:00', ends_at: '2026-10-01 22:00',
    },
  }, token);
  const addUnusedGrant = async () => {
    await legacy.unsafe(`INSERT INTO "${sourceSchema}".agent_event_grants
      (id, agent_id, company_id, guild_id, verifier_hash, created_at)
      VALUES ($1, 'synthetic-agent', 'synthetic-company', '100000000000000002', $2, timestamp '2026-09-01')`,
    [unusedId, await sha256Hex(unusedToken)]);
  };
  const removeUnusedGrant = async () => {
    await legacy.unsafe(`DELETE FROM "${sourceSchema}".events WHERE agent_grant_id = $1`, [unusedId]);
    await legacy.unsafe(`DELETE FROM "${sourceSchema}".agent_event_audits WHERE grant_id = $1`, [unusedId]);
    await legacy.unsafe(`DELETE FROM "${sourceSchema}".agent_event_grants WHERE id = $1`, [unusedId]);
  };

  it('enables only proven unused grants; spent imports cannot create under a fresh key', async () => {
    const spentToken = 'synthetic-import-spent-token';
    await addUnusedGrant();
    await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_grants SET verifier_hash = $1, expires_at = NULL
      WHERE id = '22222222-2222-4222-8222-222222222222'`, [await sha256Hex(spentToken)]);
    try {
      await run({ dryRun: false, enableGrants: true });
      const rows = await fixture.client`SELECT disabled_at FROM agent_event_grants ORDER BY id`;
      expect(rows[0]!.disabled_at).not.toBeNull(); // Already consumed in legacy.
      expect(rows[1]!.disabled_at).not.toBeNull(); // Disabled in legacy.
      expect(rows[2]!.disabled_at).toBeNull(); // Proven unused.
      expect(await fixture.client`SELECT event_key FROM events`).toEqual([]);
      const denied = await create(spentToken, 'fresh-spent-key');
      expect(denied).toMatchObject({ status: 403, body: { reason: 'grant_disabled' } });
      expect(await fixture.client`SELECT event_key FROM events`).toEqual([]);
      expect(await fixture.client`SELECT key FROM agent_event_idempotency_keys WHERE key = 'fresh-spent-key'`).toEqual([]);
      expect((await create(unusedToken, 'fresh-unused-key')).status).toBe(201);
      expect(await create(unusedToken, 'another-unused-key')).toMatchObject({ status: 409, body: { reason: 'quota_exceeded' } });
    } finally {
      await removeUnusedGrant();
      await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_grants
        SET verifier_hash = repeat('a', 64), expires_at = timestamp '2026-10-10'
        WHERE id = '22222222-2222-4222-8222-222222222222'`);
    }
  });

  it.each(['ownership', 'audit', 'expired replay', 'zero allowance'])('keeps a grant disabled with only %s evidence', async (evidence) => {
    await addUnusedGrant();
    try {
      if (evidence === 'ownership') {
        await legacy.unsafe(`INSERT INTO "${sourceSchema}".events (agent_grant_id) VALUES ($1)`, [unusedId]);
      } else if (evidence === 'audit') {
        await legacy.unsafe(`INSERT INTO "${sourceSchema}".agent_event_audits
          (grant_id, operation, request_id, result, created_at)
          VALUES ($1, 'create', 'synthetic-historical-request', 'accepted', timestamp '2026-01-01')`, [unusedId]);
      } else if (evidence === 'expired replay') {
        await legacy.unsafe(`INSERT INTO "${sourceSchema}".agent_event_idempotency_keys
          (grant_id, key, payload_digest, status, body, created_at)
          VALUES ($1, 'synthetic-spent-old-key', repeat('c', 64), 201, '{}', timestamp '2026-01-01')`, [unusedId]);
      } else {
        await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_grants SET max_events = 0 WHERE id = $1`, [unusedId]);
      }
      await run({ dryRun: false, enableGrants: true });
      expect(await create(unusedToken, 'fresh-history-key')).toMatchObject({ status: 403, body: { reason: 'grant_disabled' } });
      expect(await fixture.client`SELECT event_key FROM events`).toEqual([]);
      expect(await fixture.client`SELECT key FROM agent_event_idempotency_keys WHERE key IN ('fresh-history-key', 'synthetic-spent-old-key')`).toEqual([]);
    } finally {
      await removeUnusedGrant();
    }
  });

  it('keeps grants with unknown ownership disabled even when activation is requested', async () => {
    await addUnusedGrant();
    await legacy.unsafe(`ALTER TABLE "${sourceSchema}".events RENAME COLUMN agent_grant_id TO unknown_ownership`);
    try {
      await run({ dryRun: false, enableGrants: true });
      expect(await create(unusedToken, 'fresh-unknown-key')).toMatchObject({ status: 403, body: { reason: 'grant_disabled' } });
      expect(await fixture.client`SELECT event_key FROM events`).toEqual([]);
    } finally {
      await legacy.unsafe(`ALTER TABLE "${sourceSchema}".events RENAME COLUMN unknown_ownership TO agent_grant_id`);
      await removeUnusedGrant();
    }
  });

  it('rejects a cleartext verifier and rolls the entire destination back', async () => {
    await legacy.unsafe(`UPDATE "${sourceSchema}".agent_event_grants SET verifier_hash = 'synthetic-not-a-hash'
      WHERE id = '22222222-2222-4222-8222-222222222222'`);
    await expect(run({ dryRun: false })).rejects.toThrow('invalid_grant_digest');
    for (const name of names) {
      const [row] = await fixture.client.unsafe(`SELECT count(*)::int AS n FROM "${name}"`);
      expect(row!.n).toBe(0);
    }
  });

  it('excludes null and infinite replay timestamps from the retention window', async () => {
    await legacy.unsafe(`INSERT INTO "${sourceSchema}".agent_event_idempotency_keys
      (id, grant_id, key, payload_digest, status, body, created_at) VALUES
      (94003, '22222222-2222-4222-8222-222222222222', 'synthetic-negative-infinity', repeat('e', 64), 200, '{}', '-infinity'),
      (94004, '22222222-2222-4222-8222-222222222222', 'synthetic-positive-infinity', repeat('e', 64), 200, '{}', 'infinity'),
      (94005, '22222222-2222-4222-8222-222222222222', 'synthetic-null-time', repeat('e', 64), 200, '{}', NULL)`);
    try {
      const preview = await run();
      expect(preview.tables.agent_event_idempotency_keys).toMatchObject({ read: 5, would_insert: 1, expired: 4 });
      const applied = await run({ dryRun: false });
      expect(applied.tables.agent_event_idempotency_keys).toMatchObject({ read: 5, inserted: 1, expired: 4 });
      expect(await fixture.client`SELECT key FROM agent_event_idempotency_keys`).toEqual([{ key: 'synthetic-recent' }]);
    } finally {
      await legacy.unsafe(`DELETE FROM "${sourceSchema}".agent_event_idempotency_keys WHERE id IN (94003, 94004, 94005)`);
    }
  });

  it('keeps keys exactly at the retention boundary and skips older keys', async () => {
    await legacy.unsafe(`INSERT INTO "${sourceSchema}".agent_event_idempotency_keys
      (id, grant_id, key, payload_digest, status, body, created_at) VALUES
      (94003, '22222222-2222-4222-8222-222222222222', 'synthetic-boundary', repeat('e', 64), 200, '{}',
       timestamp '2026-09-30 00:00:00' - interval '90 days'),
      (94004, '22222222-2222-4222-8222-222222222222', 'synthetic-outside', repeat('f', 64), 200, '{}',
       timestamp '2026-09-30 00:00:00' - interval '90 days' - interval '1 microsecond')`);
    try {
      const result = await run({ dryRun: false });
      expect(result.tables.agent_event_idempotency_keys).toMatchObject({ read: 4, inserted: 2, expired: 2 });
      const rows = await fixture.client`SELECT key FROM agent_event_idempotency_keys ORDER BY key`;
      expect(rows.map((r) => r.key)).toEqual(['synthetic-boundary', 'synthetic-recent']);
    } finally {
      await legacy.unsafe(`DELETE FROM "${sourceSchema}".agent_event_idempotency_keys WHERE id IN (94003, 94004)`);
    }
  });
});
