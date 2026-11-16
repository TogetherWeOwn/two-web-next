import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const evidence =
  process.env.KIT_CALENDAR_CONTROLS_EVIDENCE_DIR ??
  (process.env.CI ? "artifacts/kit-calendar-controls" : undefined);
const viewports = [
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
];

// Synthetic props only. The component is the real one, server-rendered by the
// Kit fixture build with JavaScript disabled and every request routed offline.
const fixturePage = (state, gameFilter, searching) => `<script>
import CalendarControls from '#lib/CalendarControls.svelte';
</script>
<main class="base-theme">
  <CalendarControls state={${state}} appUrl="https://example.test" games={["Chess", "Go"]}
    gameFilter={${gameFilter}} searching={${searching}} pastCount={2} emptyState={null}
    hasVisibleResults={true} outOfRange={false} />
</main>`;
const scenarios = {
  default: fixturePage(
    `{ view: "calendar", month: "2026-11", q: "", past: false, page: 1 }`,
    "null",
    false,
  ),
  search: fixturePage(
    `{ view: "list", month: "2026-11", q: "night", game: "Go", past: true, page: 1 }`,
    `"Go"`,
    true,
  ),
};

for (const [scenario, page] of Object.entries(scenarios)) {
  test(`calendar controls ${scenario} state works server-rendered without JavaScript`, {
    timeout: 300000,
  }, async () => {
    if (evidence) mkdirSync(evidence, { recursive: true });
    await withKitOfflineBrowser({ page }, async ({ page, html }) => {
      const id = (testid) => page.getByTestId(testid);
      assert.match(html, /data-testid="events-view-list"/, "markup comes from SSR");
      for (const [name, width, height] of viewports) {
        await page.setViewportSize({ width, height });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        assert.ok(overflow <= 0, `no horizontal overflow at ${width}px`);
        if (evidence)
          await page.screenshot({
            path: join(evidence, `calendar-controls-${scenario}-${name}.png`),
            fullPage: true,
          });
      }
      const box = await page.locator('p[role="status"].sr-only').first().boundingBox();
      assert.ok(box && box.width <= 1 && box.height <= 1, "status regions stay visually hidden");
      assert.equal(await id("subscription-copy-button").isHidden(), true, "copy needs JavaScript");
      assert.equal(
        await id("subscription-manual-copy").isVisible(),
        false,
        "closed help is hidden",
      );
      const help = id("subscription-help");
      await help.locator("summary").click();
      assert.equal(await help.evaluate((el) => el.open), true, "native details opens");
      assert.equal(await id("subscription-manual-copy").isVisible(), true);
      assert.equal(await id("subscription-feed-url").getAttribute("readonly"), "");
      const submitted = await page
        .getByRole("search")
        .evaluate((form) => Object.fromEntries(new FormData(form)));
      assert.equal(await page.getByRole("search").getAttribute("method"), "get");
      assert.equal(await page.getByRole("search").getAttribute("action"), "/events");
      await id("events-view-list").focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await id("events-view-calendar").evaluate((el) => el.matches(":focus-visible")),
        true,
      );

      if (scenario === "default") {
        assert.deepEqual(submitted, { q: "", game: "" });
        assert.equal(await id("events-view-calendar").getAttribute("aria-current"), "page");
        assert.match(
          await id("events-view-calendar").getAttribute("href"),
          /view=calendar&month=2026-11/,
        );
        assert.equal(
          await id("events-subscribe").getAttribute("href"),
          "webcal://example.test/events.ics",
        );
        assert.equal(
          await id("subscription-feed-url").inputValue(),
          "https://example.test/events.ics",
        );
        assert.equal(await id("events-search-clear").count(), 0);
      } else {
        assert.deepEqual(submitted, { q: "night", game: "Go", past: "1" });
        assert.equal(await id("events-view-list").getAttribute("aria-current"), "page");
        assert.equal(
          await id("subscription-feed-url").inputValue(),
          "https://example.test/events.ics?game=Go",
        );
        assert.notEqual((await id("events-search-status").innerText()).trim(), "");
        const clear = await id("events-search-clear").getAttribute("href");
        assert.ok(!clear.includes("q=") && clear.includes("game=Go"), "clear drops q, keeps game");
      }
    });
  });
}
