const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { captureViewWithRecovery, MAX_VIEW_RECOVERIES } = require('./capture-current.cjs');

const protocolMessage = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
const view = { fixture: 'long-content.html', viewport: { width: 1280, height: 900 } };
const captureFailure = (overrides = {}) => Object.assign(new Error(`${protocolMessage}\nCall log:\n  - fonts loaded\n`), {
  captureFailure: { checks: [{ name: 'saved live card', pass: true }], attemptedRequests: [], diagnostics: { browserConnected: true }, ...overrides },
});

function harness(attempts) {
  const calls = { attempt: 0, relaunch: 0 };
  const recoveries = [];
  const run = () => captureViewWithRecovery({
    view, recoveries,
    attemptView: async () => { const outcome = attempts[calls.attempt++]; if (outcome instanceof Error) throw outcome; return outcome; },
    relaunch: async () => { calls.relaunch++; },
  });
  return { calls, recoveries, run };
}

test('a view that captures first time never relaunches', async () => {
  const h = harness([{ ok: 1 }]);
  assert.deepEqual(await h.run(), { result: { ok: 1 } });
  assert.deepEqual([h.calls.attempt, h.calls.relaunch, h.recoveries.length], [1, 0, 0]);
});

test('persistent same-page capture failure reruns the whole view once in a fresh browser', async () => {
  const first = captureFailure();
  const h = harness([first, { ok: 2 }]);
  assert.deepEqual(await h.run(), { result: { ok: 2 } });
  assert.deepEqual([h.calls.attempt, h.calls.relaunch], [2, 1]);
  assert.deepEqual(h.recoveries, [{ ...view, firstError: first.message, ...first.captureFailure, outcome: 'recovered' }]);
});

test('a capture that fails again in the fresh browser stays an error', async () => {
  const second = captureFailure();
  const h = harness([captureFailure(), second]);
  assert.deepEqual(await h.run(), { error: second });
  assert.deepEqual([h.calls.attempt, h.calls.relaunch], [2, 1]);
  assert.deepEqual([h.recoveries[0].outcome, h.recoveries[0].secondError], ['failed', second.message]);
});

test('a failed relaunch stays an error', async () => {
  const boom = new Error('Relaunched browser version changed');
  const recoveries = [];
  const out = await captureViewWithRecovery({
    view, recoveries, attemptView: async () => { throw captureFailure(); }, relaunch: async () => { throw boom; },
  });
  assert.deepEqual(out, { error: boom });
  assert.equal(recoveries[0].outcome, 'failed');
});

for (const [name, error] of [
  ['timeout', Object.assign(new Error('page.screenshot: Timeout 30000ms exceeded'), { captureFailure: undefined })],
  ['other protocol error', new Error('page.screenshot: Protocol error (Page.captureScreenshot): Invalid parameters')],
  ['assertion', new Error('expect(received).toBe(expected)')],
  ['capture error before any recorded checks', captureFailure({ checks: [] })],
  ['failed pre-screenshot check', captureFailure({ checks: [{ name: 'long h3 wraps inside card', pass: false }] })],
  ['attempted network request', captureFailure({ attemptedRequests: ['https://example.test/x.png'] })],
]) {
  test(`does not recover: ${name}`, async () => {
    const h = harness([error, { ok: 'must not run' }]);
    assert.deepEqual(await h.run(), { error });
    assert.deepEqual([h.calls.attempt, h.calls.relaunch, h.recoveries.length], [1, 0, 0]);
  });
}

test(`recovery is capped at ${MAX_VIEW_RECOVERIES} views per run`, async () => {
  const recoveries = [];
  let attempts = 0;
  const relaunches = [];
  const run = () => captureViewWithRecovery({
    view, recoveries, relaunch: async () => { relaunches.push(attempts); },
    attemptView: async () => { if (++attempts % 2) throw captureFailure(); return { ok: true }; },
  });
  for (let i = 0; i < MAX_VIEW_RECOVERIES; i++) assert.deepEqual(await run(), { result: { ok: true } });
  const capped = await run();
  assert.ok(capped.error);
  assert.equal(relaunches.length, MAX_VIEW_RECOVERIES);
  assert.equal(recoveries.length, MAX_VIEW_RECOVERIES);
});

