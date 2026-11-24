import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  homeEvidencePage,
  homeEvidenceStates,
  withKitHomeEvidence,
  withKitHomeEvidenceStates,
} from "./kit-home-evidence.mjs";
import {
  fixedDateBanner,
  readFixtureAsset,
  withKitOfflineBrowser,
} from "./kit-offline-browser.mjs";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);

test("home capture records success and fails closed with diagnostic evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kit-capture-test-"));
  try {
    await mkdir(join(dir, "tooling", "ci"), { recursive: true });
    await mkdir(join(dir, "after", "ci"), { recursive: true });
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "git"), '#!/bin/sh\nprintf "fixture-sha\\n"\n', {
      mode: 0o755,
    });
    await writeFile(
      join(dir, "after", "ci", "kit-home-evidence.mjs"),
      `export const homeEvidenceStates = ["guest"];
export const homeEvidencePage = () => "fixture";
export async function assertHomeEvidence() {
  if (process.env.CAPTURE_CASE === "assertion") throw new Error("fixture assertion failed");
}`,
    );
    await writeFile(
      join(dir, "tooling", "ci", "kit-offline-browser.mjs"),
      `export async function withKitOfflineBrowser({ source }, capture) {
  if (process.env.CAPTURE_CASE === "incomplete" && source.endsWith("after")) return;
  let focused = false;
  let scrollY;
  const page = {
    setViewportSize: async () => { scrollY = 1; },
    locator: () => ({
      focus: async () => { focused = true; },
      evaluate: async () => process.env.CAPTURE_CASE !== "focus-hidden",
    }),
    screenshot: async (options) => {
      if (options.fullPage !== true) throw new Error("full-page capture required");
      if (!options.path && (focused || scrollY !== 0)) throw new Error("ordinary capture retained focus or scroll");
      return Buffer.from("fixture image");
    },
    evaluate: async (fn) => {
      if (fn.toString().includes("scrollWidth")) return {
        width: 390, scrollWidth: 390,
        font: process.env.CAPTURE_CASE === "fallback-first" ? "serif, Mona Sans" : '"Mona Sans", sans-serif',
        fontAvailable: true,
      };
      globalThis.document = { fonts: {
        ready: Promise.resolve(),
        load: async (spec) => process.env.CAPTURE_CASE === "missing-font" && spec.startsWith("700")
          ? [] : [{ family: "Mona Sans", status: "loaded" }],
      } };
      try { return await fn(); } finally { delete globalThis.document; }
    },
  };
  globalThis.window = { scrollTo: ({ top }) => { scrollY = top; } };
  try { await capture({ page }); } finally { delete globalThis.window; }
}`,
    );
    const script = new URL("./kit-home-capture.mjs", import.meta.url);
    const run = async (scenario, executable = script) => {
      const output = join(dir, `output-${scenario}`);
      const result = spawnSync(process.execPath, [executable.pathname, "guest", output], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          FINAL_SHA: "fixture-sha",
          CAPTURE_CASE: scenario,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return {
        result,
        manifest: JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
      };
    };
    const success = await run("success");
    assert.equal(success.result.status, 0, success.result.stderr);
    assert.equal(success.manifest.captures.length, 4);
    assert.deepEqual(success.manifest.errors, []);
    assert.deepEqual(
      success.manifest.captures.map(({ name }) => name),
      [
        "before-guest-desktop.png",
        "before-guest-mobile.png",
        "after-guest-desktop.png",
        "after-guest-mobile.png",
      ],
    );
    const hiddenFocus = await run("focus-hidden");
    assert.equal(hiddenFocus.result.status, 1);
    assert.match(hiddenFocus.manifest.errors[0], /after:/);
    const failure = await run("assertion");
    assert.equal(failure.result.status, 1);
    assert.equal(failure.manifest.captures.length, 3);
    assert.match(failure.manifest.errors[0], /after: fixture assertion failed/);
    for (const scenario of ["missing-font", "fallback-first"]) {
      const failure = await run(scenario);
      assert.equal(failure.result.status, 1);
      assert.equal(failure.manifest.captures.length, 3);
      assert.equal(failure.manifest.captures[2].tree, "after");
      assert.match(failure.manifest.errors[0], /after:/);
      if (scenario === "missing-font") {
        assert.equal(failure.manifest.captures[2].metrics.fontLoaded, false);
        assert.match(failure.manifest.errors[0], /heading font did not load/);
      }
    }
    const incomplete = await run("incomplete");
    assert.equal(incomplete.result.status, 1);
    assert.equal(incomplete.manifest.captures.length, 2);
    assert.deepEqual(incomplete.manifest.errors, []);

    const source = await readFile(script, "utf8");
    assert.ok(source.includes("process.exitCode = 1;"));
    const mutant = join(dir, "mutant.mjs");
    await writeFile(mutant, source.replace("process.exitCode = 1;", ""));
    const mutation = await run("assertion", new URL(`file://${mutant}`));
    assert.throws(() => assert.equal(mutation.result.status, 1), assert.AssertionError);
    assert.match(mutation.manifest.errors[0], /fixture assertion failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("Kit home evidence renders all states offline", async (t) => {
  await withKitHomeEvidenceStates(async (openState) => {
    for (const state of homeEvidenceStates) {
      await t.test(state, async () => {
        const page = await openState(state);
        assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, state);
      });
    }
  });
});

test("Kit home hero presents its heading and action at desktop and mobile widths", async () => {
  await withKitHomeEvidence("guest", async ({ page }) => {
    for (const [width, height] of [
      [1280, 800],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const hero = page.locator('section[aria-labelledby="home-heading"]');
      const heading = hero.locator("h1");
      const action = hero.locator(".hero-action");
      const button = action.getByTestId("join");
      const lead = action.locator(".lead");
      assert.equal(await hero.evaluate((el) => getComputedStyle(el).textAlign), "left");
      assert.equal(await action.evaluate((el) => getComputedStyle(el).display), "flex");
      const typography = await heading.evaluate((el) => {
        const style = getComputedStyle(el);
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--text-hero)";
        el.append(probe);
        const expectedSize = getComputedStyle(probe).fontSize;
        probe.remove();
        return {
          size: style.fontSize,
          expectedSize,
          weight: style.fontWeight,
          expectedWeight: style.getPropertyValue("--font-weight-display").trim() || "560",
        };
      });
      assert.equal(typography.size, typography.expectedSize);
      assert.notEqual(typography.expectedWeight, "");
      assert.equal(typography.weight, typography.expectedWeight);
      const [actionBox, buttonBox, leadBox] = await Promise.all([
        action.boundingBox(),
        button.boundingBox(),
        lead.boundingBox(),
      ]);
      assert.ok(actionBox && buttonBox && leadBox, `hero boxes at ${width}px`);
      if (width === 390) {
        assert.ok(Math.abs(buttonBox.width - actionBox.width) < 1, "mobile action fills its row");
        assert.ok(leadBox.y >= buttonBox.y + buttonBox.height, "mobile lead follows action");
      } else {
        assert.ok(leadBox.x >= buttonBox.x + buttonBox.width, "desktop lead follows action inline");
      }
    }
  });
});

test("Kit offline fixture fixes the server render clock", async () => {
  await withKitOfflineBrowser(
    { now: Date.UTC(2030, 0, 2), page: "<p>{new Date().toISOString()}</p>" },
    async ({ page }) => {
      assert.equal(await page.locator("p").textContent(), "2030-01-02T00:00:00.000Z");
    },
  );
});

test("Kit admin Events exposes the current sort and follows sort links by keyboard without JavaScript", async (t) => {
  const filters = "q=Fixture+night&status=cancelled&series=standalone&fill=unlimited&rsvp_open=0";
  const start = `?${filters}&sort=starts_at&order=desc&page=2`;
  const titleAscending = `?${filters}&sort=title&order=asc`;
  const titleDescending = `?${filters}&sort=title&order=desc`;
  await withKitOfflineBrowser(
    {
      search: start,
      searches: [titleAscending, titleDescending],
      page: `<script lang="ts">
import { page } from '$app/state';
import AdminEvents from '../admin/events/+page.svelte';
import { eventEmptyText, parseEventListQuery } from '../../../../src/admin/event-list';

const query = parseEventListQuery(Object.fromEntries(page.url.searchParams));
const rows = ['Alpha', 'Zulu'].map((name) => ({
  eventKey: name.toLowerCase(), title: 'Fixture night ' + name, game: null, status: 'cancelled',
  startsAt: '2030-01-02T18:00:00.000Z', endsAt: '2030-01-02T20:00:00.000Z',
  capacity: null, rsvpOpen: false, goingCount: 0,
}));
if (query.order === 'desc') rows.reverse();
</script>
<AdminEvents data={{ query, rows: query.page === 1 ? rows : [], hasNext: false, emptyText: eventEmptyText(query), pauseReviews: {}, restoredWrite: false }} />`,
    },
    async ({ page }) => {
      const origin = new URL(page.url()).origin;
      // Keep the real href and navigation URL. The offline fixture supplies only the allowlisted SSR states.
      await page.route(`${origin}/admin/events?*`, (route) => {
        const url = new URL(route.request().url());
        url.pathname = "/__browser_fixture__";
        return route.fallback({ url: url.href });
      });
      // The root fixture emits relative Kit stylesheet URLs. Map their new base back to the built assets.
      await page.route(`${origin}/admin/_app/immutable/assets/*.css`, (route) => {
        const url = new URL(route.request().url());
        url.pathname = url.pathname.slice("/admin".length);
        return route.fallback({ url: url.href });
      });
      const table = page.getByTestId("events-table");
      const header = (name) => table.getByRole("columnheader", { name, exact: true });
      const sortLink = (name) => table.getByRole("link", { name, exact: true });
      const assertSort = async (name, direction) => {
        assert.equal(
          await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme),
          "dark",
          "the compiled Kit stylesheet is loaded",
        );
        assert.equal(await table.locator("th[aria-sort]").count(), 1);
        assert.equal(await header(name).getAttribute("aria-sort"), direction);
        assert.equal(
          await header(name).locator('span[aria-hidden="true"]').textContent(),
          direction === "ascending" ? " ↑" : " ↓",
        );
      };
      const titleAsc = sortLink("Sort by title ascending");
      const titleDesc = sortLink("Sort by title descending");
      const statusAsc = sortLink("Sort by status ascending");
      const startsAsc = sortLink("Sort by starts (UTC) ascending");
      const rowTitles = () => table.locator("tbody tr td:first-child a").allTextContents();
      const thead = table.locator("thead");

      async function capture(state) {
        const fixtureEvidence = process.env.KIT_CALENDAR_EVIDENCE_DIR;
        if (!fixtureEvidence) return;
        // The existing Kit browser fixture job archives this directory.
        const directory = join(fixtureEvidence, "admin-events-sort");
        await mkdir(directory, { recursive: true });
        for (const [width, height] of [
          [1280, 800],
          [390, 844],
        ]) {
          await page.setViewportSize({ width, height });
          const after = await page.screenshot({ fullPage: true });
          // Restore the previous header markup as a visual control on the same SSR page.
          await thead.evaluate((element) => {
            for (const th of element.querySelectorAll("th[aria-label]")) {
              th.removeAttribute("aria-label");
              if (!th.hasAttribute("aria-sort")) th.setAttribute("aria-sort", "none");
              const arrow = th.querySelector('span[aria-hidden="true"]');
              if (arrow) arrow.replaceWith(arrow.textContent);
            }
          });
          const before = await page.screenshot({ fullPage: true });
          await page.reload();
          await writeFile(join(directory, `${state}-${width}-before.png`), before);
          await writeFile(join(directory, `${state}-${width}-after.png`), after);
          assert.ok(before.equals(after), `${state} at ${width}px renders identically`);
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await assertSort("Starts (UTC)", "descending");
      assert.equal(await titleAsc.getAttribute("href"), `/admin/events${titleAscending}`);
      assert.equal(
        await statusAsc.getAttribute("href"),
        `/admin/events?${filters}&sort=status&order=asc`,
      );
      assert.equal(
        await startsAsc.getAttribute("href"),
        `/admin/events?${filters}&sort=starts_at&order=asc`,
      );
      assert.equal(
        await page.getByTestId("events-empty").textContent(),
        "No results on this page.",
      );
      t.diagnostic(await thead.ariaSnapshot());
      await capture("starts-descending-page-2");

      await page.getByTestId("events-table-scroll").focus();
      for (const link of [titleAsc, statusAsc, startsAsc]) {
        await page.keyboard.press("Tab");
        assert.equal(await link.evaluate((element) => element === document.activeElement), true);
      }
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await titleAsc.evaluate((element) => element === document.activeElement), true);
      await Promise.all([
        page.waitForURL(`${origin}/admin/events${titleAscending}`),
        page.keyboard.press("Enter"),
      ]);
      await assertSort("Title", "ascending");
      assert.deepEqual(await rowTitles(), ["Fixture night Alpha", "Fixture night Zulu"]);
      assert.equal(await titleDesc.getAttribute("href"), `/admin/events${titleDescending}`);
      t.diagnostic(await thead.ariaSnapshot());
      await capture("title-ascending");

      await page.getByTestId("events-table-scroll").focus();
      await page.keyboard.press("Tab");
      assert.equal(await titleDesc.evaluate((element) => element === document.activeElement), true);
      await Promise.all([
        page.waitForURL(`${origin}/admin/events${titleDescending}`),
        page.keyboard.press("Enter"),
      ]);
      await assertSort("Title", "descending");
      assert.deepEqual(await rowTitles(), ["Fixture night Zulu", "Fixture night Alpha"]);
      await capture("title-descending");
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
<span class="theme-pill">Theme token proof</span>
<style>
  .proof { color: rgb(12, 34, 56); }
  .theme-pill {
    border-radius: var(--radius-pill);
    padding-inline: var(--space-inset-tag-x);
    font-family: var(--font-data);
  }
</style>`,
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
      const pill = await page.locator(".theme-pill").evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          radius: style.borderRadius,
          padding: style.paddingInline,
          font: style.fontFamily,
        };
      });
      assert.equal(pill.radius, "999px");
      assert.equal(pill.padding, "7px");
      assert.equal(pill.font, '"Fragment Mono", ui-monospace, monospace');
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
  const timezoneId = "America/Los_Angeles";
  await withKitOfflineBrowser(
    { page: fixture, javaScriptEnabled: true, timezoneId, csr: true, headerMenu: true },
    async ({ page }) => {
      assert.equal(
        await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
        timezoneId,
      );
      await page.waitForLoadState("networkidle");
      await page.locator("button").click();
      await page.waitForFunction(() => document.querySelector("button")?.textContent === "1");
      assert.equal(
        await page.evaluate(async () => (await fetch("/islands/site-header-menu.js")).status),
        200,
      );
    },
  );
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

test("Kit fixture serves the menu island only with explicit opt-in", async () => {
  const path = "/islands/site-header-menu.js";
  const options = { page: "<p>Fixture</p>", javaScriptEnabled: true };
  const fetchFulfilled = (page, url) =>
    page.evaluate(
      (request) =>
        fetch(request).then(
          () => true,
          () => false,
        ),
      url,
    );

  let menuFetchFulfilled;
  await assert.rejects(
    withKitOfflineBrowser(options, async ({ page }) => {
      menuFetchFulfilled = await fetchFulfilled(page, path);
    }),
    /\/islands\/site-header-menu\.js/,
  );
  assert.equal(menuFetchFulfilled, false);

  const body = await readFile(new URL(`../public${path}`, import.meta.url), "utf8");
  let calendarFetchFulfilled;
  await assert.rejects(
    withKitOfflineBrowser({ ...options, headerMenu: true }, async ({ page }) => {
      const response = await page.evaluate(async (url) => {
        const asset = await fetch(url);
        return {
          status: asset.status,
          type: asset.headers.get("content-type"),
          body: await asset.text(),
        };
      }, path);
      assert.deepEqual(response, { status: 200, type: "text/javascript", body });
      calendarFetchFulfilled = await fetchFulfilled(page, "/islands/events-calendar.js");
    }),
    /\/islands\/events-calendar\.js/,
  );
  // The fixture's cleanup rejection can mask assertions inside the callback.
  assert.equal(calendarFetchFulfilled, false);
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

const calendarViewports = [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
  ["narrow", { width: 320, height: 844 }],
];

for (const scenario of ["never", "gap", "error", "partial", "miss", "game", "both"]) {
  test(`calendar empty ${scenario} renders recovery links without JavaScript`, async () => {
    const kind = ["game", "both"].includes(scenario) ? "miss" : scenario;
    const query = ["miss", "both"].includes(scenario) ? "night" : "";
    const game = ["game", "both"].includes(scenario) ? "Chess" : null;
    await withKitOfflineBrowser(
      {
        page: `<script lang="ts">
import CalendarEmpty from '#lib/CalendarEmpty.svelte';
const state = { view: 'list' as const, month: '2030-06', q: ${JSON.stringify(query)}, game: ${JSON.stringify(game || "")}, past: true, page: 2 };
const past = Array.from({ length: 7 }, (_, i) => ({ eventKey: i === 1 ? 'game/night' : String(i), title: i === 0 ? 'Cancelled night' : 'Past night', status: i === 0 ? 'cancelled' : 'past', startsAt: new Date('2030-06-15T18:00:00Z'), timezone: 'UTC' }));
</script>
<svelte:head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/schedule-theme.css" /></svelte:head>
<div class="base-theme schedule-theme"><main class="events-page"><CalendarEmpty kind="${kind}" {state} gameFilter={${JSON.stringify(game)}} {past} inviteUrl="https://discord.test/invite" /></main></div>`,
      },
      async ({ page, html }) => {
        const joinDiscord = page.getByTestId("discord-join");
        const retry = page.getByTestId("events-retry");
        const clearSearch = page.getByTestId("events-search-clear-empty");
        const allGames = page.getByTestId("events-empty-search").getByRole("link", {
          name: query ? "Search all games" : "Show all games",
          exact: true,
        });
        const archive = page
          .getByTestId("events-empty-gap")
          .getByRole("link", { name: "Past events" });
        if (scenario === "never" || scenario === "error" || scenario === "partial") {
          assert.match(html, /https:\/\/discord\.test\/invite/);
          assert.equal(await joinDiscord.getAttribute("href"), "https://discord.test/invite");
        }
        if (scenario === "error" || scenario === "partial") {
          const notice = page.getByTestId(
            scenario === "error" ? "events-empty-error" : "events-partial-source",
          );
          assert.equal(await notice.count(), 1);
          assert.equal(await notice.getAttribute("role"), null);
          assert.match(await retry.getAttribute("href"), /page=2/);
          const order = await page
            .locator(".schedule-recovery-actions a")
            .evaluateAll((links) => links.map((link) => link.dataset.testid));
          assert.deepEqual(order, ["events-retry", "discord-join"], "retry precedes invite");
        }
        if (scenario === "gap") {
          assert.equal(await page.getByTestId("events-empty-gap-item").count(), 5);
          assert.equal(
            await page.getByTestId("events-empty-gap-item").first().locator("a").count(),
            0,
          );
          assert.equal(
            await page
              .getByTestId("events-empty-gap-item")
              .nth(1)
              .locator("a")
              .getAttribute("href"),
            "/e/game%2Fnight",
          );
          assert.equal(await archive.getAttribute("href"), "/events/past");
        }
        if (query) {
          const clear = await clearSearch.getAttribute("href");
          assert.doesNotMatch(clear, /[?&]q=/);
          if (game) assert.match(clear, /game=Chess/);
        }
        if (game) {
          const all = await allGames.getAttribute("href");
          assert.doesNotMatch(all, /[?&]game=/);
          if (query) assert.match(all, /q=night/);
        }
        const links = {
          never: [joinDiscord],
          gap: [archive],
          error: [retry, joinDiscord],
          partial: [retry, joinDiscord],
          miss: [clearSearch],
          game: [allGames],
          both: [clearSearch, allGames],
        }[scenario];
        const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
        if (directory) await mkdir(directory, { recursive: true });
        for (const [name, viewport] of calendarViewports) {
          await page.setViewportSize(viewport);
          for (const link of links) {
            const bounds = await link.boundingBox();
            assert.ok(bounds, `${scenario} ${name}: recovery link is visible`);
            assert.ok(
              bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
              `${scenario} ${name}: recovery link fits within the viewport (${JSON.stringify(bounds)})`,
            );
          }
          if (scenario === "error" || scenario === "partial") {
            const first = await links[0].boundingBox();
            const second = await links[1].boundingBox();
            assert.ok(
              second.y > first.y || second.x > first.x,
              `${scenario} ${name}: invite follows retry visually`,
            );
          }
          if (links.length === 2) {
            const firstId = await links[0].getAttribute("data-testid");
            assert.equal(
              await links[0].or(links[1]).first().getAttribute("data-testid"),
              firstId,
              `${scenario} ${name}: ${firstId} precedes the alternative action`,
            );
          }
          if (directory) {
            await page.screenshot({
              path: join(directory, `calendar-empty-${scenario}-${name}.png`),
              fullPage: true,
            });
          }
        }
      },
    );
  });
}

for (const scenario of ["closed", "open", "search", "empty"]) {
  test(`calendar past drawer renders ${scenario} without JavaScript`, async () => {
    await withKitOfflineBrowser(
      {
        page: `<script lang="ts">
import CalendarPastDrawer from '#lib/CalendarPastDrawer.svelte';
import type { CalendarPersistedCard } from '#lib/calendar-list';
const state = { view: 'list' as const, month: '2030-06', q: ${JSON.stringify(scenario === "search" ? "Game" : "")}, game: 'Chess', past: ${scenario !== "closed"}, page: 2 };
const past: CalendarPersistedCard = { kind: 'event', key: 'past', eventKey: 'past', title: 'Past game night', titleSegments: null, zone: 'UTC', startsAt: new Date('2030-06-15T18:00:00Z'), endsAt: null, location: null, description: 'A past game night.', passage: null, availability: { state: 'past', text: 'Ended', ongoing: false }, status: 'past', game: null, host: '', goingCount: 1, goingOccupancy: 1, capacity: null };
</script>
<svelte:head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/schedule-theme.css" /></svelte:head>
<div class="base-theme schedule-theme"><main class="events-page"><CalendarPastDrawer {state} past={${scenario === "empty" ? "[]" : "[past]"}} showPast={${scenario !== "closed"}} member={false} inviteUrl="https://discord.test/invite" loginReturnTo="/events?page=2" /></main></div>`,
      },
      async ({ page }) => {
        const list = page.getByRole("list", { name: "Past events", exact: true });
        const listCount = scenario === "closed" || scenario === "empty" ? 0 : 1;
        assert.equal(await list.count(), listCount);
        assert.equal(await page.getByTestId("events-past-list").count(), listCount);
        assert.equal(
          await page.getByTestId("events-past-toggle").count(),
          scenario === "search" || scenario === "empty" ? 0 : 1,
        );
        if (scenario !== "search" && scenario !== "empty") {
          assert.match(
            await page.getByTestId("events-past-toggle").getAttribute("href"),
            /game=Chess/,
          );
        }
        if (scenario !== "closed" && scenario !== "empty") {
          assert.equal(await list.getAttribute("role"), "list");
          assert.equal(await list.getByRole("listitem").count(), 1);
          assert.match(await page.getByTestId("events-past-list").innerText(), /Past game night/i);
          assert.equal(await page.getByTestId("signin").count(), 0);
        }
        if (process.env.KIT_CALENDAR_EVIDENCE_DIR) {
          const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
          await mkdir(directory, { recursive: true });
          for (const [name, width, height] of [
            ["desktop", 1280, 800],
            ["mobile", 390, 844],
          ]) {
            await page.setViewportSize({ width, height });
            await page.screenshot({
              path: join(directory, `past-drawer-${scenario}-${name}.png`),
              fullPage: true,
            });
          }
        }
      },
    );
  });
}

for (const scenario of [
  "populated",
  "list",
  "empty",
  "gap",
  "filtered",
  "failure",
  "partial",
  "month-empty",
]) {
  test(`calendar screen renders ${scenario} without JavaScript`, async () => {
    await withKitOfflineBrowser(
      {
        page: `<script lang="ts">
import CalendarScreen from '#lib/CalendarScreen.svelte';
import { monthGrid } from '../../../../src/islands/contracts';
const state = { view: ${JSON.stringify(["filtered", "list", "gap"].includes(scenario) ? "list" : "calendar")} as const, month: '2026-06', q: ${JSON.stringify(scenario === "filtered" ? "chess" : "")}, game: '', past: false, page: 1 };
const now = new Date('2026-06-15T12:00:00Z');
const event = { key: 'game', title: 'Game night', startsAt: new Date('2026-06-15T18:00:00Z'), zone: 'UTC', cancelled: false, ongoing: false, availability: '2 seats left' };
const listEvent = { kind: 'event' as const, key: 'game', eventKey: 'game', title: 'Game night', titleSegments: null, zone: 'UTC', startsAt: event.startsAt, endsAt: null, location: null, description: null, passage: null, availability: { state: 'open' as const, text: 'Spots open', ongoing: false }, status: 'published', game: null, host: '', goingCount: 1, goingOccupancy: 1, capacity: null };
const gapEvent = { eventKey: 'past', title: 'Previous game night', startsAt: new Date('2026-05-15T18:00:00Z'), timezone: 'UTC', status: 'published' };
const weeks = monthGrid(state.month, '2026-06-15', new Map([['2026-06-15', ${scenario === "populated" || scenario === "partial" ? "[event]" : "[]"}]]));
</script>
<svelte:head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme-tokens.css" /><link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/schedule-theme.css" /></svelte:head>
<div class="base-theme schedule-theme"><main class="events-page"><CalendarScreen {state} appUrl="https://example.test" games={[]} gameFilter={null} past={[]} gapPast={${scenario === "gap" ? "[gapEvent]" : "[]"}} upcoming={${scenario === "list" ? "[listEvent]" : "[]"}} totalPages={1} showPast={false} emptyState={${scenario === "empty" ? "'never'" : scenario === "gap" ? "'gap'" : scenario === "failure" ? "'error'" : "null"}} discordFailed={${scenario === "failure" || scenario === "partial"}} discordRead={${scenario === "failure" || scenario === "partial" ? -1 : 0}} hasVisibleResults={${scenario === "populated" || scenario === "list" || scenario === "partial" || scenario === "month-empty"}} outOfRange={false} searchMiss={${scenario === "filtered"}} monthEmpty={${scenario === "month-empty"}} inviteUrl="https://discord.test/invite" member={false} {weeks} zone="UTC" {now} /></main></div>`,
      },
      async ({ page, html }) => {
        assert.match(html, /data-island="events-calendar"/);
        assert.deepEqual(
          await page
            .locator("[data-cal-zone]")
            .evaluateAll((zones) => zones.map((zone) => zone.getAttribute("data-cal-zone"))),
          ["head", "subscribe", "actions", "miss", "content"],
        );
        const form = page.locator('form[role="search"]');
        assert.equal(await form.getAttribute("method"), "get");
        assert.equal(await form.getAttribute("action"), "/events");
        assert.equal(await page.getByTestId("events-read-retry").isHidden(), true);
        assert.equal(await page.getByTestId("events-read-clear").isHidden(), true);
        if (scenario === "populated") {
          assert.match(await page.locator('[data-cal-zone="content"]').innerText(), /Game night/);
          assert.match(await page.getByLabel("Next month").getAttribute("href"), /month=2026-07/);
        }
        if (scenario === "list") {
          assert.match(await page.getByTestId("events-list").innerText(), /Game night/i);
          assert.equal(await page.getByTestId("calendar-month").count(), 0);
        }
        if (scenario === "empty") {
          assert.match(
            await page.locator('[data-cal-zone="content"]').innerText(),
            /Nothing on the calendar yet/i,
          );
          assert.equal(await page.getByTestId("calendar-month").count(), 0);
        }
        if (scenario === "gap") {
          const gap = page.getByTestId("events-empty-gap");
          assert.match(await gap.innerText(), /Previous game night/);
          assert.equal(
            await gap.getByRole("link", { name: "Previous game night" }).getAttribute("href"),
            "/e/past",
          );
        }
        if (scenario === "filtered") {
          assert.equal(await form.locator('[name="q"]').inputValue(), "chess");
          assert.match(
            await page.locator('[data-cal-zone="miss"]').innerText(),
            /Nothing matches that search/i,
          );
          assert.equal(
            await page.getByTestId("events-search-clear-empty").getAttribute("href"),
            "/events",
          );
        }
        if (scenario === "failure") {
          assert.equal(await page.getByTestId("events-empty-error").getAttribute("role"), null);
          assert.equal(await page.locator('[data-cal-zone="miss"]').innerText(), "");
          assert.equal(
            await page.getByTestId("events-retry").getAttribute("href"),
            "/events?view=calendar&month=2026-06",
          );
        }
        if (scenario === "partial") {
          assert.match(
            await page.getByTestId("events-partial-source").innerText(),
            /may be missing/,
          );
          assert.match(
            await page.getByTestId("events-search-status").textContent(),
            /may be missing/,
          );
          assert.match(await page.locator('[data-cal-zone="content"]').innerText(), /Game night/);
          assert.equal(await page.getByTestId("calendar-month-empty").count(), 0);
        }
        if (scenario === "month-empty") {
          assert.equal(await page.getByTestId("calendar-month").textContent(), "June 2026");
          assert.equal(
            await page.getByTestId("calendar-month-empty").locator("a").getAttribute("href"),
            "/events",
          );
        }
        const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
        if (directory) await mkdir(directory, { recursive: true });
        for (const [name, width, height] of [
          ["desktop", 1280, 800],
          ["mobile", 390, 844],
        ]) {
          await page.setViewportSize({ width, height });
          const isList = ["filtered", "list", "gap"].includes(scenario);
          const selected = page.getByTestId(isList ? "events-view-list" : "events-view-calendar");
          assert.equal(await selected.getAttribute("aria-current"), "page");
          const background = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
          assert.equal(background, "rgb(46, 36, 32)");
          await page.getByTestId("events-view-list").focus();
          await page.keyboard.press("Tab");
          const focused = page
            .getByTestId("events-view-calendar")
            .and(page.locator(":focus-visible"));
          assert.equal(await focused.evaluate((el) => getComputedStyle(el).outlineWidth), "2px");
          if (directory)
            await page.screenshot({
              path: join(directory, `screen-${scenario}-${name}.png`),
              fullPage: true,
            });
        }
      },
    );
  });
}

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
      const fade = () =>
        page
          .locator(".schedule-month-frame")
          .evaluate((node) => getComputedStyle(node, "::after").display);
      const hint = page.locator(".schedule-month-hint");
      await page.setViewportSize({ width: 1280, height: 800 });
      assert.equal(await hint.isVisible(), false, "wide grid shows no scroll hint");
      assert.equal(await fade(), "none", "wide grid shows no fade");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await hint.isVisible(), true, "narrow grid shows scroll hint");
      assert.equal(await hint.getAttribute("aria-hidden"), null);
      assert.equal(await fade(), "block", "narrow grid shows fade");
      await page.emulateMedia({ forcedColors: "active" });
      assert.equal(await fade(), "none", "forced colors removes the decorative fade");
      assert.equal(await hint.isVisible(), true, "forced colors keeps the text hint");
      await page.emulateMedia({ forcedColors: "none" });
      const scroll = page.getByTestId("events-calendar-scroll");
      assert.equal(await scroll.getAttribute("tabindex"), "0");
      const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
      if (directory) await mkdir(directory, { recursive: true });
      for (const [name, viewport] of calendarViewports) {
        await page.setViewportSize(viewport);
        const maxScroll = await scroll.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        );
        assert.equal(maxScroll > 0, name !== "desktop", `${name}: grid overflow`);
        for (const [position, left] of [
          ["start", 0],
          ["end", maxScroll],
        ]) {
          const actual = await scroll.evaluate((element, target) => {
            element.scrollTo({ left: target, behavior: "instant" });
            return element.scrollLeft;
          }, left);
          assert.equal(actual, left, `${name}: grid is at the ${position} of its scroll range`);
          if (directory) {
            const path = join(directory, `calendar-${name}-${position}.png`);
            await page.screenshot({ path, fullPage: true });
            if (position === "start" && name !== "narrow") {
              await copyFile(path, join(directory, `calendar-${name}.png`));
            }
          }
        }
      }
    },
  );
});

for (const scenario of ["open", "closed", "search", "out-of-range"]) {
  test(`calendar list renders ${scenario} without JavaScript`, async () => {
    await withKitOfflineBrowser(
      {
        page: `<script lang="ts">
import CalendarList from '#lib/CalendarList.svelte';
import type { CalendarListCard, CalendarPersistedCard } from '#lib/calendar-list';
const state = { view: 'list' as const, month: '2030-06', q: ${JSON.stringify(scenario === "search" ? "Game" : "")}, game: 'Chess', past: ${scenario !== "closed"}, page: ${scenario === "out-of-range" ? 9 : 2} };
const event: CalendarPersistedCard = { kind: 'event', key: 'game', eventKey: 'game', title: 'Game night', titleSegments: ${scenario === "search" ? "[{ text: 'Game', match: true }, { text: ' night', match: false }]" : "null"}, zone: 'UTC', startsAt: new Date('2030-06-15T18:00:00Z'), endsAt: null, location: null, description: null, passage: null, availability: { state: 'open', text: 'Spots open', ongoing: false }, status: 'published', game: null, host: '', goingCount: 1, goingOccupancy: 1, capacity: null };
const discord: CalendarListCard = { kind: 'discord', key: 'discord', title: 'Discord event', titleSegments: null, zone: 'UTC', startsAt: new Date('2030-06-16T18:00:00Z'), endsAt: null, location: null, description: null, passage: null, availability: { state: 'transient', text: 'Via Discord', ongoing: false } };
const cancelled: CalendarPersistedCard = { ...event, key: 'cancelled', eventKey: 'cancelled', title: 'Cancelled night', status: 'cancelled', availability: null };
const past: CalendarPersistedCard = { ...event, key: 'past', eventKey: 'past', title: 'Past game night', status: 'past', availability: { state: 'past', text: 'Ended', ongoing: false } };
</script>
<svelte:head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/schedule-theme.css" /></svelte:head>
<div class="base-theme schedule-theme"><main class="events-page"><CalendarList {state} zone="UTC" now={new Date('2030-06-15T12:00:00Z')} upcoming={${scenario === "out-of-range" ? "[]" : "[event, discord, cancelled]"}} past={[past]} totalPages={4} outOfRange={${scenario === "out-of-range"}} showPast={${scenario !== "closed"}} member={false} inviteUrl="https://discord.test/invite" loginReturnTo="/events?page=2" /></main></div>`,
      },
      async ({ page }) => {
        assert.equal(
          await page.getByTestId("events-past-list").count(),
          scenario === "closed" ? 0 : 1,
        );
        if (scenario === "search") {
          assert.equal(await page.getByTestId("events-past-toggle").count(), 0);
        } else {
          assert.match(
            await page.getByTestId("events-past-toggle").getAttribute("href"),
            /game=Chess/,
          );
        }
        if (scenario === "out-of-range") {
          assert.equal(await page.getByTestId("events-out-of-range").count(), 1);
        } else {
          assert.match(await page.getByTestId("events-list").innerText(), /Game night/i);
          assert.equal(await page.getByRole("list", { name: /Today · .*15 Jun/ }).count(), 1);
          assert.equal(await page.getByRole("list", { name: /Today · .*16 Jun/ }).count(), 0);
          if (scenario === "search") {
            const title = page.locator("#event-game").getByRole("heading", { level: 3 });
            assert.match(await title.locator("mark").innerText(), /^Game$/i);
          }
          assert.match(await page.getByTestId("events-pager-next").getAttribute("href"), /page=3/);
          assert.equal(await page.getByTestId("event-cancelled").count(), 1);
          assert.equal(await page.getByTestId("event-discord-rsvp").count(), 1);
        }
        if (process.env.KIT_CALENDAR_EVIDENCE_DIR) {
          const directory = process.env.KIT_CALENDAR_EVIDENCE_DIR;
          await mkdir(directory, { recursive: true });
          for (const [name, width, height] of [
            ["desktop", 1280, 800],
            ["mobile", 390, 844],
          ]) {
            await page.setViewportSize({ width, height });
            await page.screenshot({
              path: join(directory, `calendar-list-${scenario}-${name}.png`),
              fullPage: true,
            });
          }
        }
      },
    );
  });
}

test("Kit offline browser rejects unexpected external requests", async () => {
  await assert.rejects(
    withKitOfflineBrowser(
      { page: '<img src="https://example.invalid/image.png" alt="">' },
      async () => {},
    ),
    /example\.invalid/,
  );
});
