const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const DRIVER = path.join(__dirname, 'capture-current.cjs');
const CAPTURE_ERROR = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
const SOURCE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const FIXTURES = ['edit.html', 'long-content.html', 'list.html', 'scheduled.html'];
const VIEWPORTS = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const IMAGES = [
  'edit-1280x900.png', 'long-content-1280x900.png', 'list-1280x900.png',
  'list-window-1280x900.png', 'list-last-changed-1280x900.png', 'scheduled-1280x900.png',
  'edit-390x844.png', 'long-content-390x844.png', 'list-390x844.png',
  'list-window-390x844.png', 'list-last-changed-390x844.png', 'scheduled-390x844.png',
];

async function scratch(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.RUNNER_TEMP;
  assert.ok(base, 'Tests require PAPERCLIP_RUN_SCRATCH_DIR or RUNNER_TEMP');
  const dir = await fs.mkdtemp(path.join(base, 'current-capture-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Load the real, unmodified CJS source as an import. Stub only external I/O so
// the pre-export baseline cannot launch a browser or read arbitrary argv paths.
async function loadHelper() {
  const effects = [];
  const module = { exports: {} };
  const processStub = { argv: ['node', DRIVER, 'unused-input', 'unused-output'], env: {}, exitCode: 0 };
  const requireStub = name => {
    if (name === 'playwright' || name === 'playwright/package.json') {
      effects.push(name);
      return { chromium: { launch: async () => { throw new Error('Browser launch on import refused'); } }, version: '1.58.2' };
    }
    if (name === 'node:fs/promises') return new Proxy({}, {
      get: (_, method) => async () => { effects.push(`fs.${String(method)}`); throw new Error('Filesystem I/O on import refused'); },
    });
    assert.ok(['node:path', 'node:crypto'].includes(name), `Unexpected import: ${name}`);
    return require(name);
  };
  requireStub.main = {};
  vm.runInNewContext(await fs.readFile(DRIVER, 'utf8'), {
    require: requireStub, module, exports: module.exports, process: processStub,
    __filename: DRIVER, __dirname: __dirname, Error, Buffer,
    console: { log: () => effects.push('console.log'), error: () => effects.push('console.error') },
  }, { filename: DRIVER, timeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof module.exports.captureScreenshot, 'function', 'Missing API: export captureScreenshot(page, screenshotPath, recoveries)');
  assert.deepEqual(effects, [], 'Import must not require Playwright, invoke main, or perform I/O');
  assert.equal(processStub.exitCode, 0, 'Import must not change process exit status');
  return module.exports.captureScreenshot;
}

function screenshotPage(outcomes) {
  const calls = [];
  const page = {
    async screenshot(options) {
      calls.push({ receiver: this, options: structuredClone(options) });
      assert.ok(outcomes.length, 'Unexpected extra screenshot attempt');
      const outcome = outcomes.shift();
      if (outcome instanceof Error || typeof outcome === 'string' || outcome?.message) throw outcome;
      if (typeof outcome === 'function') return outcome();
      return Buffer.from('SELFTEST ONLY; not screenshot evidence');
    },
  };
  return { page, calls };
}

function assertCalls(calls, page, screenshotPath, count) {
  assert.equal(calls.length, count);
  for (const call of calls) {
    assert.equal(call.receiver, page, 'Retry must use the same page');
    assert.deepEqual(call.options, { path: screenshotPath, fullPage: true }, 'No clip, timeout, path, or fullPage changes');
  }
}

// Recovery record contract: basename filename, original message, retryCount: 1.
function assertRecovery(recoveries, filename, message) {
  assert.equal(recoveries.length, 1, 'Exactly one recovery attempt must be recorded');
  assert.equal(recoveries[0].filename, filename);
  assert.equal(recoveries[0].error, message);
  assert.equal(recoveries[0].retryCount, 1);
}

test('import exposes the helper without requiring Playwright or executing the CLI', async () => {
  await loadHelper();
});

test('immediate screenshot success uses the original options once and records no recovery', async t => {
  const captureScreenshot = await loadHelper();
  const filename = path.join(await scratch(t), 'immediate.png');
  const { page, calls } = screenshotPage([null]);
  const recoveries = [];
  await captureScreenshot(page, filename, recoveries);
  assertCalls(calls, page, filename, 1);
  assert.deepEqual(recoveries, []);
});

for (const message of [CAPTURE_ERROR, `${CAPTURE_ERROR}\nCall log:\n  - taking page screenshot`]) {
  test(`exact first-line transport failure gets one identical retry: ${JSON.stringify(message)}`, async t => {
    const captureScreenshot = await loadHelper();
    const filename = path.join(await scratch(t), 'transient.png');
    const recoveries = [];
    const { page, calls } = screenshotPage([new Error(message), () => {
      assertRecovery(recoveries, 'transient.png', message);
    }]);
    await captureScreenshot(page, filename, recoveries);
    assertCalls(calls, page, filename, 2);
    assertRecovery(recoveries, 'transient.png', message);
  });
}

test('second identical failure rejects with that same Error after two calls, never a third', async t => {
  const captureScreenshot = await loadHelper();
  const filename = path.join(await scratch(t), 'persistent.png');
  const second = new Error(CAPTURE_ERROR);
  const { page, calls } = screenshotPage([new Error(CAPTURE_ERROR), second]);
  const recoveries = [];
  await assert.rejects(captureScreenshot(page, filename, recoveries), error => error === second);
  assertCalls(calls, page, filename, 2);
  assertRecovery(recoveries, 'persistent.png', CAPTURE_ERROR);
});

test('a different second failure propagates unchanged instead of reporting success', async t => {
  const captureScreenshot = await loadHelper();
  const filename = path.join(await scratch(t), 'second-error.png');
  const second = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const { page, calls } = screenshotPage([new Error(CAPTURE_ERROR), second]);
  const recoveries = [];
  await assert.rejects(captureScreenshot(page, filename, recoveries), error => error === second);
  assertCalls(calls, page, filename, 2);
  assertRecovery(recoveries, 'second-error.png', CAPTURE_ERROR);
});

for (const [name, failure] of [
  ['timeout', Object.assign(new Error('page.screenshot: Timeout 30000ms exceeded.'), { name: 'TimeoutError' })],
  ['closed page', new Error('page.screenshot: Target page, context or browser has been closed')],
  ['crash', new Error('page.screenshot: Page crashed')],
  ['disk full', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })],
  ['other CDP command', new Error('page.screenshot: Protocol error (Page.getLayoutMetrics): Unable to capture screenshot')],
  ['other CDP reason', new Error('page.screenshot: Protocol error (Page.captureScreenshot): Target closed')],
  ['missing page prefix', new Error('Protocol error (Page.captureScreenshot): Unable to capture screenshot')],
  ['punctuation suffix', new Error(`${CAPTURE_ERROR}.`)],
  ['leading space', new Error(` ${CAPTURE_ERROR}`)],
  ['trailing space', new Error(`${CAPTURE_ERROR} `)],
  ['substring only on second line', new Error(`Different failure\n${CAPTURE_ERROR}`)],
  ['string, not Error', CAPTURE_ERROR],
  ['message-shaped object, not Error', { message: CAPTURE_ERROR }],
]) {
  test(`does not retry ${name}`, async t => {
    const captureScreenshot = await loadHelper();
    const filename = path.join(await scratch(t), 'refused.png');
    const { page, calls } = screenshotPage([failure]);
    const recoveries = [];
    await assert.rejects(captureScreenshot(page, filename, recoveries), error => error === failure);
    assertCalls(calls, page, filename, 1);
    assert.deepEqual(recoveries, []);
  });
}

test('does not fabricate success while the retry is still pending', async t => {
  const captureScreenshot = await loadHelper();
  const filename = path.join(await scratch(t), 'pending.png');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { page, calls } = screenshotPage([new Error(CAPTURE_ERROR), () => pending]);
  const recoveries = [];
  let settled = false;
  const operation = captureScreenshot(page, filename, recoveries).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assertCalls(calls, page, filename, 2);
    assertRecovery(recoveries, 'pending.png', CAPTURE_ERROR);
  } finally {
    release();
    await operation;
  }
  assert.equal(settled, true);
});

test('recoveries append across calls without clearing earlier attempts on success', async t => {
  const captureScreenshot = await loadHelper();
  const dir = await scratch(t);
  const recoveries = [];
  const { page, calls } = screenshotPage([new Error(CAPTURE_ERROR), null, null, new Error(CAPTURE_ERROR), null]);
  await captureScreenshot(page, path.join(dir, 'first.png'), recoveries);
  assertRecovery(recoveries, 'first.png', CAPTURE_ERROR);
  const first = recoveries[0];
  await captureScreenshot(page, path.join(dir, 'success.png'), recoveries);
  assertRecovery(recoveries, 'first.png', CAPTURE_ERROR);
  await captureScreenshot(page, path.join(dir, 'last.png'), recoveries);
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[0], first);
  assertRecovery(recoveries.slice(1), 'last.png', CAPTURE_ERROR);
  assert.deepEqual(calls.map(c => c.options), ['first.png', 'first.png', 'success.png', 'last.png', 'last.png']
    .map(filename => ({ path: path.join(dir, filename), fullPage: true })));
});

