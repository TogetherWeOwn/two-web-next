#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { defaultTableMap } from './verify-map.mjs';

const identifier = /^[a-z_][a-z0-9_]*$/;
const fail = (code) => { throw new VerificationError(code); };
export class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function quoteIdentifier(value) {
  if (typeof value !== 'string' || !identifier.test(value)) fail('invalid_identifier');
  return `"${value}"`;
}

// Maps are trusted SQL configuration, not data or command-line SQL. Both
// connections enforce read-only transactions, including custom projections.
export function validateMap(map) {
  if (!Array.isArray(map) || map.length === 0) fail('invalid_map');
  const names = new Set();
  for (const table of map) {
    quoteIdentifier(table.name);
    if (names.has(table.name)) fail('duplicate_table');
    names.add(table.name);
    if (!Array.isArray(table.keys) || table.keys.length === 0 ||
        !Array.isArray(table.columns) || table.columns.length === 0) fail('invalid_map');
    const fields = new Set();
    for (const field of [...table.keys, ...table.columns]) {
      quoteIdentifier(field.name);
      if (fields.has(field.name)) fail('duplicate_field');
      fields.add(field.name);
      for (const side of ['legacy', 'next']) {
        if (typeof field[side] !== 'string' || !field[side].trim()) fail('invalid_map');
      }
    }
    if (table.mappingGaps !== undefined && (!Array.isArray(table.mappingGaps) ||
        table.mappingGaps.some((gap) => typeof gap !== 'string'))) fail('invalid_map');
    for (const side of ['legacy', 'next']) {
      if (typeof table[side]?.from !== 'string' || !table[side].from.trim()) fail('invalid_map');
      if (table[side].where !== undefined && typeof table[side].where !== 'string') fail('invalid_map');
    }
  }
  return map;
}

// Static same-database refusal: normalized host/port/dbname compare. This runs
// on validated URLs before the map loads and before any connection opens, so a
// same-DB invocation can never read-only report MATCH. Usernames, passwords and
// query parameters never distinguish one database from another. DNS aliases can
// still resolve distinct strings to one database; the importers pair this with
// a live lock-domain probe, while verify stays a pure URL-identity check.
export function assertDistinctDatabases(legacyRaw, nextRaw) {
  const endpoint = (raw) => {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('invalid_connection_environment');
    return JSON.stringify([url.hostname.toLowerCase(), url.port || '5432',
      decodeURIComponent(url.pathname)]);
  };
  try {
    if (endpoint(legacyRaw) === endpoint(nextRaw)) fail('same_database');
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('invalid_connection_environment');
  }
}

function projection(table, side) {
  const keys = table.keys.map((f, i) => `(${f[side]})::text COLLATE "C" AS k${i}`);
  // Keep SQL NULL distinct from JSON null with a discriminator per field.
  const values = table.columns.map((f) => `jsonb_build_array((${f[side]}) IS NULL, (${f[side]}))`);
  const where = table[side].where ? ` WHERE ${table[side].where}` : '';
  // JSONB renders object properties deterministically and preserves numeric and
  // timestamp precision in Postgres; never round-trip values through JS types.
  return `SELECT ${keys.join(', ')}, jsonb_build_array(${values.join(', ')})::text AS payload ` +
    `FROM ${table[side].from}${where} ORDER BY ${table.keys.map((_, i) => `k${i}`).join(', ')}`;
}

export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const comparison = Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]));
    if (comparison) return comparison;
  }
  return 0;
}

function canonicalJsonbText(payload) {
  // Postgres JSONB prints numbers as exact decimals (including exponent inputs).
  // Strip insignificant scale lexically, never via JS Number/JSON.parse. Match
  // whole strings first so quoted numbers and escaped quotes remain untouched.
  return payload.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?/g, (token) => {
    if (token.startsWith('"') || !token.includes('.')) return token;
    const value = token.replace(/0+$/, '').replace(/\.$/, '');
    return value === '-0' ? '0' : value;
  });
}

