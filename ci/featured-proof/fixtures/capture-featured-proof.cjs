// Run only in an already-authorized browser runtime. No server, DB, or credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const fixtures = [
  { name: 'edit.html', sha256: 'aba57e42f9efda9a36281a765a701c3a31d3825cf6b54673fbfaf50e24969ef0' },
  { name: 'list.html', sha256: '3c8eeef8a59b6f4d76347ad5bb5dbe2eb1c6639d991adb79f1d554ba107fd496' },
  { name: 'scheduled.html', sha256: '1cb19d7b580e12b9c6ecb51557865f1ebc130b932456a028bea7aa36ec0f72f0' },
];
const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];

async function main() {
  const inputDir = path.resolve(process.argv[2] || __dirname);
  const outputDir = path.resolve(process.argv[3] || path.join(inputDir, 'proof-output'));
  const html = {};
  for (const fixture of fixtures) {
    const bytes = await fs.readFile(path.join(inputDir, fixture.name));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) {
      throw new Error(`Fixture hash mismatch: ${fixture.name}`);
    }
    html[fixture.name] = bytes.toString('utf8');
    if (/<script\b|\son\w+\s*=/i.test(html[fixture.name])) {
      throw new Error(`Active content refused: ${fixture.name}`);
    }
  }
  await fs.mkdir(outputDir); // Refuse to overwrite a previous capture.
  const report = {
    sourceHead: '582d5f93eb2a63194b9cbd4ebc4ce1abbdf9d348',
    originalArchiveSha256: '285d6a7dff6d33c4947427e12ca55d18ab6b9d4430a7796c4ff040dc8c0026b9',
    capturedAt: new Date().toISOString(),
    fixtures, mode: 'offline static SSR fixtures; not deployed-app or save-interaction proof',
    javascriptEnabled: false, offline: true, serviceWorkers: 'block',
    visualInspection: 'REQUIRED: QA must inspect all screenshots before accepting layout',
    results: [], errors: [],
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    report.browserVersion = browser.version();
    for (const viewport of viewports) {
      for (const fixture of fixtures) {
        const context = await browser.newContext({ viewport, offline: true, javaScriptEnabled: false, serviceWorkers: 'block' });
        const attemptedRequests = [];
        const checks = [];
        await context.route('**/*', route => {
          attemptedRequests.push(route.request().url());
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        try {
          await page.setContent(html[fixture.name], { waitUntil: 'load' });
          const expect = (name, pass) => checks.push({ name, pass });
          if (fixture.name === 'edit.html') {
            const item = page.locator('[data-testid="featured-item"]');
            expect('live card visible', await item.isVisible());
            expect('live badge visible', await page.locator('[data-status="live"]').isVisible());
            expect('fictional title', (await item.locator('h3').innerText()) === 'Friday games');
            expect('body line break preserved', (await item.locator('.featured-body').innerText()) === 'Bring a friend.\nEveryone is welcome.');
            expect('saved-preview disclosure', (await page.locator('[data-testid="featured-preview"]').innerText()).includes('Save changes to refresh this preview.'));
          } else if (fixture.name === 'list.html') {
            expect('four status badges', await page.locator('[data-status]').count() === 4);
            for (const status of ['live', 'scheduled', 'expired', 'unpublished']) {
              const badge = page.locator(`[data-status="${status}"]`);
              expect(`${status} status visible and labelled`, await badge.isVisible() && (await badge.innerText()) === status);
            }
          } else {
            expect('scheduled badge visible', await page.locator('[data-status="scheduled"]').isVisible());
            expect('scheduled hidden notice', await page.locator('[data-testid="featured-preview-hidden"]').isVisible());
            expect('scheduled public card absent', await page.locator('[data-testid="featured-item"]').count() === 0);
          }
          const layout = await page.evaluate(() => ({
            viewportWidth: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            primaryElements: [...document.querySelectorAll('[data-testid="featured-preview"], [data-testid="featured-item"], [data-testid="featured-preview-hidden"], [data-status], [data-testid="featured-table"]')].map(el => {
              const r = el.getBoundingClientRect();
              return { testId: el.getAttribute('data-testid'), status: el.getAttribute('data-status'), x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
            }),
          }));
          layout.horizontalOverflowPx = Math.max(0, layout.documentWidth - viewport.width);
          expect('no external network requests', attemptedRequests.length === 0);
          const screenshot = `${path.basename(fixture.name, '.html')}-${viewport.width}x${viewport.height}.png`;
          await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: true });
          report.results.push({ fixture: fixture.name, viewport, screenshot, checks, layout, attemptedRequests });
        } catch (error) {
          report.errors.push({ fixture: fixture.name, viewport, error: error.message });
        } finally {
          await context.close();
        }
      }
    }
  } catch (error) {
    report.errors.push({ error: error.message });
  } finally {
    if (browser) await browser.close();
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  const passed = report.errors.length === 0 && report.results.length === 6 && report.results.every(r => r.checks.every(c => c.pass));
  console.log(JSON.stringify({ automatedChecksPassed: passed, screenshots: report.results.length, outputDir, visualInspectionRequired: true }));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