// Preloaded in the child only. Fake browser reads are not layout or PNG evidence; the production CLI,
// fixture/hash checks, helper, recovery and report serialization run unchanged. FAKE_MODE chooses what
// the first browser does to long-content-1280x900.png (later browsers capture normally unless 'always').
function installFakePlaywright() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mode = process.env.FAKE_MODE;
  let instance = 0;
  const protocol = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - fonts loaded\n';
  const chromium = { launch: async () => {
    const id = ++instance;
    fs.appendFileSync(process.env.FAKE_LOG, `launch ${id}\n`);
    return {
      version: () => 'FAKE SELFTEST ONLY; no browser execution',
      isConnected: () => true,
      close: async () => { fs.appendFileSync(process.env.FAKE_LOG, `close ${id}\n`); },
      newContext: async ({ viewport }) => {
        let fixture;
        let handler;
        const faulty = () => id === 1 && fixture === 'long-content.html' && viewport.width === 1280;
        const locator = selector => ({
          locator, nth: () => locator(selector), focus: async () => {},
          isVisible: async () => !(mode === 'check' && faulty() && selector === '[data-status="live"]'),
          count: async () => selector === '[data-status]' ? 4 : selector === 'thead th' ? 5 : 0,
          innerText: async () => selector === '[data-testid="featured-preview"]'
            ? 'Save changes to refresh this preview' : selector.match(/^\[data-status="(\w+)"\]$/)[1],
          textContent: async () => selector === 'h3' ? 'a'.repeat(255) : `https://example.test/${'a'.repeat(400)}`,
          evaluateAll: async () => true,
          evaluate: async () => selector === 'main' ? '24px' : selector === '[data-testid="featured-table-scroll"]' ? 1 : true,
        });
        return {
          route: async (pattern, fn) => { handler = fn; },
          close: async () => {},
          newCDPSession: async () => ({
            send: async method => method === 'Page.getLayoutMetrics' ? { cssContentSize: { width: viewport.width, height: 2303 } } : { data: Buffer.from('viewport png').toString('base64') },
            detach: async () => {},
          }),
          newPage: async () => ({
            locator, keyboard: { press: async () => {} }, isClosed: () => false,
            setContent: async html => {
              fixture = html.match(/<title>([^<]+)<\/title>/)[1];
              if (mode === 'network' && faulty()) await handler({ request: () => ({ url: () => 'https://example.test/blocked.png' }), abort: async () => {} });
            },
            evaluate: async () => ({ viewportWidth: viewport.width, documentWidth: viewport.width, elements: [] }),
            screenshot: async options => {
              assert.equal(options.fullPage, true);
              const name = path.basename(options.path);
              if (name === 'long-content-1280x900.png' && (mode === 'always' || (id === 1 && mode !== 'none'))) {
                throw new Error(mode === 'unrelated' ? 'page.screenshot: Timeout 30000ms exceeded' : protocol);
              }
              fs.writeFileSync(options.path, 'FAKE SELFTEST ONLY; not a PNG');
            },
          }),
        };
      },
    };
  } };
  Module._load = function(request, parent, isMain) {
    if (request === 'playwright') return { chromium };
    if (request === 'playwright/package.json') return { version: '1.58.2' };
    return originalLoad.call(this, request, parent, isMain);
  };
}

