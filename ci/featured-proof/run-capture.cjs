const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const sourceHead = '582d5f93eb2a63194b9cbd4ebc4ce1abbdf9d348';
const hashes = {
  'capture-featured-proof.cjs': '9501a53d50e52993f6ac91a8b02a84d71cacfe5b93ba910cd21fc4660659713b',
  'edit.html': 'aba57e42f9efda9a36281a765a701c3a31d3825cf6b54673fbfaf50e24969ef0',
  'list.html': '3c8eeef8a59b6f4d76347ad5bb5dbe2eb1c6639d991adb79f1d554ba107fd496',
  'scheduled.html': '1cb19d7b580e12b9c6ecb51557865f1ebc130b932456a028bea7aa36ec0f72f0',
};
const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const names = ['edit', 'list', 'scheduled'];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function verifyInputs(inputDir) {
  for (const [name, expected] of Object.entries(hashes)) {
    const bytes = await fs.readFile(path.join(inputDir, name));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`Input hash mismatch: ${name}`);
    }
  }
}

async function verifyOutputs(outputDir) {
  const report = JSON.parse(await fs.readFile(path.join(outputDir, 'report.json'), 'utf8'));
  if (report.sourceHead !== sourceHead || report.javascriptEnabled !== false ||
      report.offline !== true || report.serviceWorkers !== 'block' ||
      typeof report.browserVersion !== 'string' || !report.browserVersion ||
      !Array.isArray(report.errors) || report.errors.length !== 0 ||
      !Array.isArray(report.results) || report.results.length !== 6) {
    throw new Error('Invalid provenance, containment, browser identity or result count');
  }
  if (!Array.isArray(report.fixtures) || report.fixtures.length !== 3 ||
      names.some(name => !report.fixtures.some(f => f.name === `${name}.html` && f.sha256 === hashes[f.name]))) {
    throw new Error('Invalid reported fixture hashes');
  }
  for (const viewport of viewports) {
    for (const name of names) {
      const screenshot = `${name}-${viewport.width}x${viewport.height}.png`;
      const matches = report.results.filter(r => r.fixture === `${name}.html` &&
        r.viewport?.width === viewport.width && r.viewport?.height === viewport.height && r.screenshot === screenshot);
      const result = matches[0];
      if (matches.length !== 1 || !Array.isArray(result.checks) || result.checks.length === 0 ||
          !result.checks.every(c => c.pass === true) || !Array.isArray(result.attemptedRequests) ||
          result.attemptedRequests.length !== 0) {
        throw new Error(`Missing/failed state or attempted external request: ${screenshot}`);
      }
      const bytes = await fs.readFile(path.join(outputDir, screenshot));
      if (bytes.length <= 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
        throw new Error(`Missing/invalid PNG: ${screenshot}`);
      }
    }
  }
  return report;
}

function runDriver(inputDir, outputDir) {
  if (require('playwright/package.json').version !== '1.58.2') {
    throw new Error('Playwright module must match the pinned 1.58.2 browser image');
  }
  const result = spawnSync(process.execPath, [path.join(inputDir, 'capture-featured-proof.cjs'), inputDir, outputDir], {
    stdio: 'inherit', timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Capture driver failed: exit=${result.status}, signal=${result.signal}`);
}

async function capture(inputDir, outputDir, driver = runDriver) {
  // Never overwrite an earlier run, including its failure evidence.
  try {
    await fs.access(outputDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return captureNew(inputDir, outputDir, driver);
  }
  throw new Error('Output directory already exists');
}

async function captureNew(inputDir, outputDir, driver) {
  let failure;
  try {
    if (process.env.PROOF_SETUP_FAILURE) throw new Error(process.env.PROOF_SETUP_FAILURE);
    await verifyInputs(inputDir);
    await driver(inputDir, outputDir);
    await verifyOutputs(outputDir);
  } catch (error) {
    failure = error;
  }
  await fs.mkdir(outputDir, { recursive: true });
  // The unchanged driver validates hashes before creating a report. Retain a
  // first-class failure report even for preflight/module/launch failures.
  try {
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({
      sourceHead, mode: 'offline static SSR fixtures; browser proof unavailable',
      results: [], errors: [{ error: failure?.message || 'Driver produced no report' }],
      visualInspection: 'NOT PERFORMED',
    }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await fs.writeFile(path.join(outputDir, 'execution.json'), JSON.stringify({
    workflowHead: process.env.PROOF_WORKFLOW_HEAD || null,
    checkoutHead: process.env.PROOF_CHECKOUT_HEAD || null,
    runUrl: process.env.PROOF_RUN_URL || null,
    containerImage: process.env.PROOF_CONTAINER_IMAGE || null,
    playwrightVersion: '1.58.2',
    productFixtureSourceHead: sourceHead,
    executionKitArchiveSha256: '6bd37513d78f8a040efaa141bd24279d38328a6d32a358ae4a84377b18d72938',
    originalArchiveSha256: '285d6a7dff6d33c4947427e12ca55d18ab6b9d4430a7796c4ff040dc8c0026b9',
    inputHashes: hashes,
    automatedChecksPassed: !failure,
    failure: failure?.message || null,
    visualInspectionRequired: true,
    limits: 'Supplied saved static SSR states only. No regenerated SSR, auth, save, unsaved reactive preview, staging or deployment proof.',
  }, null, 2) + '\n');
  if (failure) throw failure;
}

module.exports = { capture, verifyInputs, verifyOutputs, hashes, sourceHead, viewports, names };
if (require.main === module) {
  const [inputDir, outputDir] = process.argv.slice(2);
  if (!inputDir || !outputDir) {
    console.error('Usage: node run-capture.cjs <fixture-directory> <new-output-directory>');
    process.exitCode = 1;
  } else {
    capture(path.resolve(inputDir), path.resolve(outputDir)).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
