import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './deps-audit.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/deps-audit/${name}.json`, import.meta.url), 'utf8'));
const empty = { version: 1, exceptions: [] };
const today = '2026-09-30';
const evaluate = (report, allowlist = empty) => evaluateAudit(report, allowlist, today);
const validException = () => {
  const allowlist = fixture('expired-allowlist');
  allowlist.exceptions[0].expires = '2026-10-01';
  return allowlist;
};

test('clean fixture passes', () => {
  assert.deepEqual(evaluate(fixture('clean')), { blocked: [], allowed: [], nonBlocking: [] });
});

test('high fixture blocks', () => {
  assert.equal(evaluate(fixture('high')).blocked[0].severity, 'high');
});

test('critical blocks; info, low and moderate do not', () => {
  for (const severity of ['info', 'low', 'moderate', 'critical']) {
    const report = fixture('high');
    report.vulnerabilities['fixture-package'].severity = severity;
    report.vulnerabilities['fixture-package'].via[0].severity = severity;
    report.metadata.vulnerabilities.high = 0;
    report.metadata.vulnerabilities[severity] = 1;
    assert.equal(evaluate(report).blocked.length, severity === 'critical' ? 1 : 0);
  }
});

test('unknown fixture and unknown or missing package severity fail closed', () => {
  assert.throws(() => evaluate(fixture('unknown')), /count/);
  for (const severity of ['unrated', undefined]) {
    const report = fixture('high');
    report.vulnerabilities['fixture-package'].severity = severity;
    assert.throws(() => evaluate(report, validException()), /Unknown package severity/);
  }
});

test('advisory severity cannot be hidden by the package severity', () => {
  const report = fixture('high');
  report.vulnerabilities['fixture-package'].severity = 'moderate';
  report.metadata.vulnerabilities.high = 0;
  report.metadata.vulnerabilities.moderate = 1;
  assert.equal(evaluate(report).blocked[0].severity, 'high');
  report.vulnerabilities['fixture-package'].via[0].severity = 'unrated';
  assert.equal(evaluate(report, validException()).blocked[0].severity, 'unknown');
});

test('dated exception only permits the exact package, range, severity and advisories', () => {
  assert.equal(evaluate(fixture('high'), validException()).allowed.length, 1);
  for (const [key, value] of [['package', 'another-package'], ['range', '<3.0.0'], ['severity', 'critical'], ['advisoryIds', [100002]]]) {
    const allowlist = validException();
    allowlist.exceptions[0][key] = value;
    assert.equal(evaluate(fixture('high'), allowlist).blocked.length, 1);
  }
});

test('expired fixture blocks, including the expiry day and unused exceptions', () => {
  assert.throws(() => evaluate(fixture('high'), fixture('expired-allowlist')), /Expired/);
  assert.throws(() => evaluate(fixture('clean'), fixture('expired-allowlist')), /Expired/);
});

test('invalid dates, future review, missing reason, duplicates and unknown exemptions fail closed', () => {
  for (const [key, value] of [['reviewed', '2026-10-01'], ['expires', '2026-02-30'], ['reason', ' '], ['severity', 'unknown'], ['advisoryIds', []]]) {
    const allowlist = validException();
    allowlist.exceptions[0][key] = value;
    assert.throws(() => evaluate(fixture('high'), allowlist));
  }
  const duplicate = validException();
  duplicate.exceptions.push({ ...duplicate.exceptions[0] });
  assert.throws(() => evaluate(fixture('high'), duplicate), /Duplicate/);
  assert.throws(() => evaluate(fixture('clean'), {}), /allowlist/);
});

test('transitive advisories require their own exception and new IDs invalidate it', () => {
  const report = fixture('high');
  report.vulnerabilities.parent = { name: 'parent', range: '*', severity: 'high', via: ['fixture-package'] };
  report.metadata.vulnerabilities.total = 2;
  report.metadata.vulnerabilities.high = 2;
  const allowlist = validException();
  assert.deepEqual(evaluate(report, allowlist).blocked.map((v) => v.package), ['parent']);
  allowlist.exceptions.push({ ...allowlist.exceptions[0], package: 'parent', range: '*' });
  assert.equal(evaluate(report, allowlist).blocked.length, 0);
  report.vulnerabilities['fixture-package'].via.push({ source: 100002, severity: 'high' });
  assert.equal(evaluate(report, allowlist).blocked.length, 2);
});

test('malformed reports, registry errors, count mismatches and bad via references fail closed', () => {
  for (const report of [{}, [], { error: { code: 'E401' } }, { ...fixture('clean'), auditReportVersion: 1 },
    { ...fixture('clean'), metadata: { vulnerabilities: { total: 1 } } }]) {
    assert.throws(() => evaluate(report));
  }
  for (const via of [[], ['missing'], ['fixture-package'], [{}]]) {
    const report = fixture('high');
    report.vulnerabilities['fixture-package'].via = via;
    assert.throws(() => evaluate(report));
  }
});

