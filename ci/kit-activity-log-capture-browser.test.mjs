import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, errors } from "@playwright/test";
import { requireGithubRunner } from "../e2e/ci-only.mjs";
import { WCAG_AA_TAGS } from "./a11y-policy.mjs";
import { routeA11y } from "./kit-activity-log-metrics.mjs";
import { validatePngDirectory, viewportPngs } from "./kit-activity-log-png.mjs";
import {
  collectVisuals,
  expectedContent,
  origin,
  path,
  withDeadline,
} from "./kit-activity-log-visual.mjs";

requireGithubRunner();

function captureDocument(empty) {
  const [, rows, [subject], link] = expectedContent(empty);
  const cells = rows.map((row) => `<tr><td>${row.split("|").join("</td><td>")}</td></tr>`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Activity log — TWO admin</title>
  <style>
    [data-testid=activity-log-table-scroll] { overflow-x: auto; }
    [data-testid=activity-log-table-scroll]:focus-visible { outline: 2px solid; }
    table { min-inline-size: 42rem; }
    a { display: inline-block; }
    a, button, input { min-block-size: 24px; min-inline-size: 24px; }
  </style>
  <header><a href="#main">Skip to content</a> <a href="/">TWO admin</a>
    <nav aria-label="Admin"><a href="/events">Events</a> · <a href="/featured">Featured</a> ·
      <a href="/join">Join attempts</a> · <a href="${path}">Activity log</a> · <a href="/">Site</a></nav></header>
  <main id="main"><h1>Activity log</h1>
    <p>Read-only. Who changed what, when (UTC). Views that name a member are access-logged; imported causer IDs are labeled legacy.</p>
    <form><label for="subject">Subject</label> <input type="search" id="subject" value="${subject}">
      <label for="causer">Causer</label> <input type="search" id="causer"> <button>Filter</button></form>
    <p>Scroll horizontally to see all columns on smaller screens.</p>
    <div role="region" aria-label="Activity log list" tabindex="0" data-testid="activity-log-table-scroll">
      <table><thead><tr><th scope="col">Who</th><th scope="col">What</th><th scope="col">When (UTC)</th><th scope="col">Subject</th></tr></thead>
      <tbody>${empty ? `<tr><td colspan="4">${rows[0]}</td></tr>` : cells.join("")}</tbody></table></div>
    ${empty ? `<p data-testid="activity-log-recovery"><a href="${link}">Clear filters</a></p>Page 1` : `Page 1 <a rel="next" href="${link}">Next</a>`}
  </main><footer>Together We Own · moderators only</footer></html>`;
}

test("guarded capture completes five synthetic views and locates a keyboard-scroll deadline", {
  timeout: 30_000,
}, async (t) => {
  const url = new URL(origin);
  const dir = mkdtempSync(join(tmpdir(), "activity-log-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const populated = captureDocument(false);
  const empty = captureDocument(true);
  let clip = false;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || ![path, `${path}?subject=zz-no-activity`].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "x-two-renderer": "kit",
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
    });
    const body = req.url === path ? populated : empty;
    res.end(clip ? body.replace("overflow-x: auto", "overflow-x: clip") : body);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(Number(url.port), url.hostname, resolve),
  );
  const browser = await chromium.launch({
    args: ["--proxy-server=http://127.0.0.1:9", `--proxy-bypass-list=<-loopback>;${origin}`],
  });
  t.after(() => browser.close());
  let last;
  const audits = [];
  const options = {
    signal: AbortSignal.timeout(30_000),
    TimeoutError: errors.TimeoutError,
    mark: (...step) => {
      last = step;
    },
    audit: async (page, name, step) => {
      const result = await routeA11y(page, step);
      const pass = "a11y: PASS violations=0 incomplete=0";
      if (result !== pass) {
        const ruleIds = await withDeadline(() =>
          page.evaluate(async (tags) => {
            const { violations, incomplete } = await globalThis.axe.run(document, {
              runOnly: { type: "tag", values: tags },
            });
            return [...violations, ...incomplete].slice(0, 8).map(({ id }) => id);
          }, WCAG_AA_TAGS),
        );
        assert.equal(result, pass, `${name}: ${ruleIds.join(", ")}`);
      }
      audits.push(name);
    },
    measure: async (page) => {
      const [width, height] = viewportPngs["keyboard-mobile.png"];
      await page.setViewportSize({ width, height });
      // Arm the legacy predicate before the key so its first sample is known to be false.
      for (let n = 0; n < 11; n++) await page.keyboard.press("Tab");
      const scroller = page.getByTestId("activity-log-table-scroll");
      assert.equal(
        await scroller.evaluate(
          (el) =>
            el === document.activeElement && el.scrollLeft === 0 && el.scrollWidth > el.clientWidth,
        ),
        true,
      );
      const legacy = assert.rejects(
        page.waitForFunction(
          () => {
            document.documentElement.dataset.sampled = "true";
            return document.activeElement.scrollLeft > 0;
          },
          undefined,
          { timeout: 2_000 },
        ),
        errors.TimeoutError,
      );
      await page.locator("html").waitForFunction((el) => el.dataset.sampled === "true");
      await page.keyboard.press("ArrowRight");
      await scroller.waitForFunction((el) => el === document.activeElement && el.scrollLeft > 0);
      await legacy;
      return "legacy wait timed out after native scrolling";
    },
  };
  const mint = () => ({ name: "fixture", value: "synthetic", url: origin });
  assert.equal(
    await collectVisuals(browser, mint, dir, options),
    "legacy wait timed out after native scrolling",
  );
  assert.deepEqual(
    validatePngDirectory(dir).map(({ name }) => name),
    Object.keys(viewportPngs),
  );
  assert.deepEqual(audits, ["populated-desktop.png", "empty-desktop.png"]);
  t.diagnostic(
    "Five synthetic viewport PNGs validated, both desktop axe audits passed, and the legacy wait timed out despite native scrolling.",
  );

  clip = true;
  const refused = mkdtempSync(join(dir, "refused-"));
  await assert.rejects(collectVisuals(browser, mint, refused, options), errors.TimeoutError);
  assert.deepEqual(last, ["CAPTURE", "KEYBOARD_MOBILE", "KEYBOARD_SCROLL"]);
  assert.deepEqual(
    readdirSync(refused).sort(),
    Object.keys(viewportPngs)
      .filter((name) => name !== "keyboard-mobile.png")
      .sort(),
  );
  t.diagnostic(
    "Forced no-scroll fixture: DEADLINE stage=CAPTURE viewport=KEYBOARD_MOBILE operation=KEYBOARD_SCROLL",
  );
});