async function* rows(tx, table, side, batchSize) {
  await tx.unsafe(`DECLARE verification_rows NO SCROLL CURSOR FOR ${projection(table, side)}`);
  let previous;
  try {
    for (;;) {
      const batch = await tx.unsafe(`FETCH FORWARD ${batchSize} FROM verification_rows`);
      if (!batch.length) break;
      for (const row of batch) {
        const key = table.keys.map((_, i) => row[`k${i}`]);
        if (key.some((part) => part === null)) fail('null_key');
        if (previous && compareKeys(previous, key) >= 0) fail('duplicate_or_unordered_key');
        previous = key;
        yield { key, hash: createHash('sha256').update(canonicalJsonbText(row.payload)).digest('hex') };
      }
    }
  } finally {
    await tx.unsafe('CLOSE verification_rows');
  }
}

async function compareTable(legacy, next, table, batchSize, detailLimit) {
  const result = {
    table: table.name, keyColumns: table.keys.map((f) => f.name),
    comparedColumns: table.columns.map((f) => f.name), legacyCount: 0, nextCount: 0,
    missingCount: 0, extraCount: 0, mismatchCount: 0,
    missingKeys: [], extraKeys: [], mismatchKeys: [], mappingGaps: table.mappingGaps ?? [],
  };
  const left = rows(legacy, table, 'legacy', batchSize);
  const right = rows(next, table, 'next', batchSize);
  const record = (kind, key) => {
    result[`${kind}Count`]++;
    if (result[`${kind}Keys`].length < detailLimit) result[`${kind}Keys`].push(key);
  };
  let a = await left.next();
  let b = await right.next();
  try {
    while (!a.done || !b.done) {
      const order = a.done ? 1 : b.done ? -1 : compareKeys(a.value.key, b.value.key);
      if (order < 0) {
        record('missing', a.value.key);
        result.legacyCount++;
        a = await left.next();
      } else if (order > 0) {
        record('extra', b.value.key);
        result.nextCount++;
        b = await right.next();
      } else {
        if (a.value.hash !== b.value.hash) record('mismatch', a.value.key);
        result.legacyCount++;
        result.nextCount++;
        a = await left.next();
        b = await right.next();
      }
    }
  } finally {
    await Promise.all([left.return(), right.return()]);
  }
  result.detailsTruncated = ['missing', 'extra', 'mismatch'].some((kind) =>
    result[`${kind}Count`] > result[`${kind}Keys`].length);
  return result;
}

export async function verify({ legacy, next, map, batchSize = 1000, detailLimit = 100 }) {
  validateMap(map);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000 ||
      !Number.isSafeInteger(detailLimit) || detailLimit < 0 || detailLimit > 10000) fail('invalid_limit');
  // Each side has one consistent snapshot covering all tables. The cutover
  // operator must freeze writers: two independent DB snapshots are not atomic.
  return legacy.begin('isolation level repeatable read read only', async (left) =>
    next.begin('isolation level repeatable read read only', async (right) => {
      for (const tx of [left, right]) {
        await tx.unsafe("SET LOCAL TIME ZONE 'UTC'");
        await tx.unsafe("SET LOCAL statement_timeout = '60s'");
      }
      const tables = [];
      for (const table of map) tables.push(await compareTable(left, right, table, batchSize, detailLimit));
      return { version: 1, ok: tables.every((t) => !t.missingCount && !t.extraCount && !t.mismatchCount && !t.mappingGaps.length),
        batchSize, detailLimit, tables };
    }));
}

