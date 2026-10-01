import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readWranglerConfig } from './wrangler-config.mjs';
import { assertProductionCredentials, assertProductionProtection, assertProductionTarget, checkProductionGate } from './production-deploy-gate.mjs';

const enabled = {
  PRODUCTION_DEPLOY_ENABLED: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'fixture/repo',
  GITHUB_TOKEN: 'fixture-only',
};
const protectedEnvironment = {
  name: 'production',
  protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: true,
    reviewers: [{ type: 'Team', reviewer: { id: 1 } }],
  }],
};
const noNetwork = () => { assert.fail('disabled/invalid requests must not reach the API'); };

for (const flag of [undefined, '', 'false', 'TRUE', '1', ' true', 'true ']) {
  test(`refuses flag ${JSON.stringify(flag)} before API access`, async () => {
    await assert.rejects(checkProductionGate({ ...enabled, PRODUCTION_DEPLOY_ENABLED: flag }, noNetwork), /deployment disabled/);
  });
}
for (const override of [
  { GITHUB_EVENT_NAME: 'push' },
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REF: 'refs/tags/main' },
]) {
  test(`refuses non-manual/non-main request ${JSON.stringify(override)}`, async () => {
    await assert.rejects(checkProductionGate({ ...enabled, ...override }, noNetwork), /workflow_dispatch on main/);
  });
}

test('CLI exits nonzero with an unset flag and no credentials', () => {
  const result = spawnSync(process.execPath, ['ci/production-deploy-gate.mjs'], {
    env: { PRODUCTION_DEPLOY_ENABLED: '', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment disabled/);
});

for (const status of [401, 403, 404, 500]) {
  test(`fails closed when Environment API returns ${status}`, async () => {
    await assert.rejects(checkProductionGate(enabled, async () => ({ ok: false, status })), new RegExp(`HTTP ${status}`));
  });
}

test('fails closed when Environment API is unavailable', async () => {
  await assert.rejects(checkProductionGate(enabled, async () => { throw new Error('network unavailable'); }), /network unavailable/);
});

test('requires a production Environment with reviewers and no self-review', () => {
  for (const environment of [
    { name: 'production', protection_rules: [] },
    { ...protectedEnvironment, name: 'staging' },
    { name: 'production', protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    { name: 'production', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Team' }], prevent_self_review: false }] },
  ]) {
    assert.throws(() => assertProductionProtection(environment), /required reviewers/);
  }
});

test('allows only an enabled main dispatch with verified protection', async () => {
  let requests = 0;
  await checkProductionGate(enabled, async (url) => {
    requests++;
    assert.equal(url, 'https://api.github.com/repos/fixture/repo/environments/production');
    return { ok: true, json: async () => protectedEnvironment };
  });
  assert.equal(requests, 1);
});

const sentinel = '00000000000000000000000000000000';
const provisionedId = '11111111111111111111111111111111';
const targetConfig = (hyperdrive) => JSON.stringify({ env: { production: { hyperdrive } } });

test('placeholder Hyperdrive refuses live deployment with fixture-only IDs', () => {
  assert.throws(() => assertProductionTarget(targetConfig([{ binding: 'DB', id: sentinel }])), /still a placeholder/);
  assert.doesNotThrow(() => assertProductionTarget(targetConfig([{ binding: 'DB', id: provisionedId }])));
});

for (const comment of ['/* inline comment */', '// line comment\n']) {
  test(`JSONC comments cannot hide the production placeholder (${JSON.stringify(comment)})`, () => {
    const config = `{"env":{"production":{"hyperdrive":[{"binding":"DB","id":${comment}"${sentinel}",},],},},}`;
    assert.throws(() => assertProductionTarget(config), /still a placeholder/);
  });
}

test('provisioned production DB ignores historical comments, unrelated zero IDs and quoted strings', () => {
  const config = `{
    // Historical placeholder: "id": "${sentinel}"
    /* "id": "${sentinel}" */
    "hyperdrive": [{"binding":"DB","id":"${sentinel}"}],
    "vars": {"APP_URL":"https://fixture.example/path//kept", "NOTE":${JSON.stringify(`historical "id": "${sentinel}" /* kept */ ,}`)}},
    "env": {"production": {"hyperdrive": [
      {"binding":"OTHER","id":"${sentinel}"},
      {"binding":"DB","id":/* reviewed replacement */"${provisionedId}",},
    ],},},
  }`;
  const parsed = readWranglerConfig(config);
  assert.equal(parsed.vars.APP_URL, 'https://fixture.example/path//kept');
  assert.equal(parsed.vars.NOTE, `historical "id": "${sentinel}" /* kept */ ,}`);
  assert.doesNotThrow(() => assertProductionTarget(config));
});

for (const hyperdrive of [
  undefined, null, {}, [], [{ binding: 'OTHER', id: provisionedId }],
  [{ binding: 'DB' }], [{ binding: 'DB', id: null }],
  [{ binding: 'DB', id: [provisionedId] }],
  [{ binding: 'DB', id: 'not-an-id' }],
  [{ binding: 'DB', id: `${provisionedId}0` }],
  [{ binding: 'DB', id: ` ${provisionedId}` }],
  [{ binding: 'DB', id: provisionedId }, { binding: 'DB', id: provisionedId }],
]) {
  test(`refuses missing, invalid or duplicate production DB bindings (${JSON.stringify(hyperdrive)})`, () => {
    assert.throws(() => assertProductionTarget(targetConfig(hyperdrive)), /one valid id/);
  });
}

for (const config of [
  '{}', '{"hyperdrive":[{"binding":"DB","id":"11111111111111111111111111111111"}]}',
  '{"env":{"staging":{"hyperdrive":[{"binding":"DB","id":"11111111111111111111111111111111"}]}}}',
]) {
  test(`refuses configs without an explicit production DB (${config})`, () => {
    assert.throws(() => assertProductionTarget(config), /one valid id/);
  });
}

for (const config of ['{"env":', '/* unterminated', `${targetConfig([{ binding: 'DB', id: provisionedId }])} trailing`]) {
  test(`malformed JSONC fails closed (${config})`, () => {
    assert.throws(() => assertProductionTarget(config), SyntaxError);
  });
}

function assertIsolatedBindings(config) {
  const production = config.env.production;
  assert.notEqual(production.name, config.name);
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
  assert.deepEqual(production.routes, [{ pattern: 'togetherweown.com', custom_domain: true }]);
  assert.equal(production.vars.APP_URL, 'https://togetherweown.com');
  assert.equal(production.vars.QA_AUTH_TOKEN, undefined);
  assert.notEqual(production.hyperdrive[0].id, config.hyperdrive[0].id);
  assert.deepEqual(production.triggers, config.triggers);
  const stagingQueues = config.queues.producers.map((producer) => producer.queue);
  for (const producer of production.queues.producers) {
    assert.ok(!stagingQueues.includes(producer.queue));
    assert.ok(production.queues.consumers.some((consumer) => consumer.queue === producer.queue));
  }
}

test('actual production config retains isolated bindings before and after sentinel replacement', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = readWranglerConfig(text);
  assertIsolatedBindings(config);
  const provisioned = structuredClone(config);
  provisioned.env.production.hyperdrive[0].id = '11111111111111111111111111111111';
  assertIsolatedBindings(provisioned);
  assert.doesNotThrow(() => assertProductionTarget(JSON.stringify(provisioned)));
});

test('preserves the owner exception for admin bypass without relaxing self-review protection', () => {
  for (const can_admins_bypass of [true, false]) {
    const environment = { ...protectedEnvironment, can_admins_bypass };
    assert.doesNotThrow(() => assertProductionProtection(environment));
    assert.throws(() => assertProductionProtection({
      ...environment,
      protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }],
    }), /required reviewers/);
  }
});

