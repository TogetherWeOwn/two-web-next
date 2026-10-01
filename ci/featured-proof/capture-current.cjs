// Execute only in the existing authorized offline-proof CI browser container.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

async function main() {
  const input = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  const manifest = JSON.parse(await fs.readFile(path.join(input, 'manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceHead) || manifest.sourceHead !== process.env.PROOF_CHECKOUT_HEAD) {
    throw new Error('Fixture source head mismatch');
  }
  if (manifest.fixtures.map(f => f.name).join(',') !== 'edit.html,long-content.html,list.html,scheduled.html') throw new Error('Unexpected fixtures');
  const html = {};
  for (const fixture of manifest.fixtures) {
    const bytes = await fs.readFile(path.join(input, fixture.name));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw new Error('Fixture hash mismatch');
    html[fixture.name] = bytes.toString('utf8');
    if (/<script\b|<style\b|\sstyle=|\son\w+=/i.test(html[fixture.name])) throw new Error('Active content refused');
  }
  await fs.mkdir(output);
  const report = {
    ...manifest, capturedAt: new Date().toISOString(), runUrl: process.env.PROOF_RUN_URL,
    containerImage: process.env.PROOF_CONTAINER_IMAGE, javascriptEnabled: false, offline: true,
    visualInspection: 'REQUIRED: independent QA must inspect all primary and scrolled-column captures', results: [], errors: [],
  };
  let browser;
  try {
    report.playwrightVersion = require('playwright/package.json').version;
    if (report.playwrightVersion !== '1.58.2') throw new Error('Capture requires the container-matched Playwright 1.58.2 module');
    browser = await chromium.launch({ headless: true });
    report.browserVersion = browser.version();
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      for (const fixture of manifest.fixtures) {
        const context = await browser.newContext({ viewport, offline: true, javaScriptEnabled: false, serviceWorkers: 'block' });
        const attemptedRequests = [];
        await context.route('**/*', route => { attemptedRequests.push(route.request().url()); return route.abort('blockedbyclient'); });
        const checks = [];
        const check = (name, pass) => checks.push({ name, pass });
        try {
          const page = await context.newPage();
          await page.setContent(html[fixture.name], { waitUntil: 'load' });
          if (fixture.name === 'edit.html' || fixture.name === 'long-content.html') {
            check('saved live card', await page.locator('[data-testid="featured-item"]').isVisible());
            check('live label', await page.locator('[data-status="live"]').isVisible());
            check('saved-content disclosure', (await page.locator('[data-testid="featured-preview"]').innerText()).includes('Save changes to refresh this preview'));
          } else if (fixture.name === 'list.html') {
            check('four status badges', await page.locator('[data-status]').count() === 4);
            for (const status of ['live', 'scheduled', 'expired', 'unpublished']) {
              const badge = page.locator(`[data-status="${status}"]`);
              check(`${status} label visible`, await badge.isVisible() && (await badge.innerText()) === status);
              check(`${status} label fits one line`, await badge.evaluate(el => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return range.getClientRects().length === 1;
              }));
            }
            check('native five-column table', await page.locator('thead th').count() === 5);
            check('named keyboard scroll region', await page.locator('[data-testid="featured-table-scroll"]').evaluate(el =>
              el.getAttribute('role') === 'region' && el.getAttribute('tabindex') === '0' &&
              el.getAttribute('aria-label') === 'Featured content list' &&
              document.getElementById(el.getAttribute('aria-describedby'))?.textContent.includes('Scroll horizontally')));
            check('title words never split across lines', await page.locator('tbody tr td:first-child a').evaluateAll(links => links.every(el => {
              const node = el.firstChild;
              const cell = el.closest('td').getBoundingClientRect();
              return [...node.textContent.matchAll(/\S+/g)].every(word => {
                const range = document.createRange();
                range.setStart(node, word.index);
                range.setEnd(node, word.index + word[0].length);
                const rects = [...range.getClientRects()];
                return rects.length === 1 && rects[0].left >= cell.left && rects[0].right <= cell.right + 0.5;
              });
            })));
            for (const selector of ['thead th', 'time']) {
              check(`${selector} text stays on one line inside its cell`, await page.locator(selector).evaluateAll(elements => elements.every(el => {
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                const rects = [];
                while (walker.nextNode()) {
                  if (!walker.currentNode.textContent.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(walker.currentNode);
                  rects.push(...range.getClientRects());
                }
                const cell = el.closest('th, td').getBoundingClientRect();
                return rects.length > 0 && rects.every(rect => Math.abs(rect.top - rects[0].top) < 0.5 && rect.left >= cell.left && rect.right <= cell.right + 0.5);
              })));
            }
            const scroll = page.locator('[data-testid="featured-table-scroll"]');
            await scroll.focus();
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => document.querySelector('[data-testid="featured-table-scroll"]').scrollLeft > 0);
            check('keyboard can scroll the list', await scroll.evaluate(el => el.scrollLeft > 0));
            await scroll.evaluate(el => { el.scrollLeft = 0; });
          } else {
            check('scheduled label', await page.locator('[data-status="scheduled"]').isVisible());
            check('hidden notice', await page.locator('[data-testid="featured-preview-hidden"]').isVisible());
            check('no scheduled public card', await page.locator('[data-testid="featured-item"]').count() === 0);
          }
          if (fixture.name === 'long-content.html') {
            const card = page.locator('[data-testid="featured-item"]');
            check('long headline preserved', (await card.locator('h3').textContent()) === 'a'.repeat(255));
            check('long body preserved', (await card.locator('p').textContent()) === `https://example.test/${'a'.repeat(400)}`);
            for (const selector of ['h3', 'p']) {
              check(`long ${selector} wraps inside card`, await card.locator(selector).evaluate(el => {
                const card = el.closest('[data-testid="featured-item"]').getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const lines = [...range.getClientRects()];
                return lines.length > 1 && lines.every(line => line.left >= card.left && line.right <= card.right + 0.5);
              }));
            }
          }
          const layout = await page.evaluate(() => ({
            viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
            elements: [...document.querySelectorAll('[data-testid="featured-table-scroll"], [data-testid="featured-table"], [data-status], [data-testid="featured-preview"]')].map(el => {
              const r = el.getBoundingClientRect();
              const region = el.closest('[data-testid="featured-table-scroll"]');
              return { testId: el.getAttribute('data-testid'), status: el.getAttribute('data-status'), left: r.left, right: r.right, width: r.width, scrollContent: region !== null && region !== el };
            }),
          }));
          layout.horizontalOverflowPx = Math.max(0, layout.documentWidth - viewport.width);
          check('no horizontal document overflow', layout.horizontalOverflowPx === 0);
          check('primary elements fit viewport', layout.elements.filter(el => !el.scrollContent).every(el => el.left >= 0 && el.right <= viewport.width));
          check('external stylesheet applied', await page.locator('main').evaluate(el => getComputedStyle(el).paddingLeft) === '24px');
          check('no network requests', attemptedRequests.length === 0);
          const screenshot = `${path.basename(fixture.name, '.html')}-${viewport.width}x${viewport.height}.png`;
          await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
          const scrolledCaptures = [];
          if (fixture.name === 'list.html') {
            for (const column of [{ index: 3, name: 'window' }, { index: 4, name: 'last-changed' }]) {
              const header = page.locator('thead th').nth(column.index);
              await header.evaluate(el => {
                const region = el.closest('[data-testid="featured-table-scroll"]');
                region.scrollLeft += el.getBoundingClientRect().left - region.getBoundingClientRect().left;
              });
              check(`${column.name} column reachable inside scroll region`, await header.evaluate(el => {
                const region = el.closest('[data-testid="featured-table-scroll"]').getBoundingClientRect();
                const rect = el.getBoundingClientRect();
                return rect.left >= region.left - 0.5 && rect.right <= region.right + 0.5;
              }));
              const filename = `list-${column.name}-${viewport.width}x${viewport.height}.png`;
              await page.screenshot({ path: path.join(output, filename), fullPage: true });
              scrolledCaptures.push({ column: column.name, screenshot: filename, scrollLeft: await page.locator('[data-testid="featured-table-scroll"]').evaluate(el => el.scrollLeft) });
            }
          }
          report.results.push({ fixture: fixture.name, viewport, screenshot, scrolledCaptures, checks, layout, attemptedRequests });
        } catch (error) {
          report.errors.push({ fixture: fixture.name, viewport, error: error.message });
        } finally { await context.close(); }
      }
    }
  } catch (error) { report.errors.push({ error: error.message }); }
  finally {
    if (browser) await browser.close();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.copyFile(path.join(input, 'manifest.json'), path.join(output, 'manifest.json'));
  }
  const passed = report.errors.length === 0 && report.results.length === 8 && report.results.every(r => r.checks.every(c => c.pass));
  console.log(JSON.stringify({ automatedChecksPassed: passed, screenshots: report.results.reduce((count, result) => count + 1 + result.scrolledCaptures.length, 0), sourceHead: report.sourceHead }));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
