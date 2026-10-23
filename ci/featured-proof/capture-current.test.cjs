const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
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

// Preloaded only in the child process: fake browser reads are not layout or PNG evidence.
// The production CLI, fixture/hash checks, capture calls and report serialization all run unchanged.
function installFakePlaywright() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const Module = require('node:module');
  const originalLoad = Module._load;
  const chromium = { launch: async () => ({
    version: () => 'FAKE SELFTEST ONLY; no browser execution',
    close: async () => {},
    newContext: async ({ viewport }) => {
      let fixture;
      const calls = new Map();
      const locator = selector => ({
        locator,
        nth: () => locator(selector),
        focus: async () => {},
        isVisible: async () => true,
        count: async () => {
          if (selector === '[data-status]') return 4;
          if (selector === 'thead th') return 5;
          assert.equal(selector, '[data-testid="featured-item"]');
          assert.equal(fixture, 'scheduled.html');
          return 0;
        },
        innerText: async () => selector === '[data-testid="featured-preview"]'
          ? 'Save changes to refresh this preview' : selector.match(/^\[data-status="(\w+)"\]$/)[1],
        textContent: async () => {
          assert.ok(selector === 'h3' || selector === 'p');
          return selector === 'h3' ? 'a'.repeat(255) : `https://example.test/${'a'.repeat(400)}`;
        },
        evaluateAll: async () => true,
        evaluate: async () => selector === 'main' ? '24px'
          : selector === '[data-testid="featured-table-scroll"]' ? 1 : true,
      });
      return {
        route: async () => {},
        close: async () => {},
        newPage: async () => ({
          locator,
          keyboard: { press: async () => {} },
          setContent: async html => { fixture = html.match(/<title>([^<]+)<\/title>/)[1]; },
          evaluate: async () => ({ viewportWidth: viewport.width, documentWidth: viewport.width, elements: [] }),
          screenshot: async options => {
            assert.equal(options.fullPage, true);
            const name = path.basename(options.path);
            const count = (calls.get(name) || 0) + 1;
            calls.set(name, count);
            assert.ok(count <= 2, 'at most one retry per screenshot');
            if (count === 1) throw new Error(`page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - synthetic failure for ${name}`);
            return fs.writeFile(options.path, 'FAKE SELFTEST ONLY; not a PNG');
          },
        }),
      };
    },
  }) };
  Module._load = function(request, parent, isMain) {
    if (request === 'playwright') return { chromium };
    if (request === 'playwright/package.json') return { version: '1.58.2' };
    return originalLoad.call(this, request, parent, isMain);
  };
}

test('production CLI serializes every primary and scrolled retry with its original error', async t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.RUNNER_TEMP;
  assert.ok(base, 'Tests require run-owned scratch or CI RUNNER_TEMP');
  const dir = await fs.mkdtemp(path.join(base, 'capture-report-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input');
  const output = path.join(dir, 'output');
  await fs.mkdir(input);
  const sourceHead = 'a'.repeat(40);
  const names = ['edit', 'long-content', 'list', 'scheduled'];
  const fixtures = [];
  for (const name of names) {
    const html = `<title>${name}.html</title><main>synthetic driver fixture, not visual evidence</main>`;
    await fs.writeFile(path.join(input, `${name}.html`), html);
    fixtures.push({ name: `${name}.html`, sha256: createHash('sha256').update(html).digest('hex') });
  }
  const manifest = { sourceHead, fixtures };
  await fs.writeFile(path.join(input, 'manifest.json'), JSON.stringify(manifest));
  const preload = path.join(dir, 'fake-playwright.cjs');
  await fs.writeFile(preload, `(${installFakePlaywright.toString()})();\n`);
  const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'capture-current.cjs'), input, output], {
    encoding: 'utf8', timeout: 10000,
    env: { PROOF_CHECKOUT_HEAD: sourceHead, PROOF_RUN_URL: 'https://example.test/selftest', PROOF_CONTAINER_IMAGE: 'synthetic-selftest' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), { automatedChecksPassed: true, screenshots: 12, sourceHead });
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  const expected = [];
  for (const size of ['1280x900', '390x844']) {
    for (const name of names) {
      const screenshots = [`${name}-${size}.png`];
      if (name === 'list') screenshots.push(`list-window-${size}.png`, `list-last-changed-${size}.png`);
      for (const screenshot of screenshots) {
        expected.push(
          { screenshot, attempt: 1, success: false, error: `${protocolMessage}\nCall log:\n  - synthetic failure for ${screenshot}` },
          { screenshot, attempt: 2, success: true },
        );
        assert.equal(await fs.readFile(path.join(output, screenshot), 'utf8'), 'FAKE SELFTEST ONLY; not a PNG');
      }
    }
  }
  assert.deepEqual(report.captureAttempts, expected);
  assert.deepEqual(report.errors, []);
  assert.equal(report.results.length, 8);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')), manifest);
});

test('primary and scrolled captures use the helper and CI runs its regression tests', () => {
  const source = readFileSync(path.join(__dirname, 'capture-current.cjs'), 'utf8');
  assert.equal((source.match(/await page\.screenshot\(/g) || []).length, 1);
  assert.equal((source.match(/await captureScreenshot\(page, /g) || []).length, 2);
  const workflow = readFileSync(path.join(__dirname, '../../.github/workflows/featured-offline-proof.yml'), 'utf8');
  assert.ok(workflow.includes('node --test ci/featured-proof/run-capture.test.cjs ci/featured-proof/capture-current.test.cjs'));
});
