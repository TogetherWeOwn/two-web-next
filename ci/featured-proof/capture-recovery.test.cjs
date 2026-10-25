const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { captureViewWithRecovery, captureDiagnostics } = require('./capture-current.cjs');

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

test('recovery is capped at exactly two views per run', async () => {
  const recoveries = [];
  let attempts = 0;
  const relaunches = [];
  const run = () => captureViewWithRecovery({
    view, recoveries, relaunch: async () => { relaunches.push(attempts); },
    attemptView: async () => { if (++attempts % 2) throw captureFailure(); return { ok: true }; },
  });
  for (let i = 0; i < 2; i++) assert.deepEqual(await run(), { result: { ok: true } });
  const capped = await run();
  assert.ok(capped.error);
  assert.equal(attempts, 5);
  assert.equal(relaunches.length, 2);
  assert.equal(recoveries.length, 2);
});

test('current-source CI collects the recovery suite in its credential-free selftest step', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../../.github/workflows/featured-offline-proof.yml'), 'utf8');
  const currentSource = workflow.split('\n  current-source:\n')[1].split('\n  featured-proof:\n')[0];
  assert.match(currentSource, /- name: Credential-free guard selftests \(no browser\)\s+run: node --test ci\/featured-proof\/run-capture\.test\.cjs ci\/featured-proof\/capture-current\.test\.cjs ci\/featured-proof\/capture-recovery\.test\.cjs\s*\n/);
});

for (const stalledAt of ['session', 'layout', 'capture', 'detach']) {
  test(`diagnostics share a one-second deadline including ${stalledAt}; late completion cannot change the snapshot`, { timeout: 2000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const calls = [];
    const step = async (name, result) => { calls.push(name); if (name === stalledAt) await pending; return result; };
    const session = {
      send: method => method === 'Page.getLayoutMetrics' ? step('layout', { width: 1280 }) : step('capture', { data: 'cG5n' }),
      detach: () => step('detach'),
    };
    const result = captureDiagnostics({ isConnected: () => true }, { newCDPSession: () => step('session', session) }, { isClosed: () => false });
    // Let each already-resolved probe advance to the deliberately pending call.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(calls.at(-1), stalledAt);
    let settled = false;
    result.then(() => { settled = true; });
    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const diagnostics = await result;
    assert.match(diagnostics.probeError, /timed out after 1000ms/);
    const snapshot = JSON.stringify(diagnostics);
    const callsAtDeadline = [...calls];
    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(JSON.stringify(diagnostics), snapshot);
    assert.deepEqual(calls, callsAtDeadline, 'no later probe starts after the deadline');
  });
}

test('the diagnostic deadline is total, not a fresh second per CDP call', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const step = async value => { await new Promise(resolve => setTimeout(resolve, 300)); return value; };
  const result = captureDiagnostics({ isConnected: () => true }, { newCDPSession: () => step({
    send: method => step(method === 'Page.getLayoutMetrics' ? { width: 1280 } : { data: 'cG5n' }),
    detach: () => step(),
  }) }, { isClosed: () => false });
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(300);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  }
  let settled = false;
  result.then(() => { settled = true; });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const diagnostics = await result;
  assert.deepEqual(diagnostics, {
    browserConnected: true, pageClosed: false, layoutMetrics: { width: 1280 },
    viewportOnlyCaptureBytes: 3, probeError: 'Diagnostic CDP probe timed out after 1000ms',
  });
  t.mock.timers.tick(200);
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
      version: () => mode === 'version' && id > 1 ? 'FAKE DIFFERENT BUILD' : 'FAKE SELFTEST ONLY; no browser execution',
      isConnected: () => true,
      close: async () => { fs.appendFileSync(process.env.FAKE_LOG, `close ${id}\n`); },
      newContext: async ({ viewport }) => {
        let fixture;
        let handler;
        let keepAlive;
        const diagnosticStep = async (name, value) => {
          if (mode === `hang-${name}`) {
            keepAlive = setInterval(() => {}, 1000);
            await new Promise(() => {});
          }
          return value;
        };
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
          close: async () => { clearInterval(keepAlive); },
          newCDPSession: () => diagnosticStep('session', {
            send: method => method === 'Page.getLayoutMetrics'
              ? diagnosticStep('layout', { cssContentSize: { width: viewport.width, height: 2303 } })
              : diagnosticStep('capture', { data: Buffer.from('viewport png').toString('base64') }),
            detach: () => diagnosticStep('detach'),
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

for (const phase of ['session', 'layout', 'capture', 'detach']) {
  test(`CLI: a never-answering diagnostic ${phase} still reaches recovery and writes the complete report`, async t => {
    const { child, report, launches, pngs } = await runCli(t, `hang-${phase}`);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).automatedChecksPassed, true);
    assert.equal(launches, 2);
    assert.equal(pngs.length, 12);
    assert.equal(report.results.length, 8);
    assert.deepEqual(report.errors, []);
    assert.equal(report.recoveries[0].outcome, 'recovered');
    assert.match(report.recoveries[0].diagnostics.probeError, /timed out after 1000ms/);
  });
}

test('CLI: a different relaunched browser build fails closed and is not attributed to the original version', async t => {
  const { child, report, launches, pngs } = await runCli(t, 'version');
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).automatedChecksPassed, false);
  assert.equal(report.browserVersion, 'FAKE SELFTEST ONLY; no browser execution');
  assert.equal(launches, 2);
  assert.equal(pngs.length, 11);
  assert.equal(report.results.length, 7);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].error, 'Relaunched browser version changed');
  assert.equal(report.recoveries[0].outcome, 'failed');
  assert.equal(report.recoveries[0].secondError, 'Relaunched browser version changed');
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
