import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  REQUIRED_PRODUCTION_SECRETS,
  checkProductionSecrets,
  missingRequiredSecrets,
  parseSecretNames,
} from './check-production-secrets.mjs';

const allPresent = JSON.stringify([
  { name: 'SESSION_SECRET' },
  { name: 'DISCORD_CLIENT_SECRET' },
  { name: 'DISCORD_BOT_TOKEN' },
]);

test('all required secrets present passes and returns the required names', () => {
  assert.deepEqual(checkProductionSecrets(allPresent), [...REQUIRED_PRODUCTION_SECRETS]);
});

test('one missing secret fails and names only the missing secret', () => {
  for (const missing of REQUIRED_PRODUCTION_SECRETS) {
    const stub = JSON.stringify(
      REQUIRED_PRODUCTION_SECRETS.filter((name) => name !== missing).map((name) => ({ name })),
    );
    assert.throws(() => checkProductionSecrets(stub), (error) => {
      assert.match(error.message, /Missing production Worker secret/);
      assert.ok(error.message.includes(missing), `error must name ${missing}`);
      for (const present of REQUIRED_PRODUCTION_SECRETS.filter((name) => name !== missing)) {
        assert.ok(!error.message.includes(present), `error must not echo present secret ${present}`);
      }
      return true;
    });
  }
});

test('empty listing fails closed naming every required secret', () => {
  assert.throws(() => checkProductionSecrets('[]'), (error) => {
    for (const name of REQUIRED_PRODUCTION_SECRETS) {
      assert.ok(error.message.includes(name), `error must name ${name}`);
    }
    return true;
  });
});

for (const stub of [
  '',
  'not json',
  '{"name":"SESSION_SECRET"}',
  '"SESSION_SECRET"',
  'null',
  '[{}]',
  '[{"name":""}]',
  '[{"name":null}]',
  '[{"name":42}]',
  '[null]',
  '["SESSION_SECRET"]',
  `${allPresent} trailing`,
]) {
  test(`malformed wrangler output fails closed (${JSON.stringify(stub).slice(0, 60)})`, () => {
    assert.throws(() => checkProductionSecrets(stub), /Could not verify production Worker secrets/);
  });
}

test('extra fields that resemble values are ignored and never surface', () => {
  // If wrangler ever added value-bearing fields, they must not leak into
  // results, errors or CLI output. Fixture values are fake and never real.
  const stub = JSON.stringify([
    { name: 'SESSION_SECRET', value: 'fixture-fake-value-aaa' },
    { name: 'DISCORD_CLIENT_SECRET', secret: 'fixture-fake-value-bbb' },
    { name: 'DISCORD_BOT_TOKEN', extra: { nested: 'fixture-fake-value-ccc' } },
  ]);
  assert.deepEqual(checkProductionSecrets(stub), [...REQUIRED_PRODUCTION_SECRETS]);
  const names = parseSecretNames(stub);
  assert.equal(names.size, 3);
  const missing = missingRequiredSecrets(new Set(['SESSION_SECRET']));
  assert.deepEqual(missing, ['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN']);
  assert.throws(() => checkProductionSecrets(JSON.stringify([{ name: 'SESSION_SECRET', value: 'fixture-fake-value-aaa' }])), (error) => {
    assert.ok(!error.message.includes('fixture-fake-value'), 'error must never echo value-like fields');
    return true;
  });
});

function cliWithStubbedWrangler(stubStdout, { exitCode = 0 } = {}) {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'wrangler-stub-'));
  try {
    writeFileSync(join(scratch, 'npx'), `#!${process.execPath}
import { writeFileSync } from "node:fs";
const expected = ["wrangler", "secret", "list", "--env", "production", "--format", "json"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected wrangler invocation: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
process.stdout.write(process.env.STUB_STDOUT);
process.exit(Number(process.env.STUB_EXIT));
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['ci/check-production-secrets.mjs'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, STUB_STDOUT: stubStdout, STUB_EXIT: String(exitCode) },
    });
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('CLI passes with all secrets and prints names only, never wrangler output', () => {
  const result = cliWithStubbedWrangler(allPresent);
  assert.equal(result.status, 0);
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.equal(result.stderr, '');
});

test('CLI fails closed on a missing secret and on wrangler failure without echoing output', () => {
  const missing = cliWithStubbedWrangler(JSON.stringify([{ name: 'SESSION_SECRET' }]));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing production Worker secret.*DISCORD_CLIENT_SECRET.*DISCORD_BOT_TOKEN/);
  assert.ok(!missing.stderr.includes('SESSION_SECRET') || missing.stderr.includes('Missing'), 'stderr names only missing secrets');
  assert.equal(missing.stdout, '');

  const failed = cliWithStubbedWrangler('{"error":"fixture denied"}', { exitCode: 1 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not verify production Worker secrets/);
  assert.ok(!failed.stderr.includes('fixture denied'), 'wrangler output is never echoed');
  assert.equal(failed.stdout, '');
});

test('required-secrets preflight runs after the credentials check and before the moderator preflight and deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  const credentials = workflow.indexOf('run: node ci/production-deploy-gate.mjs --credentials');
  const secrets = workflow.indexOf('run: node ci/check-production-secrets.mjs');
  const moderator = workflow.indexOf('run: npm run check:worker-moderators-production');
  const deploy = workflow.indexOf('run: npx wrangler deploy --env production');
  assert.ok(credentials > 0 && secrets > 0 && moderator > 0 && deploy > 0, 'expected credentials, secrets, moderator and deploy steps in deploy-production.yml');
  assert.ok(credentials < secrets && secrets < moderator && moderator < deploy, 'order must be credentials check, required-secrets preflight, moderator preflight, deploy');
});

test('required-secrets preflight uses production-only credentials', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  const at = workflow.indexOf('run: node ci/check-production-secrets.mjs');
  assert.ok(at > 0, 'expected the required-secrets step in deploy-production.yml');
  const block = workflow.slice(at, at + 600);
  assert.ok(block.includes('secrets.PRODUCTION_CLOUDFLARE_API_TOKEN'));
  assert.ok(block.includes('secrets.PRODUCTION_CLOUDFLARE_ACCOUNT_ID'));
  assert.ok(!block.includes('secrets.CLOUDFLARE_API_TOKEN') || block.includes('secrets.PRODUCTION_CLOUDFLARE_API_TOKEN'));
  assert.ok(!/secrets\.(?!PRODUCTION_)CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/.test(block), 'secrets step must use production-only credentials');
});
