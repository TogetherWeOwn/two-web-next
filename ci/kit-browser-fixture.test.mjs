import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFixtureAsset, withKitOfflineBrowser } from "./kit-offline-browser.mjs";

test("Kit browser fixture renders SSR and loads its CSS offline", async () => {
  await withKitOfflineBrowser(
    {
      page: `<script>
import JsonLd from '#lib/JsonLd.svelte';
import SiteFooter from '#lib/SiteFooter.svelte';
</script>
<JsonLd testid="site-jsonld" json={'{"fixture":true}'} />
<SiteFooter />
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
      // The shipped footer consumes a generated Tailwind theme token. Compare
      // its computed background with the browser-resolved custom property, not
      // merely the presence of a token name in the emitted stylesheet.
      const footer = page.locator("footer");
      const assertFooterTheme = async () => {
        const resolved = await footer.evaluate((el) => {
          const value = getComputedStyle(el).getPropertyValue("--color-lobby-raised").trim();
          const probe = document.createElement("div");
          probe.style.backgroundColor = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { value, color, actual: getComputedStyle(el).backgroundColor };
        });
        assert.notEqual(resolved.value, "");
        assert.notEqual(resolved.color, "rgba(0, 0, 0, 0)");
        assert.equal(resolved.actual, resolved.color);
        return resolved.actual;
      };
      const originalBackground = await assertFooterTheme();
      const removed = await page.evaluate(() => {
        let count = 0;
        function remove(rules) {
          for (const rule of rules) {
            if (rule.style?.getPropertyValue("--color-lobby-raised")) {
              rule.style.removeProperty("--color-lobby-raised");
              count++;
            }
            if (rule.cssRules) remove(rule.cssRules);
          }
        }
        for (const sheet of document.styleSheets) remove(sheet.cssRules);
        return count;
      });
      assert.ok(removed > 0, "negative control removed a compiled declaration");
      await assert.rejects(assertFooterTheme(), assert.AssertionError);
      assert.notEqual(
        await footer.evaluate((el) => getComputedStyle(el).backgroundColor),
        originalBackground,
        "footer background changes when its theme declaration is removed",
      );
      assert.deepEqual(unexpected, []);
    },
  );
});

test("structured time renders its states without JavaScript in Kit", async () => {
  await withKitOfflineBrowser(
    {
      page: `<script>import StructuredTime from '#lib/StructuredTime.svelte';</script>
<div class="base-theme">
<StructuredTime state="upcoming" startsAt="2026-12-01T19:00:00Z" zone="America/New_York" />
<StructuredTime state="past" startsAt="2026-12-01T19:00:00Z" endsAt="2026-12-01T20:00:00Z" zone="UTC" />
<StructuredTime state="cancelled" startsAt="2026-12-01T19:00:00Z" zone="UTC" />
<StructuredTime state="upcoming" startsAt={null} />
</div>`,
    },
    async ({ page, unexpected }) => {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const rows = page.locator(".row-time");
        assert.equal(await rows.count(), 4);
        assert.equal(
          await rows
            .nth(0)
            .locator(".line1")
            .evaluate((el) => getComputedStyle(el).color),
          "rgb(246, 241, 234)",
        );
        assert.equal(
          await rows
            .nth(0)
            .locator(".line2")
            .evaluate((el) => getComputedStyle(el).color),
          "rgb(168, 154, 142)",
        );
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

test("Kit fixture renders query data and same-origin static assets", async () => {
  await withKitOfflineBrowser(
    {
      search: "?name=fixture%20name",
      page: `<script>import { page } from '$app/state';</script>
<p>{page.url.searchParams.get('name')}</p>
<img src="/logo.svg" alt="Logo">
<style>@font-face { font-family: proof; src: url('/fonts/mona-sans-latin-var.woff2'); }
p { font-family: proof; }</style>`,
    },
    async ({ page, html }) => {
      assert.match(html, /fixture name/);
      assert.equal(await page.locator("p").textContent(), "fixture name");
      assert.equal(await page.locator("img").evaluate((image) => image.naturalWidth > 0), true);
      assert.equal(
        await page.evaluate(async () => (await document.fonts.load("16px proof")).length),
        1,
      );
    },
  );
});

test("Kit fixture rejects invalid query strings", async () => {
  for (const search of ["name=fixture", "?name=fixture#fragment", 123]) {
    await assert.rejects(
      withKitOfflineBrowser({ search }, async () => {}),
      { message: "Fixture search must be a query string" },
    );
  }
});

test("asset reads reject escapes, symlinks, and unsupported files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kit-asset-test-"));
  try {
    const root = join(dir, "root");
    await mkdir(root);
    await writeFile(join(root, "safe.css"), "safe");
    await writeFile(join(root, "safe.js"), "unsupported");
    await writeFile(join(dir, "outside.css"), "outside");
    await symlink(join(dir, "outside.css"), join(root, "link.css"));
    await symlink(join(dir, "outside.css"), join(root, "link.js"));
    await symlink(dir, join(root, "linked-dir"));
    assert.equal((await readFixtureAsset(root, "/safe.css")).body.toString(), "safe");
    assert.equal(
      (await readFixtureAsset(root, "/safe.js", { allowJavaScript: true })).contentType,
      "text/javascript",
    );
    assert.equal(await readFixtureAsset(root, "/link.js", { allowJavaScript: true }), null);
    for (const path of [
      "/../outside.css",
      "/%2e%2e/outside.css",
      "/link.css",
      "/linked-dir/outside.css",
      "/safe.js",
      "/missing.css",
      "/%zz.css",
      "/..%5coutside.css",
    ]) {
      assert.equal(await readFixtureAsset(root, path), null, path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
