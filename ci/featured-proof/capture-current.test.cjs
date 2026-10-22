const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { captureScreenshot } = require('./capture-current.cjs');

const protocolMessage = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
const options = { path: '/proof/edit-1280x900.png', fullPage: true };

test('successful capture uses the original options once and records success', async () => {
  const attempts = [];
  let calls = 0;
  const png = Buffer.from('fixture result, not screenshot evidence');
  const page = { screenshot: async actual => {
    assert.equal(actual, options);
    calls++;
    return png;
  } };
  assert.equal(await captureScreenshot(page, options, attempts), png);
  assert.equal(calls, 1);
  assert.deepEqual(attempts, [{ screenshot: 'edit-1280x900.png', attempt: 1, success: true }]);
});

test('only the capture protocol error gets one retry on the same page and options', async () => {
  const attempts = [];
  let calls = 0;
  const error = new Error(`${protocolMessage}\nCall log:\n  - fonts loaded\n`);
  const page = { screenshot: async actual => {
    assert.equal(actual, options);
    if (++calls === 1) throw error;
    return 'captured';
  } };
  assert.equal(await captureScreenshot(page, options, attempts), 'captured');
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [
    { screenshot: 'edit-1280x900.png', attempt: 1, success: false, error: error.message },
    { screenshot: 'edit-1280x900.png', attempt: 2, success: true },
  ]);
});

test('persistent capture protocol errors fail closed after exactly two attempts', async () => {
  const attempts = [];
  const errors = [new Error(protocolMessage), new Error(`${protocolMessage}\nCall log: second attempt`)];
  let calls = 0;
  const page = { screenshot: async () => { throw errors[calls++]; } };
  await assert.rejects(captureScreenshot(page, options, attempts), error => error === errors[1]);
  assert.equal(calls, 2);
  assert.deepEqual(attempts.map(attempt => [attempt.attempt, attempt.success, attempt.error]), [
    [1, false, errors[0].message], [2, false, errors[1].message],
  ]);
});

for (const message of [
  'page.screenshot: Timeout 30000ms exceeded',
  'page.screenshot: Target page, context or browser has been closed',
  'page.screenshot: Protocol error (Page.captureScreenshot): Invalid parameters',
  `unrelated failure containing ${protocolMessage}`,
]) {
  test(`does not retry other failures: ${message}`, async () => {
    const attempts = [];
    const error = new Error(message);
    let calls = 0;
    const page = { screenshot: async () => { calls++; throw error; } };
    await assert.rejects(captureScreenshot(page, options, attempts), actual => actual === error);
    assert.equal(calls, 1);
    assert.deepEqual(attempts, [{ screenshot: 'edit-1280x900.png', attempt: 1, success: false, error: message }]);
  });
}

test('primary and scrolled captures use the helper and CI runs its regression tests', () => {
  const source = readFileSync(path.join(__dirname, 'capture-current.cjs'), 'utf8');
  assert.equal((source.match(/await page\.screenshot\(/g) || []).length, 1);
  assert.equal((source.match(/await captureScreenshot\(page, /g) || []).length, 2);
  const workflow = readFileSync(path.join(__dirname, '../../.github/workflows/featured-offline-proof.yml'), 'utf8');
  assert.ok(workflow.includes('node --test ci/featured-proof/run-capture.test.cjs ci/featured-proof/capture-current.test.cjs'));
});