// Serialized into a scratch-only fake Playwright module. It never launches a
// browser, executes page callbacks, or writes PNG-signature bytes. Its job is
// to observe the real driver's orchestration/reporting, NOT to prove layout.
function fakePlaywright() {
  const fs = require('node:fs');
  const path = require('node:path');
  const scenario = JSON.parse(process.env.CAPTURE_TEST_SCENARIO);
  const trace = entry => fs.appendFileSync(process.env.CAPTURE_TEST_TRACE, `${JSON.stringify(entry)}\n`);
  const attempts = new Map();
  let nextId = 0;
  return { chromium: { launch: async options => {
    trace({ kind: 'launch', options });
    return {
      version: () => 'FAKE SELFTEST ONLY; no browser execution',
      async newContext(options) {
        const id = ++nextId;
        trace({ kind: 'context', id, options });
        let fixture;
        return {
          async route(pattern, handler) {
            trace({ kind: 'route', id, pattern });
            if (scenario.attemptedRequest && id === 1) await handler({
              request: () => ({ url: () => 'https://example.invalid/selftest-only' }),
              abort: async reason => { trace({ kind: 'abort', id, reason }); },
            });
          },
          async newPage() {
            trace({ kind: 'page', id });
            function locator(selector) {
              return {
                locator: child => locator(child), nth: () => locator(selector),
                async isVisible() {
                  if (fixture === 'edit.html' && options.viewport.width === 1280 && selector === '[data-status="live"]') {
                    if (scenario.behaviorThrow) throw new Error(scenario.behaviorThrow);
                    if (scenario.behaviorFail) return false;
                  }
                  return true;
                },
                async innerText() {
                  if (selector === '[data-testid="featured-preview"]') return 'Save changes to refresh this preview';
                  const status = selector.match(/^\[data-status="([a-z]+)"\]$/);
                  if (status) return status[1];
                  throw new Error(`Unexpected innerText: ${selector}`);
                },
                async textContent() {
                  if (selector === 'h3') return 'a'.repeat(255);
                  if (selector === 'p') return `https://example.test/${'a'.repeat(400)}`;
                  throw new Error(`Unexpected textContent: ${selector}`);
                },
                async count() {
                  if (selector === '[data-status]') return 4;
                  if (selector === 'thead th') return 5;
                  if (selector === '[data-testid="featured-item"]' && fixture === 'scheduled.html') return 0;
                  throw new Error(`Unexpected count: ${selector}`);
                },
                async focus() { trace({ kind: 'focus', id }); },
                async evaluate(fn) {
                  const code = fn.toString();
                  trace({ kind: 'evaluate', id, selector, code });
                  if (code.includes('paddingLeft')) return '24px';
                  if (code.includes('scrollLeft =')) return undefined;
                  if (code.includes('=> el.scrollLeft')) return 32;
                  if (code.includes('getClientRects') || code.includes('aria-label') ||
                      code.includes('document.activeElement') || code.includes('tolerancePx')) return true;
                  throw new Error(`Unexpected evaluate: ${selector}: ${code}`);
                },
                async evaluateAll(fn) {
                  const code = fn.toString();
                  trace({ kind: 'evaluateAll', id, selector, code });
                  if (code.includes('getClientRects')) return true;
                  throw new Error(`Unexpected evaluateAll: ${selector}`);
                },
              };
            }
            return {
              async setContent(html, contentOptions) {
                fixture = html.match(/fixture:([a-z-]+\.html)/)?.[1];
                if (!fixture) throw new Error('Missing synthetic fixture marker');
                trace({ kind: 'content', id, fixture, options: contentOptions });
              },
              locator,
              keyboard: { press: async key => { trace({ kind: 'key', id, key }); } },
              async evaluate() {
                return { viewportWidth: options.viewport.width, documentWidth: options.viewport.width,
                  elements: [{ left: 0, right: options.viewport.width, scrollContent: false }] };
              },
              async screenshot(screenshotOptions) {
                const filename = path.basename(screenshotOptions.path);
                const attempt = (attempts.get(filename) || 0) + 1;
                attempts.set(filename, attempt);
                trace({ kind: 'screenshot', id, filename, attempt, options: screenshotOptions });
                if ((scenario.target === filename || scenario.failAll) && attempt <= scenario.failures) {
                  throw new Error(scenario.message);
                }
                fs.writeFileSync(screenshotOptions.path, 'FAKE SELFTEST ONLY; not a PNG or visual evidence');
                return Buffer.from('FAKE');
              },
            };
          },
          async close() { trace({ kind: 'context-close', id }); },
        };
      },
      async close() { trace({ kind: 'browser-close' }); },
    };
  } } };
}

