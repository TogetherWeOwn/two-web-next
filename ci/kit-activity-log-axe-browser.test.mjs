import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { requireGithubRunner } from "../e2e/ci-only.mjs";
import { routeA11y } from "./kit-activity-log-metrics.mjs";
import {
  BrowserDeadline,
  origin,
  path,
  withAxeScripting,
  withDeadline,
} from "./kit-activity-log-visual.mjs";

requireGithubRunner();

test("activity-log axe execution under the existing browser deadline", {
  timeout: 30_000,
}, async (t) => {
  const browser = await chromium.launch({
    args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"],
  });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()}`);

  async function withFixture(javaScriptEnabled, audit, lang = ' lang="en"', extra = "") {
    const context = await browser.newContext({
      javaScriptEnabled,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    try {
      const url = `${origin}${path}`;
      await context.route("**/*", (route) =>
        route.request().url() === url && route.request().isNavigationRequest()
          ? route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `<!doctype html><html${lang}><title>Audit fixture</title><main><h1>Activity log fixture</h1>${extra}</main></html>`,
            })
          : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 5_000 });
      await audit(page);
    } finally {
      await context.close();
    }
  }

  await t.test("red baseline: render-only document times out after axe injection", async () => {
    await withFixture(false, async (page) => {
      const stages = [];
      await assert.rejects(
        routeA11y(page, (stage) => stages.push(stage)),
        BrowserDeadline,
      );
      assert.deepEqual(stages, ["AXE_INJECT", "AXE_EVALUATE"]);
    });
  });

  // The enabled context is a causal control on synthetic HTML only, not a harness change.
  await t.test(
    "green control: same document completes with browser scripting enabled",
    async () => {
      await withFixture(true, async (page) => {
        assert.equal(await routeA11y(page, () => {}), "a11y: PASS violations=0 incomplete=0");
      });
    },
  );

  await t.test(
    "scoped audit completes while document-authored scripting stays blocked",
    async () => {
      await withFixture(
        false,
        async (page) => {
          await withAxeScripting(page, async () => {
            const directive = await withDeadline(() =>
              page.evaluate(() => {
                const blocked = new Promise((resolve) => {
                  document.addEventListener(
                    "securitypolicyviolation",
                    (event) => {
                      resolve(event.effectiveDirective);
                    },
                    { once: true },
                  );
                });
                document.querySelector("button").click();
                return blocked;
              }),
            );
            assert.equal(directive, "script-src-attr");
            assert.equal(await page.locator("html").getAttribute("data-authored"), null);
            assert.equal(await routeA11y(page, () => {}), "a11y: PASS violations=0 incomplete=0");
          });
        },
        ' lang="en"',
        `<script>document.documentElement.dataset.authored = 'load'</script>
       <button onclick="document.documentElement.dataset.authored = 'click'">Test button</button>`,
      );
    },
  );

  await t.test(
    "negative control: missing document language still fails the WCAG AA audit",
    async () => {
      await withFixture(
        false,
        async (page) => {
          assert.match(
            await withAxeScripting(page, () => routeA11y(page, () => {})),
            /^a11y: FAIL violations=[1-9]\d* incomplete=\d+$/,
          );
        },
        "",
      );
    },
  );
});
