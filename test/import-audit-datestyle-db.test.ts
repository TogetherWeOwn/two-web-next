import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from './helpers/member-data-db';
import { AUDIT_TABLES, truncateLiftingAuditGuard } from './helpers/audit-rows';
// @ts-expect-error Standalone operator CLI has no declaration file.
import { importAudit } from '../bin/import/audit.mjs';

const raw = process.env.AUDIT_IMPORT_TEST_DATABASE_URL;
const suite = raw ? describe : describe.skip;
const now = new Date('2026-09-30T00:00:00Z');
const sourceSchema = `legacy_audit_style_${randomUUID().replaceAll('-', '')}`;
const timestamps = {
  member_data_access_logs: ['occurred_at'],
  activity_log: ['created_at', 'updated_at'],
  agent_event_grants: ['expires_at', 'disabled_at', 'created_at', 'updated_at'],
  agent_event_audits: ['created_at', 'updated_at'],
  agent_event_idempotency_keys: ['created_at', 'updated_at'],
};
const tables = Object.keys(timestamps);
const styles = [
  { label: 'source-only', source: 'SQL, DMY', target: 'ISO, MDY' },
  { label: 'destination-only', source: 'ISO, MDY', target: 'SQL, DMY' },
  { label: 'DMY source / MDY destination', source: 'SQL, DMY', target: 'SQL, MDY' },
  { label: 'MDY source / DMY destination', source: 'SQL, MDY', target: 'SQL, DMY' },
];
let fixture: MemberDataFixture;
let legacy: ReturnType<typeof postgres>;
let target: ReturnType<typeof postgres>;