async function runDriver(t, scenario = {}, mutate = () => {}) {
  const dir = await scratch(t);
  const input = path.join(dir, 'input');
  const output = path.join(dir, 'output');
  const tracePath = path.join(dir, 'trace.jsonl');
  const moduleDir = path.join(dir, 'node_modules/playwright');
  await fs.mkdir(input);
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(tracePath, '');
  await fs.copyFile(DRIVER, path.join(dir, 'capture-current.cjs'));
  await fs.writeFile(path.join(moduleDir, 'index.js'), `module.exports = (${fakePlaywright.toString()})();\n`);
  await fs.writeFile(path.join(moduleDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.58.2', main: 'index.js' }));
  const manifest = { sourceHead: SOURCE_HEAD, clock: '2026-10-01T00:00:00.000Z', fixtures: [] };
  for (const name of FIXTURES) {
    const html = `<main><p>fixture:${name}</p></main>`;
    await fs.writeFile(path.join(input, name), html);
    manifest.fixtures.push({ name, sha256: crypto.createHash('sha256').update(html).digest('hex') });
  }
  await mutate(manifest, input);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(input, 'manifest.json'), manifestBytes);
  // No inherited tokens, NODE_OPTIONS, NODE_PATH, app/DB settings or credentials.
  const result = spawnSync(process.execPath, [path.join(dir, 'capture-current.cjs'), input, output], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { PROOF_CHECKOUT_HEAD: SOURCE_HEAD, PROOF_RUN_URL: 'https://example.invalid/selftest',
      PROOF_CONTAINER_IMAGE: 'SELFTEST ONLY', CAPTURE_TEST_SCENARIO: JSON.stringify(scenario), CAPTURE_TEST_TRACE: tracePath },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const trace = (await fs.readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  let report;
  try { report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const summaryLine = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  const summary = summaryLine ? JSON.parse(summaryLine) : undefined;
  return { ...result, report, summary, trace, output, manifest, manifestBytes };
}

const COMMON_CHECKS = ['no horizontal document overflow', 'primary elements fit viewport', 'external stylesheet applied', 'no network requests'];
const EDIT_CHECKS = ['saved live card', 'live label', 'saved-content disclosure'];
const CHECKS = {
  'edit.html': [...EDIT_CHECKS, ...COMMON_CHECKS],
  'long-content.html': [...EDIT_CHECKS, 'long headline preserved', 'long body preserved', 'long h3 wraps inside card', 'long p wraps inside card', ...COMMON_CHECKS],
  'list.html': ['four status badges', 'live label visible', 'live label fits one line',
    'scheduled label visible', 'scheduled label fits one line', 'expired label visible', 'expired label fits one line',
    'unpublished label visible', 'unpublished label fits one line', 'native five-column table', 'named keyboard scroll region',
    'title words never split across lines', 'thead th text stays on one line inside its cell', 'time text stays on one line inside its cell',
    'keyboard scroll region receives focus', 'keyboard can scroll the list', ...COMMON_CHECKS,
    'window column reachable inside scroll region', 'last-changed column reachable inside scroll region'],
  'scheduled.html': ['scheduled label', 'hidden notice', 'no scheduled public card', ...COMMON_CHECKS],
};

function assertSinglePass(trace, output) {
  assert.equal(trace.filter(e => e.kind === 'launch').length, 1);
  const contexts = trace.filter(e => e.kind === 'context');
  assert.equal(contexts.length, 8, 'No context/whole-fixture retries');
  assert.deepEqual(contexts.map(e => e.options), VIEWPORTS.flatMap(viewport => FIXTURES.map(() => ({
    viewport, offline: true, javaScriptEnabled: false, serviceWorkers: 'block',
  }))));
  assert.equal(trace.filter(e => e.kind === 'page').length, 8, 'No replacement pages');
  assert.deepEqual(trace.filter(e => e.kind === 'route').map(e => e.pattern), Array(8).fill('**/*'));
  const contents = trace.filter(e => e.kind === 'content');
  assert.deepEqual(contents.map(e => e.fixture), [...FIXTURES, ...FIXTURES]);
  assert.deepEqual(contents.map(e => e.options), Array(8).fill({ waitUntil: 'load' }));
  assert.equal(trace.filter(e => e.kind === 'context-close').length, 8);
  assert.equal(trace.filter(e => e.kind === 'browser-close').length, 1);
  for (const event of trace.filter(e => e.kind === 'screenshot')) {
    assert.deepEqual(event.options, { path: path.join(output, event.filename), fullPage: true });
  }
}

async function assertComplete(run) {
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.summary, { automatedChecksPassed: true, screenshots: 12, sourceHead: SOURCE_HEAD });
  assert.equal(run.report.sourceHead, SOURCE_HEAD);
  assert.deepEqual(run.report.fixtures, run.manifest.fixtures);
  assert.equal(run.report.javascriptEnabled, false);
  assert.equal(run.report.offline, true);
  assert.match(run.report.visualInspection, /REQUIRED/);
  assert.deepEqual(run.report.errors, []);
  assert.equal(run.report.results.length, 8);
  assert.equal(run.report.results.reduce((n, r) => n + r.checks.length, 0), 94);
  assert.deepEqual(run.report.results.map(r => [r.fixture, r.viewport]), VIEWPORTS.flatMap(v => FIXTURES.map(f => [f, v])));
  for (const result of run.report.results) {
    assert.deepEqual(result.checks, CHECKS[result.fixture].map(name => ({ name, pass: true })));
    assert.deepEqual(result.attemptedRequests, []);
    const suffix = `${result.viewport.width}x${result.viewport.height}.png`;
    assert.equal(result.screenshot, `${path.basename(result.fixture, '.html')}-${suffix}`);
    assert.deepEqual(result.scrolledCaptures.map(c => [c.column, c.screenshot]), result.fixture === 'list.html'
      ? [['window', `list-window-${suffix}`], ['last-changed', `list-last-changed-${suffix}`]] : []);
  }
  assert.equal(await fs.readFile(path.join(run.output, 'manifest.json'), 'utf8'), run.manifestBytes, 'Preserve manifest bytes and source attribution');
  assert.deepEqual((await fs.readdir(run.output)).filter(n => n.endsWith('.png')).sort(), [...IMAGES].sort());
  assertSinglePass(run.trace, run.output);
}

test('driver control retains all eight results, twelve image calls, and all 94 checks', async t => {
  const run = await runDriver(t);
  await assertComplete(run);
  assert.deepEqual(run.trace.filter(e => e.kind === 'screenshot').map(e => e.filename), IMAGES);
});

for (const filename of IMAGES) {
  test(`driver recovers only the failed image on the same page: ${filename}`, async t => {
    const run = await runDriver(t, { target: filename, failures: 1, message: CAPTURE_ERROR });
    await assertComplete(run);
    const calls = run.trace.filter(e => e.kind === 'screenshot');
    assert.equal(calls.length, 13);
    const retried = calls.filter(e => e.filename === filename);
    assert.equal(retried.length, 2);
    assert.equal(retried[0].id, retried[1].id);
    assert.deepEqual(retried[0].options, retried[1].options);
    assert.equal(calls.indexOf(retried[1]), calls.indexOf(retried[0]) + 1, 'Retry only that image, immediately');
    assert.deepEqual(calls.filter(e => e.attempt === 1).map(e => e.filename), IMAGES);
  });
}

test('each image owns its retry allowance; recovering earlier images cannot consume it', async t => {
  const run = await runDriver(t, { failAll: true, failures: 1, message: CAPTURE_ERROR });
  await assertComplete(run);
  const calls = run.trace.filter(e => e.kind === 'screenshot');
  assert.equal(calls.length, 24);
  assert.deepEqual(calls.map(e => e.filename), IMAGES.flatMap(filename => [filename, filename]));
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].id, calls[i + 1].id);
    assert.deepEqual(calls[i].options, calls[i + 1].options);
  }
});

