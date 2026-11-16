import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

test("Kit fixture opts into compiled JavaScript hydration", async () => {
  const fixture = `<script>let count = $state(0);</script>
<button onclick={() => count++}>{count}</button>`;
  await withKitOfflineBrowser({ page: fixture }, async ({ page }) => {
    await page.locator("button").click();
    assert.equal(await page.locator("button").textContent(), "0");
  });
  await withKitOfflineBrowser({ page: fixture, javaScriptEnabled: true }, async ({ page }) => {
    await page.waitForLoadState("networkidle");
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("button")?.textContent === "1");
  });
});

test("Kit fixture denies WebSocket connections and workers", async () => {
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const port = listener.address().port;
    const fixture = `<script>
let closed = $state(0);
function connect() {
  for (const scheme of ['ws', 'wss']) {
    const socket = new WebSocket(scheme + '://127.0.0.1:${port}/fixture');
    socket.onclose = () => closed++;
  }
}
</script><button onclick={connect}>{closed}</button>`;
    await assert.rejects(
      withKitOfflineBrowser({ page: fixture, javaScriptEnabled: true }, async ({ page }) => {
        await page.waitForLoadState("networkidle");
        await page.locator("button").click();
        await page.waitForFunction(() => document.querySelector("button")?.textContent === "2");
        const directive = await page.evaluate(
          () =>
            new Promise((resolve) => {
              document.addEventListener(
                "securitypolicyviolation",
                (event) => resolve(event.effectiveDirective),
                { once: true },
              );
              new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })));
            }),
        );
        assert.equal(directive, "worker-src");
      }),
      /ws(?:s)?:\/\/127\.0\.0\.1/,
    );
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Kit fixture denies public JavaScript even with hydration enabled", async () => {
  await assert.rejects(
    withKitOfflineBrowser({ page: "<p>Fixture</p>", javaScriptEnabled: true }, async ({ page }) => {
      await page.evaluate(() => fetch("/islands/events-calendar.js").catch(() => null));
    }),
    /events-calendar\.js/,
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
    await writeFile(join(dir, "outside.js"), "outside");
    await symlink(dir, join(root, "linked-dir"));
    assert.equal((await readFixtureAsset(root, "/safe.css")).body.toString(), "safe");
    assert.equal(
      (await readFixtureAsset(root, "/safe.js", { allowJavaScript: true })).contentType,
      "text/javascript",
    );
    for (const path of ["/link.js", "/linked-dir/outside.js", "/%2e%2e/outside.js"]) {
      assert.equal(await readFixtureAsset(root, path, { allowJavaScript: true }), null, path);
    }
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
