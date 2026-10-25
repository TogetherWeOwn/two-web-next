// Execute only in the existing authorized offline-proof CI browser container.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const CAPTURE_UNAVAILABLE = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
// Chromium's capture transport failure only, never a timeout or a layout assertion.
const isCaptureUnavailable = error => error.message.split('\n')[0] === CAPTURE_UNAVAILABLE;
// A browser that cannot capture two views is broken, not flaky: stay red.
const MAX_VIEW_RECOVERIES = 2;

async function captureScreenshot(page, options, attempts) {
  const screenshot = path.basename(options.path);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const bytes = await page.screenshot(options);
      attempts.push({ screenshot, attempt, success: true });
      return bytes;
    } catch (error) {
      attempts.push({ screenshot, attempt, success: false, error: error.message });
      if (attempt === 2 || !isCaptureUnavailable(error)) throw error;
    }
  }
}

// Best-effort evidence about a page whose capture failed twice. Nothing here can pass a view
// or write a PNG; it only records where the failure sits (browser, page, layout, raw CDP capture).
async function captureDiagnostics(browser, context, page) {
  const diagnostics = { browserConnected: browser.isConnected?.(), pageClosed: page?.isClosed?.() };
  let session;
  try {
    session = await context.newCDPSession(page);
    diagnostics.layoutMetrics = await session.send('Page.getLayoutMetrics');
    const viewportOnly = await session.send('Page.captureScreenshot', { format: 'png' });
    diagnostics.viewportOnlyCaptureBytes = Buffer.from(viewportOnly.data, 'base64').length;
  } catch (error) { diagnostics.probeError = error.message.split('\n')[0]; }
  finally { await session?.detach().catch(() => {}); }
  return diagnostics;
}

// Run one view; when only the capture transport failed (twice, on the same page), discard the
// browser and run the whole view again in a fresh one, so every check is evaluated again. A second
// failure, or any failed check or attempted request in the discarded run, stays an error.
async function captureViewWithRecovery({ attemptView, relaunch, recoveries, view }) {
  try { return { result: await attemptView() }; } catch (error) {
    const failure = error.captureFailure;
    if (!failure || recoveries.length >= MAX_VIEW_RECOVERIES || failure.checks.length === 0 ||
        !failure.checks.every(c => c.pass) || failure.attemptedRequests.length !== 0) return { error };
    const recovery = { ...view, firstError: error.message, ...failure, outcome: 'failed' };
    recoveries.push(recovery);
    try {
      await relaunch();
      const result = await attemptView();
      recovery.outcome = 'recovered';
      return { result };
    } catch (second) {
      recovery.secondError = second.message;
      return { error: second };
    }
  }
}