for (const filename of ['long-content-1280x900.png', 'list-window-1280x900.png', 'list-last-changed-390x844.png']) {
  test(`persistent failure stays red and omits its result: ${filename}`, async t => {
    const run = await runDriver(t, { target: filename, failures: 99, message: CAPTURE_ERROR });
    assert.equal(run.status, 1);
    assert.equal(run.summary.automatedChecksPassed, false);
    assert.equal(run.report.results.length, 7);
    assert.equal(run.report.errors.length, 1);
    assert.equal(run.report.errors[0].error, CAPTURE_ERROR);
    const failed = run.report.errors[0];
    assert.equal(run.report.results.some(r => r.fixture === failed.fixture && r.viewport.width === failed.viewport.width), false);
    const calls = run.trace.filter(e => e.kind === 'screenshot' && e.filename === filename);
    assert.equal(calls.length, 2, 'Bounded retry, not swallowed failure or indefinite retry');
    assert.equal(calls[0].id, calls[1].id);
    assert.deepEqual(calls[0].options, calls[1].options);
    await assert.rejects(fs.stat(path.join(run.output, filename)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(run.output, 'manifest.json'), 'utf8'), run.manifestBytes);
    assertSinglePass(run.trace, run.output);
  });
}

test('all screenshots failing never fabricates successful results or image files', async t => {
  const run = await runDriver(t, { failAll: true, failures: 99, message: CAPTURE_ERROR });
  assert.equal(run.status, 1);
  assert.deepEqual(run.summary, { automatedChecksPassed: false, screenshots: 0, sourceHead: SOURCE_HEAD });
  assert.deepEqual(run.report.results, []);
  assert.equal(run.report.errors.length, 8);
  assert.ok(run.report.errors.every(e => e.error === CAPTURE_ERROR));
  assert.equal(run.trace.filter(e => e.kind === 'screenshot').length, 16);
  assert.deepEqual((await fs.readdir(run.output)).filter(n => n.endsWith('.png')), []);
  assertSinglePass(run.trace, run.output);
});

