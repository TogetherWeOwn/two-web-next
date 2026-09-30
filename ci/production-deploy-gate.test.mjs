import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { assertProductionProtection, assertProductionTarget, checkProductionGate } from './production-deploy-gate.mjs';

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

test('placeholder Hyperdrive refuses live deployment but config retains isolated bindings', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.throws(() => assertProductionTarget(text), /still a placeholder/);
  assert.doesNotThrow(() => assertProductionTarget('"id": "11111111111111111111111111111111"'));
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
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
});
