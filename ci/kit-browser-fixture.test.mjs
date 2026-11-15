import assert from "node:assert/strict";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

test("Kit browser fixture renders SSR and loads its CSS offline", async () => {
  await withKitOfflineBrowser(
    {
      page: `<script>import JsonLd from '#lib/JsonLd.svelte';</script>
<JsonLd testid="site-jsonld" json={'{"fixture":true}'} />
<p class="proof">Fixture rendered</p>
<style>.proof { color: rgb(12, 34, 56); }</style>`,
    },
    async ({ page, html, unexpected }) => {
      assert.match(html, /Fixture rendered/);
      assert.match(html, /data-testid="site-jsonld"/);
      assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
      assert.equal(await page.locator(".proof").textContent(), "Fixture rendered");
      assert.equal(
        await page.locator(".proof").evaluate((el) => getComputedStyle(el).color),
        "rgb(12, 34, 56)",
      );
      assert.deepEqual(unexpected, []);
    },
  );
});

test("structured time renders its states without JavaScript in Kit", async () => {
  await withKitOfflineBrowser(
    {
      page: `<script>import StructuredTime from '#lib/StructuredTime.svelte';</script>
<StructuredTime state="upcoming" startsAt="2026-12-01T19:00:00Z" zone="America/New_York" />
<StructuredTime state="past" startsAt="2026-12-01T19:00:00Z" endsAt="2026-12-01T20:00:00Z" zone="UTC" />
<StructuredTime state="cancelled" startsAt="2026-12-01T19:00:00Z" zone="UTC" />
<StructuredTime state="upcoming" startsAt={null} />`,
    },
    async ({ page, unexpected }) => {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const rows = page.locator(".row-time");
        assert.equal(await rows.count(), 4);
        assert.equal(await rows.nth(0).getAttribute("data-state"), "upcoming");
        assert.equal(
          await rows.nth(0).locator("time").getAttribute("datetime"),
          "2026-12-01T19:00:00.000Z",
        );
        assert.match(await rows.nth(0).textContent(), /America\/New_York/);
        assert.match(await rows.nth(1).textContent(), /ended/);
        assert.equal(await rows.nth(2).locator("s time").count(), 1);
        assert.match(await rows.nth(2).textContent(), /Cancelled/);
        assert.equal(await rows.nth(3).getAttribute("data-state"), "unavailable");
        assert.match(await rows.nth(3).textContent(), /Time to be confirmed/);
        assert.equal(await rows.nth(3).locator("time").count(), 0);
      }
      assert.deepEqual(unexpected, []);
    },
  );
});

test("Kit offline browser rejects unexpected external requests", async () => {
  await assert.rejects(
    withKitOfflineBrowser(
      { page: '<img src="https://example.invalid/image.png" alt="">' },
      async () => {},
    ),
    /example\.invalid/,
  );
});