test('a failed behavioral check stays red without retrying a fixture or changing image coverage', async t => {
  const run = await runDriver(t, { behaviorFail: true });
  assert.equal(run.status, 1);
  assert.deepEqual(run.summary, { automatedChecksPassed: false, screenshots: 12, sourceHead: SOURCE_HEAD });
  assert.deepEqual(run.report.errors, []);
  assert.equal(run.report.results.length, 8);
  assert.equal(run.report.results.reduce((n, r) => n + r.checks.length, 0), 94);
  assert.deepEqual(run.report.results.flatMap(r => r.checks.filter(c => !c.pass)), [{ name: 'live label', pass: false }]);
  assert.equal(run.trace.filter(e => e.kind === 'screenshot').length, 12);
  assertSinglePass(run.trace, run.output);
});

test('an attempted request remains aborted and red, without any fixture retry', async t => {
  const run = await runDriver(t, { attemptedRequest: true });
  assert.equal(run.status, 1);
  assert.equal(run.summary.automatedChecksPassed, false);
  assert.equal(run.report.results.length, 8);
  assert.deepEqual(run.report.errors, []);
  assert.deepEqual(run.report.results[0].attemptedRequests, ['https://example.invalid/selftest-only']);
  assert.deepEqual(run.report.results.flatMap(r => r.checks.filter(c => !c.pass)), [{ name: 'no network requests', pass: false }]);
  assert.deepEqual(run.trace.filter(e => e.kind === 'abort'), [{ kind: 'abort', id: 1, reason: 'blockedbyclient' }]);
  assert.equal(run.trace.filter(e => e.kind === 'screenshot').length, 12);
  assertSinglePass(run.trace, run.output);
});