test('every severity counter and total must be a non-negative safe integer', () => {
  for (const key of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    for (const value of [undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      const report = fixture('clean');
      report.metadata.vulnerabilities[key] = value;
      assert.throws(() => evaluate(report), /counter/, `${key}: ${String(value)}`);
    }
  }
});

test('severity counters must reconcile with total and individual package records', () => {
  const critical = fixture('clean');
  critical.metadata.vulnerabilities.critical = 1;
  assert.throws(() => evaluate(critical), /count/);

  const swapped = fixture('high');
  swapped.metadata.vulnerabilities = { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 };
  assert.throws(() => evaluate(swapped, validException()), /count/);

  const unexpected = fixture('clean');
  unexpected.metadata.vulnerabilities.unrated = 0;
  assert.throws(() => evaluate(unexpected), /counter/);
});

test('real npm ignores inherited offline configuration only when the gate forces online', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'deps-audit-online-'));
  const bulkBodies = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/-/npm/v1/security/advisories/bulk') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      bulkBodies.push(JSON.parse(request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body));
      response.end(JSON.stringify({ lodash: [{ id: 100001, title: 'Fixture advisory',
        url: 'https://example.invalid/advisory/100001', severity: 'high', vulnerable_versions: '<4.17.21',
        cwe: [], cvss: { score: 7.5, vectorString: null } }] }));
    } else if (request.url === '/lodash') {
      response.end(JSON.stringify({ name: 'lodash', 'dist-tags': { latest: '4.17.21' },
        versions: { '4.17.20': { name: 'lodash', version: '4.17.20' }, '4.17.21': { name: 'lodash', version: '4.17.21' } } }));
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const registry = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(dir, 'ci'));
    copyFileSync(new URL('./deps-audit.mjs', import.meta.url), join(dir, 'ci/deps-audit.mjs'));
    writeFileSync(join(dir, 'ci/deps-audit-allowlist.json'), JSON.stringify(empty));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'audit-regression', version: '1.0.0', dependencies: { lodash: '4.17.20' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'audit-regression', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'audit-regression', version: '1.0.0', dependencies: { lodash: '4.17.20' } },
        'node_modules/lodash': { version: '4.17.20', resolved: `${registry}/lodash/-/lodash-4.17.20.tgz` } } }));
    // npm's environment and .npmrc both enable the bypass without a CLI override.
    writeFileSync(join(dir, '.npmrc'), `offline=true\nregistry=${registry}\ncache=${join(dir, 'cache')}\n`);
    for (const offline of ['false', 'true', undefined]) {
      const before = bulkBodies.length;
      const env = { ...process.env, npm_config_registry: registry, npm_config_cache: join(dir, 'cache') };
      delete env.npm_config_offline;
      delete env.NPM_CONFIG_OFFLINE;
      if (offline !== undefined) env.npm_config_offline = offline;
      const child = spawn(process.execPath, [join(dir, 'ci/deps-audit.mjs')], {
        env,
        timeout: 15_000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const [status] = await once(child, 'close');
      assert.equal(status, 1, `offline=${offline}: ${stderr || stdout}`);
      assert.ok(bulkBodies.length > before, `offline=${offline}: registry was not consulted`);
      assert.deepEqual(bulkBodies[before], { lodash: ['4.17.20'] });
      assert.equal(JSON.parse(stdout).blocked[0].package, 'lodash');
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit status: npm 0/1, findings, bad JSON, registry failure, and execution failure', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'deps-audit-'));
  try {
    const npm = join(dir, 'npm');
    writeFileSync(npm, `#!/bin/sh
[ "$*" = "audit --offline=false --package-lock-only --json --include=prod --include=dev --include=optional --include=peer" ] || exit 9
printf '%s' "$AUDIT_FIXTURE"
exit "$AUDIT_STATUS"
`);
    chmodSync(npm, 0o700);
    const script = fileURLToPath(new URL('./deps-audit.mjs', import.meta.url));
    const moderate = fixture('high');
    moderate.vulnerabilities['fixture-package'].severity = 'moderate';
    moderate.vulnerabilities['fixture-package'].via[0].severity = 'moderate';
    moderate.metadata.vulnerabilities.high = 0;
    moderate.metadata.vulnerabilities.moderate = 1;
    const malformedCounters = fixture('clean');
    malformedCounters.metadata.vulnerabilities.critical = 1;
    for (const [report, npmStatus, expected] of [
      [JSON.stringify(fixture('clean')), 0, 0],
      [JSON.stringify(moderate), 1, 0],
      [JSON.stringify(fixture('high')), 1, 1],
      [JSON.stringify(fixture('unknown')), 1, 1],
      [JSON.stringify(malformedCounters), 0, 1],
      ['not json', 0, 1],
      [JSON.stringify({ error: { code: 'E401' } }), 1, 1],
      [JSON.stringify(fixture('clean')), 2, 1],
    ]) {
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, PATH: dir, AUDIT_FIXTURE: report, AUDIT_STATUS: String(npmStatus) }, encoding: 'utf8',
      });
      assert.equal(run.status, expected, run.stderr);
    }
    rmSync(npm);
    const missing = spawnSync(process.execPath, [script], { env: { ...process.env, PATH: dir }, encoding: 'utf8' });
    assert.equal(missing.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