suite('audit import DateStyle boundary (disposable test DB only)', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl(raw!);
    if (url.hostname === 'agent-testdb' && url.pathname !== '/two_web_next') {
      throw new Error('Audit fixtures require agent-testdb database two_web_next');
    }
    fixture = await createMemberDataFixture(raw!);
    const options = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {} };
    // Raw, directly supplied clients: neither inherits the fixture's Drizzle serializers.
    legacy = postgres(url.href, { ...options, connection: { timezone: 'Pacific/Honolulu' } });
    target = postgres(url.href, { ...options, connection: { timezone: 'Asia/Tokyo' } });
    const ddl = await readFile(new URL('./fixtures/legacy/audit.sql', import.meta.url), 'utf8');
    await legacy.unsafe(ddl.replaceAll('CREATE SCHEMA legacy;', `CREATE SCHEMA "${sourceSchema}";`)
      .replaceAll('legacy.', `"${sourceSchema}".`));
  });

  afterAll(async () => {
    try {
      if (legacy) await legacy.unsafe(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    } finally {
      await legacy?.end();
      await target?.end();
      await fixture?.dispose();
    }
  });

  beforeEach(async () => {
    // Owner-only reset of this suite's schema; lifts the audit TRUNCATE guard (drizzle/1018).
    await truncateLiftingAuditGuard(fixture.client, AUDIT_TABLES,
      `TRUNCATE ${tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`);
  });

  const run = (dryRun = true) => importAudit({
    legacy, target, legacySchema: sourceSchema, targetSchema: fixture.schemaName, now, dryRun,
  });

  const snapshot = () => fixture.client.begin(async (observer) => {
    await observer`SET LOCAL TIME ZONE 'UTC'`;
    const rows = [];
    for (const name of tables) {
      rows.push([...await observer.unsafe(`SELECT to_jsonb(t)::text AS evidence FROM "${name}" t ORDER BY id`)]);
    }
    return rows;
  });

  const sequences = async () => {
    const rows = [];
    for (const name of tables.filter((name) => name !== 'agent_event_grants')) {
      rows.push([...await fixture.client.unsafe(`SELECT last_value::text, is_called FROM "${name}_id_seq"`)]);
    }
    return rows;
  };

  for (const style of styles) {
    it.each(['2026-09-07 10:11:12.123456', '2026-09-19 10:11:12.654321'])(
      `preserves UTC microseconds for ${style.label}: %s through preview, apply and replay`, async (stamp) => {
        // Reuse the full legacy fixture, with both ambiguous and day>12 dates in
        // every non-null timestamp column. Keep the old replay key expired.
        for (const [name, columns] of Object.entries(timestamps)) {
          const assignments = columns.map((column) =>
            `"${column}" = CASE WHEN "${column}" IS NULL THEN NULL ELSE $1::text::timestamp END`).join(', ');
          await legacy.unsafe(`UPDATE "${sourceSchema}"."${name}" SET ${assignments}
            ${name === 'agent_event_idempotency_keys' ? 'WHERE id <> 94002' : ''}`, [stamp]);
        }
        await legacy`SELECT set_config('DateStyle', ${style.source}, false)`;
        await target`SELECT set_config('DateStyle', ${style.target}, false)`;
        await fixture.client`INSERT INTO activity_log (id, description, created_at)
          VALUES (93999, 'Synthetic Next-only evidence', timestamptz '2026-09-03 01:02:03.987654+00')`;
        const before = await snapshot();
        const sequenceBefore = await sequences();
        const preview = await run();
        for (const name of tables) expect(preview.tables[name]).toMatchObject({
          read: 2, inserted: 0, updated: 0, would_insert: name === 'agent_event_idempotency_keys' ? 1 : 2,
        });
        expect(preview.tables.agent_event_idempotency_keys.expired).toBe(1);
        expect(await snapshot()).toEqual(before);
        expect(await sequences()).toEqual(sequenceBefore);

        const applied = await run(false);
        for (const name of tables) expect(applied.tables[name]).toMatchObject({
          inserted: name === 'agent_event_idempotency_keys' ? 1 : 2, updated: 0,
        });
        // Postgres formats all six fractional digits; never compare JS Dates.
        for (const [name, columns] of Object.entries(timestamps)) {
          const projection = (destination: boolean) => columns.map((column) => {
            const value = destination ? `"${column}" AT TIME ZONE 'UTC'` : `"${column}"`;
            return `to_char(${value}, 'YYYY-MM-DD HH24:MI:SS.US') AS "${column}"`;
          }).join(', ');
          const expected = [...await legacy.unsafe(`SELECT id::text, ${projection(false)}
            FROM "${sourceSchema}"."${name}" ${name === 'agent_event_idempotency_keys' ? 'WHERE id <> 94002' : ''}
            ORDER BY id`)];
          for (const row of expected) {
            for (const column of columns) {
              if (row[column] !== null) expect(row[column], `source ${name}.${column}`).toBe(stamp);
            }
          }
          if (name === 'agent_event_grants') {
            for (const row of expected) row.disabled_at ??= '2026-09-30 00:00:00.000000';
          }
          const actual = await fixture.client.unsafe(`SELECT id::text, ${projection(true)}
            FROM "${name}" ${name === 'activity_log' ? 'WHERE id <> 93999' : ''} ORDER BY id`);
          expect([...actual], name).toEqual(expected);
        }
        expect(await fixture.client`SELECT description,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created
          FROM activity_log WHERE id = 93999`).toEqual([
          { description: 'Synthetic Next-only evidence', created: '2026-09-03 01:02:03.987654' },
        ]);
        const evidence = await snapshot();
        const again = await run(false);
        for (const name of tables) expect(again.tables[name]).toMatchObject({ inserted: 0, updated: 0 });
        expect(await snapshot()).toEqual(evidence);
        // SET LOCAL must not overwrite either caller's pooled session defaults.
        expect((await legacy`SHOW DateStyle`)[0]!.DateStyle).toBe(style.source);
        expect((await target`SHOW DateStyle`)[0]!.DateStyle).toBe(style.target);
      }, 20000,
    );
  }
});