const credentials = { CLOUDFLARE_API_TOKEN: 'fixture-only', CLOUDFLARE_ACCOUNT_ID: 'fixture-account' };
for (const key of Object.keys(credentials)) {
  for (const value of [undefined, '', '   ']) {
    test(`refuses missing/empty production credential ${key}=${JSON.stringify(value)}`, () => {
      assert.throws(() => assertProductionCredentials({ ...credentials, [key]: value }), /Production-only Cloudflare credentials/);
    });
  }
}

test('credential CLI fails closed without printing credentials or accessing the API', () => {
  const missing = spawnSync(process.execPath, ['ci/production-deploy-gate.mjs', '--credentials'], {
    env: { CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN }, encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Production-only Cloudflare credentials/);
  assert.ok(!missing.stderr.includes(credentials.CLOUDFLARE_API_TOKEN));
  const present = spawnSync(process.execPath, ['ci/production-deploy-gate.mjs', '--credentials'], {
    env: credentials, encoding: 'utf8',
  });
  assert.equal(present.status, 0);
  assert.ok(!present.stdout.includes(credentials.CLOUDFLARE_API_TOKEN));
  assert.ok(!present.stdout.includes(credentials.CLOUDFLARE_ACCOUNT_ID));
});

test('both Environment gate jobs inherit contents and Actions read permissions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n/m);
  assert.ok(!/^ {4,}permissions:/m.test(workflow), 'job overrides must not drop inherited Actions read');
  assert.match(workflow, /^  preflight:/m);
  assert.match(workflow, /^  deploy-production:/m);
  assert.equal((workflow.match(/run: node ci\/production-deploy-gate\.mjs\n/g) ?? []).length, 2);
});

test('manual production workflow uses private-repo runners and production-only secrets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/runs-on: \[self-hosted, two-selfhosted\]/g) ?? []).length, 2);
  assert.ok(!workflow.includes('ubuntu-latest'));
  assert.ok(!workflow.includes('secrets.CLOUDFLARE_API_TOKEN'));
  assert.ok(!workflow.includes('secrets.CLOUDFLARE_ACCOUNT_ID'));
  for (const key of Object.keys(credentials)) {
    assert.equal((workflow.match(new RegExp(`secrets\\.PRODUCTION_${key}`, 'g')) ?? []).length, 2);
  }
  const credentialCheck = workflow.indexOf('run: node ci/production-deploy-gate.mjs --credentials');
  const deploy = workflow.indexOf('run: npx wrangler deploy --env production');
  assert.ok(credentialCheck > 0 && credentialCheck < deploy);
});
