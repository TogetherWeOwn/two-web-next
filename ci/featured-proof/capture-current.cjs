// Execute only in the existing authorized offline-proof CI browser container.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function captureScreenshot(page, options, attempts) {
  const screenshot = path.basename(options.path);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const bytes = await page.screenshot(options);
      attempts.push({ screenshot, attempt, success: true });
      return bytes;
    } catch (error) {
      attempts.push({ screenshot, attempt, success: false, error: error.message });
      // Retry only Chromium's capture transport failure, never a timeout or a layout assertion.
      const captureUnavailable = error.message.split('\n')[0] === 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
      if (attempt === 2 || !captureUnavailable) throw error;
    }
  }
}

async function main() {
  const { chromium } = require('playwright');
  const input = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  const manifest = JSON.parse(await fs.readFile(path.join(input, 'manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceHead) || manifest.sourceHead !== process.env.PROOF_CHECKOUT_HEAD) {
    throw new Error('Fixture source head mismatch');
  }
  if (manifest.fixtures.map(f => f.name).join(',') !== 'edit.html,long-content.html,list.html,scheduled.html,upcoming.html') throw new Error('Unexpected fixtures');
  if (!manifest.eventsCspHashes || !/^[A-Za-z0-9+/]{43}=$/.test(manifest.eventsCspHashes.leaf || '') || !/^[A-Za-z0-9+/]{43}=$/.test(manifest.eventsCspHashes.schedule || '')) throw new Error('Upcoming CSP hashes required');
  const eventsDocumentUrl = 'https://events-proof.test/events';
  // Style-relevant subset of the production upcoming policy
  // (src/headers.ts scheduleStyleHashes): L+S hashes in style-src, no
  // unsafe-inline. Recorded in the report; not a byte-identical full policy.
  const eventsCsp = `default-src 'self'; base-uri 'self'; connect-src 'self'; object-src 'none'; img-src 'self'; style-src 'self' 'sha256-${manifest.eventsCspHashes.leaf}' 'sha256-${manifest.eventsCspHashes.schedule}'; script-src 'none'; font-src 'self'; frame-ancestors 'none'; form-action 'self'`;
  const html = {};
  for (const fixture of manifest.fixtures) {
    const bytes = await fs.readFile(path.join(input, fixture.name));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw new Error('Fixture hash mismatch');
    html[fixture.name] = bytes.toString('utf8');
    if (fixture.name === 'upcoming.html') {
      const styles = [...html[fixture.name].matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
      if (styles.length !== 2) throw new Error('Upcoming fixture must carry exactly two style blocks');
      if (crypto.createHash('sha256').update(styles[0]).digest('base64') !== manifest.eventsCspHashes.leaf) throw new Error('Upcoming L hash mismatch');
      if (crypto.createHash('sha256').update(styles[1]).digest('base64') !== manifest.eventsCspHashes.schedule) throw new Error('Upcoming S hash mismatch');
      const rest = html[fixture.name].replace(/<style>[\s\S]*?<\/style>/g, '');
      if (/<script\b|\sstyle=|\son\w+=/i.test(rest)) throw new Error('Active content refused');
    } else if (/<script\b|<style\b|\sstyle=|\son\w+=/i.test(html[fixture.name])) {
      throw new Error('Active content refused');
    }
  }
  await fs.mkdir(output);
  const report = {
    ...manifest, capturedAt: new Date().toISOString(), runUrl: process.env.PROOF_RUN_URL,
    containerImage: process.env.PROOF_CONTAINER_IMAGE, javascriptEnabled: false, offline: true,
    eventsRoute: '/events', eventsCsp, eventsCspScope: 'style-relevant subset mirroring src/headers.ts scheduleStyleHashes (L+S sha256, no unsafe-inline); not the full production policy',
    visualInspection: 'REQUIRED: independent QA must inspect all primary and scrolled-column captures; this report is CSP/rendering evidence, not a visual PASS', results: [], errors: [], captureAttempts: [],
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
        const isUpcoming = fixture.name === 'upcoming.html';
        let eventsBody = isUpcoming ? html[fixture.name] : null;
        await context.route('**/*', route => {
          const url = route.request().url();
          if (isUpcoming && url === eventsDocumentUrl) {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=UTF-8', headers: { 'content-security-policy': eventsCsp }, body: eventsBody });
          }
          attemptedRequests.push(url);
          return route.abort('blockedbyclient');
        });
        const checks = [];
        const check = (name, pass) => checks.push({ name, pass });
        try {
          const page = await context.newPage();
          if (isUpcoming) await page.goto(eventsDocumentUrl, { waitUntil: 'load' });
          else await page.setContent(html[fixture.name], { waitUntil: 'load' });
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
          } else if (fixture.name === 'upcoming.html') {
            check('upcoming heading', (await page.locator('h1').textContent()).trim() === 'Events');
            check('upcoming heading visible', await page.locator('h1').isVisible());
            check('upcoming fictional entries', await page.locator('[data-testid="events-list"] .schedule-row').count() === 2);
            const rules = await page.locator('head style').evaluateAll(nodes => nodes.map(node => node.sheet?.cssRules.length ?? 0));
            check('two inline style blocks applied', rules.length === 2 && rules.every(count => count > 0));
            check('leaf styles applied', await page.locator('footer').evaluate(el => getComputedStyle(el).textAlign) === 'center');
            check('schedule styles applied', await page.locator('.schedule-heading').evaluate(el => getComputedStyle(el).borderLeftWidth) === '4px');
            check('no replaced stylesheet links', ![...html[fixture.name].matchAll(/<link\b[^>]*>/gi)].some(m => /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(m[0])));
            const upcomingBoxes = await page.locator('.schedule-heading, [data-testid="events-list"], .schedule-row').evaluateAll(els => els.map(el => {
              const rect = el.getBoundingClientRect();
              return { left: rect.left, right: rect.right };
            }));
            check('upcoming content fits', upcomingBoxes.length > 0 && upcomingBoxes.every(box => box.left >= 0 && box.right <= viewport.width));
            // Isolated mutation copies under the same response policy
            // (mirrors e2e/schedule-inline-csp.spec.ts): byte drift in L or
            // S, or any other inline style, must be blocked by CSP.
            const styleElements = html[fixture.name].match(/<style>[\s\S]*?<\/style>/g);
            const mutations = [
              ['L byte blocked', html[fixture.name].replace(styleElements[0], `<style>${html[fixture.name].match(/<style>([\s\S]*?)<\/style>/)[1]} </style>`), 'L'],
              ['S byte blocked', html[fixture.name].replace(styleElements[1], `<style>${[...html[fixture.name].matchAll(/<style>([\s\S]*?)<\/style>/g)][1][1]} </style>`), 'S'],
              ['arbitrary inline blocked', html[fixture.name].replace('</head>', '<style>body{display:none}</style></head>'), 'arbitrary'],
            ];
            for (const [name, body, kind] of mutations) {
              eventsBody = body;
              await page.goto(eventsDocumentUrl, { waitUntil: 'load' });
              const mutatedRules = await page.locator('head style').evaluateAll(nodes => nodes.map(node => node.sheet?.cssRules.length ?? 0));
              if (kind === 'L') check(name, mutatedRules.length === 2 && mutatedRules[0] === 0 && mutatedRules[1] > 0);
              else if (kind === 'S') check(name, mutatedRules.length === 2 && mutatedRules[1] === 0 && mutatedRules[0] > 0);
              else check(name, mutatedRules.length === 3 && mutatedRules[2] === 0 && mutatedRules[0] > 0 && mutatedRules[1] > 0);
            }
            eventsBody = html[fixture.name];
            await page.goto(eventsDocumentUrl, { waitUntil: 'load' });
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
          if (isUpcoming) {
            // The document itself is fulfilled offline; other subresources
            // (Display font preload) are attempted and blocked, as in
            // production. Only the four replaced stylesheet requests must
            // be absent.
            check('no replaced stylesheet requests', !attemptedRequests.some(url => /\/(?:styles|theme-tokens|theme|schedule-theme)\.css(?:\?|$)/.test(url)));
          } else {
            check('external stylesheet applied', await page.locator('main').evaluate(el => getComputedStyle(el).paddingLeft) === '24px');
            check('no network requests', attemptedRequests.length === 0);
          }
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
  const passed = report.errors.length === 0 && report.results.length === 10 && report.results.every(r => r.checks.every(c => c.pass));
  console.log(JSON.stringify({ automatedChecksPassed: passed, screenshots: report.results.reduce((count, result) => count + 1 + result.scrolledCaptures.length, 0), sourceHead: report.sourceHead }));
  if (!passed) process.exitCode = 1;
}
module.exports = { captureScreenshot };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
