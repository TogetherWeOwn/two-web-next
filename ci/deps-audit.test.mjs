import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
    assert.equal(evaluate(report).blocked.length, severity === 'critical' ? 1 : 0);
  }
});

test('unknown fixture and missing severity block', () => {
  assert.equal(evaluate(fixture('unknown')).blocked[0].severity, 'unknown');
  const report = fixture('high');
  delete report.vulnerabilities['fixture-package'].severity;
  assert.equal(evaluate(report, validException()).blocked[0].severity, 'unknown');
});

test('advisory severity cannot be hidden by the package severity', () => {
  const report = fixture('high');
  report.vulnerabilities['fixture-package'].severity = 'moderate';
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

test('CLI exit status: npm 0/1, findings, bad JSON, registry failure, and execution failure', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'deps-audit-'));
  try {
    const npm = join(dir, 'npm');
    writeFileSync(npm, `#!/bin/sh
[ "$*" = "audit --package-lock-only --json --include=prod --include=dev --include=optional --include=peer" ] || exit 9
printf '%s' "$AUDIT_FIXTURE"
exit "$AUDIT_STATUS"
`);
    chmodSync(npm, 0o700);
    const script = fileURLToPath(new URL('./deps-audit.mjs', import.meta.url));
    const moderate = fixture('high');
    moderate.vulnerabilities['fixture-package'].severity = 'moderate';
    moderate.vulnerabilities['fixture-package'].via[0].severity = 'moderate';
    for (const [report, npmStatus, expected] of [
      [JSON.stringify(fixture('clean')), 0, 0],
      [JSON.stringify(moderate), 1, 0],
      [JSON.stringify(fixture('high')), 1, 1],
      [JSON.stringify(fixture('unknown')), 1, 1],
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