async function captureView(browser, html, fixture, viewport, output, report) {
  const context = await browser.newContext({ viewport, offline: true, javaScriptEnabled: false, serviceWorkers: 'block' });
  const attemptedRequests = [];
  await context.route('**/*', route => { attemptedRequests.push(route.request().url()); return route.abort('blockedbyclient'); });
  const checks = [];
  const check = (name, pass) => checks.push({ name, pass });
  let page;
  try {
    page = await context.newPage();
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
      check('keyboard scroll region receives focus', await scroll.evaluate(el => document.activeElement === el));
      await page.keyboard.press('ArrowRight');
      // Poll from Node: page-side animation-frame waits cannot run with JavaScript disabled.
      let keyboardScrollPx = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        keyboardScrollPx = await scroll.evaluate(el => el.scrollLeft);
        if (keyboardScrollPx > 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      check('keyboard can scroll the list', keyboardScrollPx > 0);
      await scroll.evaluate(el => { el.scrollLeft = 0; });
    } else {
      check('scheduled label', await page.locator('[data-status="scheduled"]').isVisible());
      check('saved scheduled card', await page.locator('[data-testid="featured-item"]').isVisible());
      check('saved-content disclosure', (await page.locator('[data-testid="featured-preview"]').innerText()).includes('Save changes to refresh this preview'));
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
    await captureScreenshot(page, { path: path.join(output, screenshot), fullPage: true }, report.captureAttempts);
    const scrolledCaptures = [];
    if (fixture.name === 'list.html') {
      for (const column of [{ index: 3, name: 'window' }, { index: 4, name: 'last-changed' }]) {
        const header = page.locator('thead th').nth(column.index);
        await header.evaluate(el => {
          const region = el.closest('[data-testid="featured-table-scroll"]');
          // Snap to a whole device pixel: identical geometry recorded scrollLeft 548
          // vs 549 across runs, flipping the 0.5px edge check without moving the column.
          region.scrollLeft = Math.round(region.scrollLeft + el.getBoundingClientRect().left - region.getBoundingClientRect().left);
        });
        check(`${column.name} column reachable inside scroll region`, await header.evaluate(el => {
          const region = el.closest('[data-testid="featured-table-scroll"]').getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          const tolerancePx = 1.5;
          return rect.left >= region.left - tolerancePx && rect.right <= region.right + tolerancePx;
        }));
        const filename = `list-${column.name}-${viewport.width}x${viewport.height}.png`;
        await captureScreenshot(page, { path: path.join(output, filename), fullPage: true }, report.captureAttempts);
        scrolledCaptures.push({ column: column.name, screenshot: filename, scrollLeft: await page.locator('[data-testid="featured-table-scroll"]').evaluate(el => el.scrollLeft) });
      }
    }
    return { fixture: fixture.name, viewport, screenshot, scrolledCaptures, checks, layout, attemptedRequests };
  } catch (error) {
    // Keep what the discarded context saw: recovery is only allowed when nothing but the capture failed.
    if (isCaptureUnavailable(error)) error.captureFailure = { checks, attemptedRequests, diagnostics: await captureDiagnostics(browser, context, page) };
    throw error;
  } finally { await context.close(); }
}

async function main() {
  const { chromium } = require('playwright');
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
    visualInspection: 'REQUIRED: independent QA must inspect all primary and scrolled-column captures', results: [], errors: [], captureAttempts: [], recoveries: [],
  };
  let browser;
  try {
    report.playwrightVersion = require('playwright/package.json').version;
    if (report.playwrightVersion !== '1.58.2') throw new Error('Capture requires the container-matched Playwright 1.58.2 module');
    const launch = async () => { browser = await chromium.launch({ headless: true }); };
    await launch();
    report.browserVersion = browser.version();
    // Recovery launches the same pinned browser; a different build is not a retry of the same proof.
    const relaunch = async () => {
      await browser.close().catch(() => {});
      await launch();
      if (browser.version() !== report.browserVersion) throw new Error('Relaunched browser version changed');
    };
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      for (const fixture of manifest.fixtures) {
        const { result, error } = await captureViewWithRecovery({
          attemptView: () => captureView(browser, html, fixture, viewport, output, report),
          relaunch, recoveries: report.recoveries, view: { fixture: fixture.name, viewport },
        });
        if (result) report.results.push(result);
        else report.errors.push({ fixture: fixture.name, viewport, error: error.message });
      }
    }
  } catch (error) { report.errors.push({ error: error.message }); }
  finally {
    if (browser) await browser.close();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.copyFile(path.join(input, 'manifest.json'), path.join(output, 'manifest.json'));
  }
  const passed = report.errors.length === 0 && report.results.length === 8 && report.results.every(r => r.checks.every(c => c.pass));
  for (const r of report.recoveries) console.error(`::warning title=featured capture recovered::${r.fixture} ${r.viewport.width}x${r.viewport.height}: ${r.outcome} in a fresh browser`);
  console.log(JSON.stringify({
    automatedChecksPassed: passed, screenshots: report.results.reduce((count, result) => count + 1 + result.scrolledCaptures.length, 0), sourceHead: report.sourceHead,
    ...(report.recoveries.length ? { recoveredViews: report.recoveries.filter(r => r.outcome === 'recovered').length } : {}),
  }));
  if (!passed) process.exitCode = 1;
}
module.exports = { captureScreenshot, captureViewWithRecovery, isCaptureUnavailable, MAX_VIEW_RECOVERIES };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
