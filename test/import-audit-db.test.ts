import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from './helpers/member-data-db';
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

suite('audit import into the migrated Next schema (disposable test DB only)', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl(raw!);
    if (url.hostname === 'agent-testdb' && url.pathname !== '/two_web_next') {
      throw new Error('Audit fixtures require agent-testdb database two_web_next');
    }
    fixture = await createMemberDataFixture(raw!);
    legacy = postgres(url.href, {
      max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {},
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
    legacy, target: fixture.client, legacySchema: sourceSchema,
    targetSchema: fixture.schemaName, now, ...opts,
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

  it('enables only previously enabled legacy grants when explicitly requested', async () => {
    await run({ dryRun: false, enableGrants: true });
    const rows = await fixture.client`SELECT disabled_at FROM agent_event_grants ORDER BY id`;
    expect(rows[0]!.disabled_at).toBeNull();
    expect(rows[1]!.disabled_at).not.toBeNull();
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
