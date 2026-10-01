import assert from 'node:assert/strict';
import { it } from 'vitest';
import { databaseConfig, importAudit, safeFailure } from '../bin/import/audit.mjs';

// Callable transaction stubs model database-local locks, not database-name or
// URL equality. They open no connections and deliberately contain existing IDs:
// the old importer still changes sequence state after skipping every row.
function fixture({ sameDomain = true, sourceProbe, targetProbe } = {}) {
  const held = new Set();
  const events = [];
  const keys = [];
  const row = { id: '93001', description: 'Synthetic audit evidence', created_at: null, updated_at: null };
  const sequence = { last_value: '1', is_called: false };
  const beforeRows = JSON.stringify(row);
  const beforeSequence = JSON.stringify(sequence);
  const client = (side) => {
    const sql = async (strings, ...params) => {
      const query = strings.join('?');
      if (/pg_try_advisory_xact_lock/i.test(query)) {
        events.push(`${side}:probe`);
        keys.push(params[0]);
        const override = side === 'source' ? sourceProbe : targetProbe;
        if (override instanceof Error) throw override;
        if (override !== undefined) return override;
        const key = params[0];
        if (side === 'source') {
          held.add(key);
          return [{ acquired: true }];
        }
        return [{ acquired: !(sameDomain && held.has(key)) }];
      }
      if (/pg_get_serial_sequence/i.test(query)) return [{ name: 'synthetic_sequence' }];
      if (/SELECT/i.test(query)) {
        events.push('source:metadata-read');
        return [{ available: false }];
      }
      return [];
    };
    sql.unsafe = async (query, params = []) => {
      if (/^LOCK TABLE/.test(query)) {
        events.push('destination:table-lock');
        return [];
      }
      if (/^SELECT setval/.test(query)) {
        events.push('destination:sequence-write');
        sequence.last_value = row.id;
        sequence.is_called = true;
        return [];
      }
      if (/^SELECT id::text/.test(query)) return [{ id: row.id }];
      if (/^SELECT/.test(query)) {
        events.push('source:row-read');
        return query.includes('"activity_log" AS source') && params.length === 0 ? [{ ...row }] : [];
      }
      if (/^INSERT/.test(query)) throw new Error('unexpected_synthetic_insert');
      throw new Error('unexpected_synthetic_query');
    };
    // The query methods must come from these transaction callbacks, not the
    // outer pool: that is essential with transaction-pooling proxies.
    return {
      begin: async (_options, callback) => {
        events.push(`${side}:begin`);
        try { return await callback(sql); }
        finally { if (side === 'source') held.clear(); }
      },
    };
  };
  return {
    legacy: client('source'), target: client('destination'), events, keys,
    unchangedRows: () => JSON.stringify(row) === beforeRows,
    unchangedSequence: () => JSON.stringify(sequence) === beforeSequence,
  };
}

function assertUntouched(f) {
  assert.equal(f.unchangedRows(), true, 'source row values changed');
  assert.equal(f.unchangedSequence(), true, 'source sequence last_value/is_called changed');
  for (const event of ['destination:table-lock', 'destination:sequence-write', 'source:row-read', 'source:metadata-read']) {
    assert.equal(f.events.includes(event), false, `${event} occurred before refusal`);
  }
}