test('the exact transport message thrown by a behavioral read is not retryable', async t => {
  const run = await runDriver(t, { behaviorThrow: CAPTURE_ERROR });
  assert.equal(run.status, 1);
  assert.equal(run.summary.automatedChecksPassed, false);
  assert.equal(run.report.results.length, 7);
  assert.equal(run.report.errors.length, 1);
  assert.equal(run.report.errors[0].error, CAPTURE_ERROR);
  assert.equal(run.trace.filter(e => e.kind === 'screenshot').length, 11);
  assertSinglePass(run.trace, run.output);
});

for (const [name, mutate, message] of [
  ['source mismatch', manifest => { manifest.sourceHead = 'f'.repeat(40); }, /Fixture source head mismatch/],
  ['malformed source', manifest => { manifest.sourceHead = 'not-a-sha'; }, /Fixture source head mismatch/],
  ['fixture hash mismatch', async (_, input) => { await fs.appendFile(path.join(input, 'edit.html'), 'tampered'); }, /Fixture hash mismatch/],
  ['unexpected fixture order', manifest => { manifest.fixtures.reverse(); }, /Unexpected fixtures/],
  ['active fixture content', async (manifest, input) => {
    const bytes = '<script>fixture:edit.html</script>';
    await fs.writeFile(path.join(input, 'edit.html'), bytes);
    manifest.fixtures[0].sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  }, /Active content refused/],
]) {
  test(`driver refuses ${name} before launching or recording success`, async t => {
    const run = await runDriver(t, {}, mutate);
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
    assert.equal(run.summary?.automatedChecksPassed === true, false);
    assert.equal(run.trace.length, 0, 'No browser or screenshot work before validating inputs');
    assert.equal(run.report?.results?.length || 0, 0);
  });
}
