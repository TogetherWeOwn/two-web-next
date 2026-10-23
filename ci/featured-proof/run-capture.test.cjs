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

test('both capture jobs route runners by repo visibility and retain the pinned browser container', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../../.github/workflows/featured-offline-proof.yml'), 'utf8');
  for (const job of ['capture', 'current-source']) {
    const block = workflow.split(`  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(block, `${job} exists`);
    // Self-hosted while private; GitHub-hosted only while public (TOG-12326).
    assert.ok(block.includes(`runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`));
    assert.match(block, /image: mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d/);
    assert.equal(block.split('ubuntu-latest').length - 1, 1, 'ubuntu-latest only as the public-repo branch');
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

// Featured current-source scope: the workflow must run the proof when any
// runtime module it renders changes. The walk below follows value imports
// only (import type and export type are erased before SSR), resolving each
// relative specifier against the filesystem. Barrel re-exports are followed
// selectively by imported name, so unused barrel siblings do not widen the
// scope. No esbuild or TypeScript compiler: plain regex over source text.
const fsSync = require('node:fs');

const REPO_ROOT = path.join(__dirname, '../..');
const CURRENT_FIXTURES_PATH = path.join(__dirname, 'current-fixtures.ts');
const FEATURED_WORKFLOW_PATH = path.join(
  __dirname,
  '../../.github/workflows/featured-offline-proof.yml',
);

function extractScopeGlobs(workflowText) {
  const marker = 'bash ci/path-scope.sh "$RUNNER_TEMP';
  const begin = workflowText.indexOf(marker);
  assert.ok(begin >= 0, 'featured scope invocation exists');
  const separator = workflowText.indexOf('--', begin);
  assert.ok(separator >= 0, 'featured scope glob separator exists');
  const redirect = workflowText.indexOf('>>', separator);
  const section = workflowText.slice(separator, redirect >= 0 ? redirect : undefined);
  const globs = [];
  for (const match of section.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const glob = match[1] ?? match[2];
    if (!glob || glob.startsWith('$')) continue;
    globs.push(glob);
  }
  assert.ok(globs.length > 0, 'featured scope list is not empty');
  return globs;
}

function shellPatternToRegExp(pattern) {
  let out = '';
  for (const char of pattern) {
    if (char === '*') out += '.*';
    else if (char === '?') out += '.';
    else if ('\\^$.|+()[]{}'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return new RegExp(`^${out}$`);
}

function scopePatternCovers(glob, relPosix) {
  return (
    shellPatternToRegExp(glob).test(relPosix) ||
    shellPatternToRegExp(`${glob}/*`).test(relPosix)
  );
}

function isCoveredByScopes(relPosix, globs) {
  return globs.some((glob) => scopePatternCovers(glob, relPosix));
}

function resolveRelativeImport(fromAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (fsSync.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function parseModuleReferences(content) {
  const imports = [];
  for (const match of content.matchAll(
    /import\s+(type\s+)?(?:[^'"]+?from\s+)?['"]([^'"]+)['"]/g,
  )) {
    const isType = Boolean(match[1]);
    const spec = match[2];
    const statement = match[0];
    let srcNames = null;
    const braces = statement.match(/\{([\s\S]*?)\}/);
    if (braces) {
      srcNames = [];
      for (const part of braces[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith('type ')) continue;
        const source = trimmed.split(/\s+as\s+/)[0].trim();
        if (source) srcNames.push(source);
      }
    }
    imports.push({ spec, isType, srcNames });
  }
  const exportsFrom = [];
  for (const match of content.matchAll(
    /export\s+(type\s+)?(?:\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]|\*\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"])/g,
  )) {
    const isType = Boolean(match[1]);
    if (match[3]) {
      const list = [];
      for (const part of match[2].split(',')) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith('type ')) continue;
        const pieces = trimmed.split(/\s+as\s+/);
        const src = (pieces[0] || '').trim();
        const exp = (pieces[1] || pieces[0] || '').trim();
        if (src && exp) list.push({ src, exp });
      }
      exportsFrom.push({ spec: match[3], isType, list });
    } else if (match[4]) {
      exportsFrom.push({ spec: match[4], isType, star: true });
    }
  }
  return { imports, exportsFrom };
}

function collectReachableModules(entryAbs) {
  const neededByFile = new Map();
  const queue = [{ file: entryAbs, needed: null }];
  while (queue.length > 0) {
    const { file, needed } = queue.shift();
    const previous = neededByFile.get(file);
    if (previous === null) continue;
    if (previous !== undefined && needed !== null) {
      if ([...needed].every((name) => previous.has(name))) continue;
      for (const name of needed) previous.add(name);
    } else if (previous === undefined) {
      neededByFile.set(file, needed === null ? null : new Set(needed));
    } else if (needed === null) {
      neededByFile.set(file, null);
    }
    const currentNeeded = neededByFile.get(file);
    let content;
    try {
      content = fsSync.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { imports, exportsFrom } = parseModuleReferences(content);
    for (const imp of imports) {
      if (imp.isType || !imp.spec.startsWith('.')) continue;
      const target = resolveRelativeImport(file, imp.spec);
      if (!target) continue;
      if (imp.srcNames === null) queue.push({ file: target, needed: null });
      else if (imp.srcNames.length > 0)
        queue.push({ file: target, needed: new Set(imp.srcNames) });
    }
    for (const exp of exportsFrom) {
      if (exp.isType || !exp.spec.startsWith('.')) continue;
      const target = resolveRelativeImport(file, exp.spec);
      if (!target) continue;
      if (exp.star) {
        queue.push({
          file: target,
          needed: currentNeeded === null ? null : new Set(currentNeeded),
        });
      } else if (currentNeeded === null) {
        queue.push({ file: target, needed: new Set(exp.list.map((entry) => entry.src)) });
      } else {
        const matched = exp.list.filter((entry) => currentNeeded.has(entry.exp));
        if (matched.length === 0) continue;
        queue.push({ file: target, needed: new Set(matched.map((entry) => entry.src)) });
      }
    }
  }
  return [...neededByFile.keys()];
}

function findUncoveredModules(reachableRels, globs) {
  return reachableRels.filter((rel) => !isCoveredByScopes(rel, globs));
}

test('featured scope covers every runtime src module the current-source proof renders', async () => {
  const workflow = await fs.readFile(FEATURED_WORKFLOW_PATH, 'utf8');
  const globs = extractScopeGlobs(workflow);
  const reachable = collectReachableModules(CURRENT_FIXTURES_PATH)
    .map((abs) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/'))
    .filter((rel) => rel.startsWith('src/'))
    .sort();
  assert.ok(reachable.length > 0, 'reachable src modules are not empty');
  const uncovered = findUncoveredModules(reachable, globs);
  assert.deepEqual(uncovered, [], `Uncovered featured-proof modules: ${uncovered.join(', ')}`);
});

test('scope check names an uncovered module and passes once it is added (synthetic)', async (t) => {
  const dir = await scratch(t);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'entry.ts'),
    'import { a } from "./src/used";\nimport { b } from "./src/uncovered";\n',
  );
  await fs.writeFile(path.join(dir, 'src', 'used.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(dir, 'src', 'uncovered.ts'), 'export const b = 2;\n');
  const reachable = collectReachableModules(path.join(dir, 'entry.ts'))
    .map((abs) => path.relative(dir, abs).replace(/\\/g, '/'))
    .filter((rel) => rel.startsWith('src/'))
    .sort();
  assert.deepEqual(reachable, ['src/uncovered.ts', 'src/used.ts']);
  const missing = findUncoveredModules(reachable, ['src/used.ts']);
  assert.deepEqual(missing, ['src/uncovered.ts']);
  assert.throws(() => assert.deepEqual(missing, []), /src\/uncovered\.ts/);
  assert.deepEqual(findUncoveredModules(reachable, ['src/used.ts', 'src/uncovered.ts']), []);
});
