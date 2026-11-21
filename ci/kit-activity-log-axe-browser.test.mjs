import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { requireGithubRunner } from "../e2e/ci-only.mjs";
import { routeA11y } from "./kit-activity-log-metrics.mjs";
import {
  BrowserDeadline,
  origin,
  path,
  prepareDesktopAudit,
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

  async function withFixture(scripting, audit, lang = ' lang="en"', extra = "") {
    const context = await browser.newContext({
      javaScriptEnabled: scripting !== false,
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
      const runAudit = scripting === "scoped" ? await prepareDesktopAudit(page) : null;
      await page.goto(url, { waitUntil: "load", timeout: 5_000 });
      await audit(page, runAudit);
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
        "scoped",
        async (page, runAudit) => {
          // Chromium only parses these fallback elements in render-only mode.
          assert.equal(await page.locator("noscript p").count(), 1);
          assert.equal(await page.locator("html").getAttribute("data-authored"), null);
          await runAudit(async () => {
            const directive = await withDeadline(() =>
              page.evaluate(() => {
                const blocked = new Promise((resolve) => {
                  document.addEventListener("securitypolicyviolation", (event) => {
                    if (event.effectiveDirective === "script-src-elem") {
                      resolve(event.effectiveDirective);
                    }
                  });
                });
                document.querySelector("button").click();
                // A handler parsed with scripting off may not emit a violation.
                // Append a fresh script with scheduling on to exercise the CSP itself.
                const script = document.createElement("script");
                script.textContent = "document.documentElement.dataset.authored = 'dynamic'";
                document.head.append(script);
                return blocked;
              }),
            );
            assert.equal(directive, "script-src-elem");
            assert.equal(await page.locator("html").getAttribute("data-authored"), null);
            assert.equal(await routeA11y(page, () => {}), "a11y: PASS violations=0 incomplete=0");
          });
          await assert.rejects(
            withDeadline(
              () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))),
              500,
            ),
            BrowserDeadline,
          );
        },
        ' lang="en"',
        `<script>document.documentElement.dataset.authored = 'load'</script>
       <noscript><p>Render-only fallback</p></noscript>
       <button onclick="document.documentElement.dataset.authored = 'click'">Test button</button>`,
      );
    },
  );

  await t.test(
    "negative control: missing document language still fails the WCAG AA audit",
    async () => {
      await withFixture(
        "scoped",
        async (page, runAudit) => {
          assert.match(
            await runAudit(() => routeA11y(page, () => {})),
            /^a11y: FAIL violations=[1-9]\d* incomplete=\d+$/,
          );
        },
        "",
      );
    },
  );
});