async function runCli(t, mode) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.RUNNER_TEMP;
  assert.ok(base, 'Tests require run-owned scratch or CI RUNNER_TEMP');
  const dir = await fs.mkdtemp(path.join(base, 'capture-recovery-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input');
  const output = path.join(dir, 'output');
  await fs.mkdir(input);
  const sourceHead = 'b'.repeat(40);
  const fixtures = [];
  for (const name of ['edit', 'long-content', 'list', 'scheduled']) {
    const html = `<title>${name}.html</title><main>synthetic driver fixture, not visual evidence</main>`;
    await fs.writeFile(path.join(input, `${name}.html`), html);
    fixtures.push({ name: `${name}.html`, sha256: createHash('sha256').update(html).digest('hex') });
  }
  await fs.writeFile(path.join(input, 'manifest.json'), JSON.stringify({ sourceHead, fixtures }));
  const preload = path.join(dir, 'fake-playwright.cjs');
  await fs.writeFile(preload, `(${installFakePlaywright.toString()})();\n`);
  const log = path.join(dir, 'browser.log');
  const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'capture-current.cjs'), input, output], {
    encoding: 'utf8', timeout: 10000,
    env: { PROOF_CHECKOUT_HEAD: sourceHead, PROOF_RUN_URL: 'https://example.test/selftest', PROOF_CONTAINER_IMAGE: 'synthetic-selftest', FAKE_MODE: mode, FAKE_LOG: log },
  });
  assert.equal(child.error, undefined);
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  const launches = (await fs.readFile(log, 'utf8')).split('\n').filter(line => line.startsWith('launch')).length;
  const pngs = (await fs.readdir(output)).filter(name => name.endsWith('.png')).sort();
  return { child, report, launches, pngs, sourceHead };
}

test('CLI: one transient persistent-on-page failure is recovered with all twelve captures and a full record', async t => {
  const { child, report, launches, pngs, sourceHead } = await runCli(t, 'transient');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), { automatedChecksPassed: true, screenshots: 12, sourceHead, recoveredViews: 1 });
  assert.match(child.stderr, /::warning title=featured capture recovered::long-content\.html 1280x900: recovered/);
  assert.equal(launches, 2);
  assert.equal(pngs.length, 12);
  assert.equal(report.results.length, 8);
  assert.deepEqual(report.errors, []);
  assert.equal(report.recoveries.length, 1);
  const [recovery] = report.recoveries;
  assert.deepEqual([recovery.fixture, recovery.viewport, recovery.outcome], ['long-content.html', { width: 1280, height: 900 }, 'recovered']);
  assert.ok(recovery.checks.length > 0 && recovery.checks.every(c => c.pass));
  assert.deepEqual(recovery.attemptedRequests, []);
  assert.deepEqual(recovery.diagnostics, { browserConnected: true, pageClosed: false, layoutMetrics: { cssContentSize: { width: 1280, height: 2303 } }, viewportOnlyCaptureBytes: 12 });
  const failed = report.captureAttempts.filter(a => !a.success);
  assert.deepEqual(failed.map(a => [a.screenshot, a.attempt]), [['long-content-1280x900.png', 1], ['long-content-1280x900.png', 2]]);
  // Rerun view's checks are the ones reported, not the discarded run's.
  assert.equal(report.results[1].fixture, 'long-content.html');
  assert.ok(report.results[1].checks.length >= recovery.checks.length);
});

test('CLI: a failure that survives the fresh browser stays red with the missing capture named', async t => {
  const { child, report, launches, pngs } = await runCli(t, 'always');
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).automatedChecksPassed, false);
  assert.equal(launches, 2);
  assert.equal(pngs.length, 11);
  assert.ok(!pngs.includes('long-content-1280x900.png'));
  assert.equal(report.results.length, 7);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].error, /^page\.screenshot: Protocol error \(Page\.captureScreenshot\): Unable to capture screenshot/);
  assert.equal(report.recoveries[0].outcome, 'failed');
});

for (const [mode, why] of [
  ['unrelated', 'a screenshot timeout'],
  ['network', 'an attempted network request'],
  ['check', 'a failed content/layout check'],
]) {
  test(`CLI: ${why} is never retried in a fresh browser`, async t => {
    const { child, report, launches, pngs } = await runCli(t, mode);
    assert.equal(launches, 1);
    assert.equal(child.status, 1);
    assert.deepEqual(report.recoveries, []);
    // The view stays missing and red: not rerun, not reported as a result.
    assert.equal(report.errors.length, 1);
    assert.deepEqual([report.errors[0].fixture, report.errors[0].viewport], ['long-content.html', { width: 1280, height: 900 }]);
    assert.equal(report.results.length, 7);
    assert.equal(pngs.length, 11);
    assert.ok(!pngs.includes('long-content-1280x900.png'));
  });
}