for (const dryRun of [true, false]) {
  it(`refuses different URL strings aliasing one schema (${dryRun ? 'preview' : 'apply'})`, async () => {
    const schemas = databaseConfig({
      LEGACY_DATABASE_URL: 'postgres://synthetic@source.invalid/same_named_db',
      DATABASE_URL: 'postgresql://synthetic@alias.invalid/same_named_db',
    });
    const f = fixture();
    let refused = false;
    try { await importAudit({ ...f, ...schemas, dryRun, enableGrants: true }); }
    catch { refused = true; }
    assertUntouched(f);
    assert.equal(refused, true, 'effective source alias was accepted');
    assert.deepEqual(f.events, ['source:begin', 'destination:begin', 'source:probe', 'destination:probe']);
  });

  for (const side of ['source', 'target']) {
    for (const [label, result] of [
      ['denied', [{ acquired: false }]], ['empty', []], ['missing field', [{}]],
      ['non-boolean', [{ acquired: 'true' }]],
      ['error', Object.assign(new Error('synthetic-row postgres://synthetic-password'), { code: '42501' })],
    ]) {
      it(`fails closed on ${side} identity ${label} (${dryRun ? 'preview' : 'apply'})`, async () => {
        const f = fixture({ sameDomain: false, [`${side}Probe`]: result });
        await assert.rejects(importAudit({ ...f, dryRun, enableGrants: true }), (error) => {
          assert.match(safeFailure(error), /^Audit import failed(?: \(SQLSTATE 42501\))?; no row data or connection details logged\.$/);
          return true;
        });
        assertUntouched(f);
        if (side === 'source') assert.equal(f.events.includes('destination:probe'), false);
      });
    }
  }

  it(`supports independent same-named lock domains (${dryRun ? 'preview' : 'apply'})`, async () => {
    const f = fixture({ sameDomain: false });
    const result = await importAudit({ ...f, dryRun });
    assert.equal(result.mode, dryRun ? 'dry-run' : 'apply');
    assert.equal(f.unchangedRows(), true);
    assert.equal(f.keys.length, 2);
    assert.equal(f.keys[0], f.keys[1]);
    assert.equal(typeof f.keys[0], 'string');
    assert(BigInt(f.keys[0]) >= -(2n ** 63n) && BigInt(f.keys[0]) < 2n ** 63n);
    assert(f.events.indexOf('destination:probe') < f.events.indexOf('source:row-read'));
    if (!dryRun) assert(f.events.indexOf('destination:probe') < f.events.indexOf('destination:table-lock'));
  });

  it(`supports separate schemas in one database (${dryRun ? 'preview' : 'apply'})`, async () => {
    const f = fixture();
    const result = await importAudit({ ...f, legacySchema: 'synthetic_source', targetSchema: 'synthetic_destination', dryRun });
    assert.equal(result.mode, dryRun ? 'dry-run' : 'apply');
    assert.equal(f.unchangedRows(), true);
    assert.deepEqual(f.keys, []);
  });
}

it('refuses schema identifiers that could truncate to the same PostgreSQL name before connecting', async () => {
  const prefix = 'a'.repeat(63);
  const schemas = { legacySchema: `${prefix}b`, targetSchema: `${prefix}c` };
  assert.throws(() => databaseConfig({
    LEGACY_DATABASE_URL: 'postgres://synthetic@source.invalid/same_named_db',
    DATABASE_URL: 'postgresql://synthetic@alias.invalid/same_named_db',
    LEGACY_DATABASE_SCHEMA: schemas.legacySchema, DATABASE_SCHEMA: schemas.targetSchema,
  }), /invalid_schema/);
  const f = fixture();
  await assert.rejects(importAudit({ ...f, ...schemas, dryRun: false }), /invalid_identifier/);
  assert.deepEqual(f.events, []);
});

it.each(['a'.repeat(63) + '\n', 'schema\n', 'schema\r\n', null, {}])('refuses noncanonical schema identifiers (%j)', async (schema) => {
  const f = fixture();
  await assert.rejects(importAudit({ ...f, legacySchema: schema, targetSchema: 'synthetic_destination' }), /invalid_identifier/);
  assert.deepEqual(f.events, []);
});

it('accepts the full 63-byte ASCII identifier boundary', () => {
  assert.deepEqual(databaseConfig({
    LEGACY_DATABASE_URL: 'postgres://synthetic@source.invalid/same_named_db',
    DATABASE_URL: 'postgresql://synthetic@alias.invalid/same_named_db',
    LEGACY_DATABASE_SCHEMA: 'a'.repeat(63), DATABASE_SCHEMA: 'b'.repeat(63),
  }), { legacySchema: 'a'.repeat(63), targetSchema: 'b'.repeat(63) });
});
