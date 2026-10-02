const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { capture, verifyInputs, verifyOutputs, hashes, sourceHead, viewports, names } = require('./run-capture.cjs');
const fixtures = path.join(__dirname, 'fixtures');

async function scratch(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.RUNNER_TEMP;
  assert.ok(base, 'Tests require run-owned scratch or CI RUNNER_TEMP');
  const dir = await fs.mkdtemp(path.join(base, 'featured-guard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function reportFixture() {
  return {
    sourceHead, javascriptEnabled: false, offline: true, serviceWorkers: 'block',
    browserVersion: 'FAKE SELFTEST ONLY; no browser execution', errors: [],
    fixtures: names.map(name => ({ name: `${name}.html`, sha256: hashes[`${name}.html`] })),
    results: viewports.flatMap(viewport => names.map(name => ({
      fixture: `${name}.html`, viewport, screenshot: `${name}-${viewport.width}x${viewport.height}.png`,
      checks: [{ name: 'selftest placeholder only', pass: true }], attemptedRequests: [],
    }))),
  };
}

async function writeOutput(dir, report = reportFixture()) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
  // These signature-only bytes are guard test inputs, never screenshot evidence.
  const png = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  for (const r of report.results) await fs.writeFile(path.join(dir, r.screenshot), png);
}

test('both capture jobs use GitHub-hosted runners and retain the pinned browser container', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../../.github/workflows/featured-offline-proof.yml'), 'utf8');
  for (const job of ['capture', 'current-source']) {
    const block = workflow.split(`  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(block, `${job} exists`);
    assert.match(block, /runs-on: ubuntu-latest\n/);
    assert.match(block, /image: mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d/);
    assert.doesNotMatch(block, /self-hosted/);
  }
});

test('unchanged supplied driver and all three fixtures match authorized hashes', async () => {
  await verifyInputs(fixtures);
});

for (const name of Object.keys(hashes)) {
  test(`reject changed input before invoking driver: ${name}`, async t => {
    const dir = await scratch(t);
    const input = path.join(dir, 'input');
    await fs.cp(fixtures, input, { recursive: true });
    await fs.appendFile(path.join(input, name), '\nCHANGED');
    const output = path.join(dir, 'output');
    let invoked = false;
    await assert.rejects(capture(input, output, () => { invoked = true; }), /Input hash mismatch/);
    assert.equal(invoked, false);
    const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.results.length, 0);
    assert.match(report.errors[0].error, /Input hash mismatch/);
    const execution = JSON.parse(await fs.readFile(path.join(output, 'execution.json'), 'utf8'));
    assert.equal(execution.automatedChecksPassed, false);
  });
}

for (const [name, mutate] of [
  ['failed state check', r => { r.results[0].checks[0].pass = false; }],
  ['attempted external request', r => { r.results[0].attemptedRequests.push('https://example.invalid/blocked'); }],
  ['missing result', r => { r.results.pop(); }],
  ['duplicate result', r => { r.results[1] = r.results[0]; }],
  ['enabled JavaScript', r => { r.javascriptEnabled = true; }],
  ['online context', r => { r.offline = false; }],
  ['unblocked service workers', r => { r.serviceWorkers = 'allow'; }],
  ['wrong product attribution', r => { r.sourceHead = 'workflow-sha-is-not-product-head'; }],
  ['wrong reported fixture hash', r => { r.fixtures[0].sha256 = 'wrong'; }],
  ['driver errors', r => { r.errors.push({ error: 'launch failed' }); }],
]) {
  test(`fail closed for ${name}`, async t => {
    const dir = await scratch(t);
    const report = reportFixture();
    mutate(report);
    await writeOutput(dir, report);
    await assert.rejects(verifyOutputs(dir));
  });
}

test('require all six PNGs, not just a success report', async t => {
  const dir = await scratch(t);
  await writeOutput(dir);
  await fs.unlink(path.join(dir, 'edit-390x844.png'));
  await assert.rejects(verifyOutputs(dir), /ENOENT/);
});

test('reject invalid PNG bytes', async t => {
  const dir = await scratch(t);
  await writeOutput(dir);
  await fs.writeFile(path.join(dir, 'edit-390x844.png'), 'not an image');
  await assert.rejects(verifyOutputs(dir), /invalid PNG/);
});

test('preserve a partial driver report and capture on failure', async t => {
  const dir = await scratch(t);
  const output = path.join(dir, 'output');
  const report = reportFixture();
  report.results = report.results.slice(0, 1);
  report.errors.push({ error: 'simulated browser failure' });
  await assert.rejects(capture(fixtures, output, async () => {
    await writeOutput(output, report);
    throw new Error('simulated driver failure');
  }), /simulated driver failure/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')), report);
  assert.ok((await fs.stat(path.join(output, 'edit-1280x900.png'))).size > 0);
});

test('retain a failure report if no browser/module/launch output exists', async t => {
  const dir = await scratch(t);
  const output = path.join(dir, 'output');
  await assert.rejects(capture(fixtures, output, () => { throw new Error('simulated module unavailable'); }), /module unavailable/);
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.results.length, 0);
  assert.match(report.errors[0].error, /module unavailable/);
  assert.equal(report.visualInspection, 'NOT PERFORMED');
});

test('refuse to overwrite an existing output directory', async t => {
  const dir = await scratch(t);
  await fs.writeFile(path.join(dir, 'sentinel'), 'previous evidence');
  await assert.rejects(capture(fixtures, dir, () => assert.fail('must not invoke driver')), /already exists/);
  assert.equal(await fs.readFile(path.join(dir, 'sentinel'), 'utf8'), 'previous evidence');
});

test('accept complete guard fixtures without claiming a visual PASS', async t => {
  const dir = await scratch(t);
  const output = path.join(dir, 'output');
  await capture(fixtures, output, () => writeOutput(output));
  const execution = JSON.parse(await fs.readFile(path.join(output, 'execution.json'), 'utf8'));
  assert.equal(execution.automatedChecksPassed, true);
  assert.equal(execution.visualInspectionRequired, true);
  assert.equal(execution.productFixtureSourceHead, sourceHead);
});