function markdownText(value) {
  return JSON.stringify(value).replace(/[&<>|`\r\n]/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderMarkdown(report) {
  const lines = ['# Import verification', '', `Result: **${report.ok ? 'MATCH' : 'DIFF'}**`, '',
    '| Table | Legacy rows | Next rows | Missing | Extra | Hash mismatches |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const t of report.tables) {
    lines.push(`| ${t.table} | ${t.legacyCount} | ${t.nextCount} | ${t.missingCount} | ${t.extraCount} | ${t.mismatchCount} |`);
  }
  for (const t of report.tables) {
    lines.push('', `## ${t.table}`, '', `Key columns: ${t.keyColumns.join(', ')}`);
    for (const kind of ['missing', 'extra', 'mismatch']) {
      for (const key of t[`${kind}Keys`]) lines.push(`- ${kind}: ${markdownText(key)}`);
    }
    for (const gap of t.mappingGaps) lines.push(`- Incomplete mapping: ${markdownText(gap)}`);
    if (t.detailsTruncated) lines.push(`- Key samples limited to ${report.detailLimit} per diff type; counts include every row.`);
  }
  return lines.join('\n') + '\n';
}

function parseArgs(args) {
  const options = { batchSize: 1000, detailLimit: 100, legacySchema: 'public', nextSchema: 'public' };
  const names = { '--map': 'mapPath', '--json': 'jsonPath', '--markdown': 'markdownPath',
    '--batch-size': 'batchSize', '--detail-limit': 'detailLimit',
    '--legacy-schema': 'legacySchema', '--next-schema': 'nextSchema', '--cutoff': 'cutoff' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    const name = names[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid_arguments');
    options[name] = ['batchSize', 'detailLimit'].includes(name) ? Number(args[++i]) : args[++i];
  }
  if (options.jsonPath && options.markdownPath &&
      resolve(options.jsonPath) === resolve(options.markdownPath)) fail('duplicate_output_path');
  quoteIdentifier(options.legacySchema);
  quoteIdentifier(options.nextSchema);
  return options;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let legacy;
  let next;
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log('verify.mjs [--map trusted-map.json] [--legacy-schema public] [--next-schema public]\n' +
        '  --cutoff ISO-UTC --batch-size 1000 --detail-limit 100 --json report.json --markdown report.md\n' +
        'Connections: LEGACY_DATABASE_URL and DATABASE_URL (environment only). Exit: 0 match, 1 diff, 2 error.');
      return 0;
    }
    if (!env.LEGACY_DATABASE_URL || !env.DATABASE_URL) fail('missing_connection_environment');
    const map = validateMap(options.mapPath ? JSON.parse(await readFile(options.mapPath, 'utf8')) :
      defaultTableMap(options));
    // Notices and driver errors can contain SQL values/URLs. Never print them.
    // Validate both endpoints before refusing or connecting: per-parameter
    // channel-binding errors must win over the same-database refusal.
    const parse = (raw) => {
      const url = new URL(raw);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
          !url.username || url.pathname.length < 2) fail('invalid_connection_environment');
      // postgres.js supports SCRAM but not SCRAM-SHA-256-PLUS. Never silently
      // discard a required channel binding; optional libpq settings are not GUCs.
      const binding = url.searchParams.getAll('channel_binding');
      if (binding.includes('require')) fail('unsupported_channel_binding_required');
      if (binding.some((value) => !['prefer', 'disable'].includes(value))) fail('invalid_channel_binding');
      url.searchParams.delete('channel_binding');
      return url;
    };
    const legacyUrl = parse(env.LEGACY_DATABASE_URL);
    const nextUrl = parse(env.DATABASE_URL);
    // Refuse before opening any connection: pointed at one database twice,
    // verify would read-only report MATCH.
    assertDistinctDatabases(legacyUrl.href, nextUrl.href);
    const connect = (url) =>
      postgres(url.href, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {},
        host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
        database: decodeURIComponent(url.pathname.slice(1)), password: () => decodeURIComponent(url.password) });
    legacy = connect(legacyUrl);
    next = connect(nextUrl);
    const report = await verify({ legacy, next, map, ...options });
    const json = JSON.stringify(report, null, 2) + '\n';
    const markdown = renderMarkdown(report);
    if (options.jsonPath) await writeFile(options.jsonPath, json, { mode: 0o600 });
    if (options.markdownPath) await writeFile(options.markdownPath, markdown, { mode: 0o600 });
    console.log(json.trimEnd());
    if (!options.markdownPath) console.log(markdown.trimEnd());
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`Verification failed: ${error instanceof VerificationError ? error.code : 'operation_failed'}`);
    return 2;
  } finally {
    await Promise.allSettled([legacy?.end({ timeout: 1 }), next?.end({ timeout: 1 })]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
