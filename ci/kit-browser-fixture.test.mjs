import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { homeEvidencePage, homeEvidenceStates, withKitHomeEvidence } from "./kit-home-evidence.mjs";
import {
  fixedDateBanner,
  readFixtureAsset,
  withKitOfflineBrowser,
} from "./kit-offline-browser.mjs";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);

test("fixed server clock is module-scoped and leaves the global Date alone", () => {
  const realNow = Date.now;
  const realDate = globalThis.Date;
  const scoped = new Function(
    `${fixedDateBanner(NOW)}
    return { Date, now: Date.now(), made: new Date(), explicit: new Date(5), str: Date(), instance: new Date() instanceof Date };`,
  )();
  assert.equal(scoped.now, NOW);
  assert.equal(scoped.made.getTime(), NOW);
  assert.equal(scoped.explicit.getTime(), 5);
  assert.equal(scoped.str, new realDate(NOW).toString());
  assert.equal(scoped.instance, true);
  assert.equal(scoped.Date.UTC(1970, 0, 1), 0);
  assert.equal(globalThis.Date, realDate);
  assert.equal(Date.now, realNow);
  assert.notEqual(Date.now(), NOW);
});

test("fixed server clock rejects non-epoch values", () => {
  for (const bad of ["2030-01-01", 1.5, Number.NaN, 9e15, null]) {
    assert.throws(() => fixedDateBanner(bad), /epoch milliseconds/);
  }
});

test("Kit home evidence rejects unknown fixture states", () => {
  assert.throws(() => homeEvidencePage("__proto__"), /Unknown home evidence state/);
});

for (const state of homeEvidenceStates) {
  test(`Kit home evidence renders ${state} offline`, async () => {
    await withKitHomeEvidence(state, async ({ page }) => {
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, state);
    });
  });
}

test("Kit offline fixture fixes the server render clock", async () => {
  await withKitOfflineBrowser(
    { now: Date.UTC(2030, 0, 2), page: "<p>{new Date().toISOString()}</p>" },
    async ({ page }) => {
      assert.equal(await page.locator("p").textContent(), "2030-01-02T00:00:00.000Z");
    },
  );
});

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
    let closed;
    let directive;
    await assert.rejects(
      withKitOfflineBrowser({ page: fixture, javaScriptEnabled: true }, async ({ page }) => {
        await page.waitForLoadState("networkidle");
        await page.locator("button").click();
        await page.waitForFunction(
          () => document.querySelector("button")?.textContent === "2",
          null,
          {
            timeout: 10_000,
          },
        );
        closed = await page.locator("button").textContent();
        directive = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve("timeout"), 10_000);
              document.addEventListener(
                "securitypolicyviolation",
                (event) => {
                  clearTimeout(timer);
                  resolve(event.effectiveDirective);
                },
                { once: true },
              );
              new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })));
            }),
        );
      }),
      /ws(?:s)?:\/\/127\.0\.0\.1/,
    );
    const assertObservations = (closedValue, workerDirective) => {
      assert.equal(closedValue, "2");
      assert.equal(workerDirective, "worker-src");
    };
    assertObservations(closed, directive);
    assert.throws(() => assertObservations("1", directive), assert.AssertionError);
    assert.throws(() => assertObservations(closed, "wrong-directive"), assert.AssertionError);
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

test("calendar grid renders navigation and event states without JavaScript", async () => {
  await withKitOfflineBrowser(
    {
      page: `<script lang="ts">
import CalendarGrid from '#lib/CalendarGrid.svelte';
import type { CalendarGridEntry } from '#lib/calendar-grid';
import { monthGrid } from '../../../../src/islands/contracts';
const now = new Date('2026-06-15T12:00:00Z');
const state = { view: 'calendar' as const, month: '2026-06', q: '', game: 'Chess', past: true, page: 1 };
const active = { key: 'active', title: 'Game night', startsAt: new Date('2026-06-15T18:00:00Z'), zone: 'UTC', cancelled: false, ongoing: true, availability: '2 seats left' };
const cancelled = { key: 'cancelled', title: 'Cancelled night', startsAt: new Date('2026-06-16T18:00:00Z'), zone: 'UTC', cancelled: true, ongoing: false, availability: null };
const weeks = monthGrid(state.month, '2026-06-15', new Map<string, CalendarGridEntry[]>([['2026-06-15', [active]], ['2026-06-16', [active, cancelled]]]));
</script>
<svelte:head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/schedule-theme.css" /></svelte:head>
<div class="base-theme schedule-theme"><main class="events-page"><CalendarGrid {state} {weeks} zone="UTC" {now} /></main></div>`,
    },
    async ({ page, html }) => {
      assert.match(html, /Game night/);
      assert.equal(await page.getByTestId("calendar-month").textContent(), "June 2026");
      assert.deepEqual(await page.locator("thead th").allTextContents(), [
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
        "Sun",
      ]);
      assert.equal(
        await page.getByTestId("calendar-day").first().getAttribute("data-date"),
        "2026-06-01",
      );
      assert.equal(
        await page.locator('[data-date="2026-07-01"]').getAttribute("data-outside"),
        "true",
      );
      assert.equal(
        await page.locator('[data-date="2026-06-15"]').getAttribute("aria-current"),
        "date",
      );
      assert.equal(await page.locator('[data-date="2026-06-01"] li').count(), 0);
      const ongoing = page.locator('[data-date="2026-06-15"] a');
      assert.match(
        await ongoing.getAttribute("href"),
        /event=active&past=1&game=Chess#event-active$/,
      );
      assert.match(
        await ongoing.getAttribute("aria-label"),
        /Game night Happening now 2 seats left/,
      );
      assert.match(
        await page.locator('[data-date="2026-06-16"] a').first().getAttribute("aria-label"),
        /^Continues Game night/,
      );
      assert.match(
        await page.locator('[data-date="2026-06-16"] a').last().getAttribute("aria-label"),
        /Cancelled night Cancelled/,
      );
      assert.match(await page.getByLabel("Previous month").getAttribute("href"), /month=2026-05/);
      assert.match(await page.getByLabel("Next month").getAttribute("href"), /month=2026-07/);
      const form = page.getByTestId("calendar-month-jump");
      assert.equal(await form.getAttribute("method"), "get");
      assert.equal(await form.getAttribute("action"), "/events");
      assert.equal(await form.locator('[name="game"]').inputValue(), "Chess");
      assert.equal(await form.locator('[name="past"]').inputValue(), "1");
      assert.equal(await form.locator('[name="view"]').inputValue(), "calendar");
      assert.equal(await page.getByTestId("events-calendar-scroll").getAttribute("tabindex"), "0");
      if (process.env.KIT_CALENDAR_EVIDENCE_DIR) {
        const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
        await mkdir(directory, { recursive: true });
        for (const [name, width, height] of [
          ["desktop", 1280, 800],
          ["mobile", 390, 844],
        ]) {
          await page.setViewportSize({ width, height });
          await page.screenshot({ path: join(directory, `calendar-${name}.png`), fullPage: true });
        }
      }
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
