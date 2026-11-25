import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { profileRecordEntries } from "../test/fixtures/profile-record-preview.ts";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const fixture = `<script lang="ts">
import { page } from '$app/state';
import ProfileRecordPreview from '#lib/ProfileRecordPreview.svelte';
const state = page.url.searchParams.get('state');
const entries = ${JSON.stringify(profileRecordEntries)} as const;
</script>
<svelte:head><link rel="stylesheet" href="/theme.css" /></svelte:head>
<div class="base-theme">
  <main>
    <header>
      <p>Synthetic profile fixture — not a member record</p>
      <h1>Lumen</h1>
      <p>@lumen-example</p>
    </header>
    {#if state !== 'before'}
      <ProfileRecordPreview preview={state === 'new' ? { kind: 'new' } : { kind: state === 'opt-out' ? 'withheld' : 'record', entries }} />
    {/if}
  </main>
</div>
<style>
  main { max-inline-size: 46rem; margin-inline: auto; padding: var(--space-6); font-family: var(--font-ui); }
  header { padding-block: var(--space-4); border-bottom: 1px solid var(--color-hair2); }
  h1 { margin: var(--space-2) 0; font-size: var(--text-h1); font-weight: var(--font-weight-display); }
  p { margin: 0; color: var(--color-t3); font: var(--text-label)/var(--leading-label) var(--font-data); }
</style>`;

test("Kit profile Record preview has no live importer or committed fixture route", () => {
  const result = spawnSync("git", ["grep", "-lF", "ProfileRecordPreview", "--", "web/src", "src"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const route = spawnSync("git", ["ls-files", "web/src/routes/__browser_fixture__"], {
    encoding: "utf8",
  });
  assert.equal(route.status, 0, route.stderr);
  assert.equal(route.stdout, "");
});

test("Kit profile Record fixture renders permitted content in parsed SSR", async () => {
  const states = ["before", "record", "new", "opt-out"];
  const search = (state) => `?state=${state}`;
  const directory = process.env.KIT_PROFILE_RECORD_EVIDENCE_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  await withKitOfflineBrowser(
    { page: fixture, searches: states.map(search), javaScriptEnabled: false, csr: false },
    async ({ page, open }) => {
      const main = page.getByRole("main");
      const headings = [[], ["Echo trail", "Record"], ["Record"], ["Record"]];
      const recordText = [
        "Record",
        "18 Oct 2026",
        "Guide role given",
        "Helps new members find their feet.",
        "Guide",
        "4 Sep 2026",
        "Joined Together We Own",
        "Joined the Discord community.",
        "Joined",
      ];
      const expectedText = {
        before: [],
        record: [
          "Echo trail",
          "Layout preview only. No Echo observations are shown.",
          ...recordText,
        ],
        new: ["Record", "Your record starts with your first event.", "Find an event"],
        "opt-out": recordText,
      };
      const actions = main.locator(
        'a, button, form, input, select, textarea, summary, [role="button"], [role="link"], [contenteditable], [tabindex]',
      );
      for (const [index, state] of states.entries()) {
        await open(search(state));
        assert.equal(await page.locator('script, link[rel="modulepreload"]').count(), 0);
        assert.equal(await main.getByRole("heading", { level: 1 }).textContent(), "Lumen");
        assert.deepEqual(
          await main.getByRole("heading", { level: 2 }).allTextContents(),
          headings[index],
        );
        // Walk parsed SSR text rather than visible text: hidden and aria-hidden text still counts.
        const text = await main.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const parts = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const part = node.textContent.trim();
            if (part) parts.push(part);
          }
          return parts;
        });
        assert.deepEqual(text, [
          "Synthetic profile fixture — not a member record",
          "Lumen",
          "@lumen-example",
          ...expectedText[state],
        ]);
        const hasEntries = state === "record" || state === "opt-out";
        const dates = await main
          .locator("time")
          .evaluateAll((times) => times.map((t) => t.dateTime));
        assert.deepEqual(dates, hasEntries ? ["2026-10-18", "2026-09-04"] : []);
        assert.equal(await main.getByRole("listitem").count(), hasEntries ? 2 : 0);
        assert.equal(await actions.count(), state === "new" ? 1 : 0);
        const eventLink = main.getByRole("link", { name: "Find an event", exact: true });
        if (state === "new") assert.equal(await eventLink.getAttribute("href"), "/events");
        assert.equal(
          await main.locator('img, svg, canvas, meter, progress, [role="img"]').count(),
          0,
        );
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          for (const styles of await main.locator("h2").evaluateAll((elements) =>
            elements.map((element) => {
              const css = getComputedStyle(element);
              return [
                css.textTransform,
                css.fontStretch,
                Number.parseFloat(css.letterSpacing) / Number.parseFloat(css.fontSize),
              ];
            }),
          )) {
            const [textTransform, width, tracking] = styles;
            assert.equal(textTransform, "none");
            assert.equal(width, "108%");
            assert.ok(Math.abs(tracking - -0.025) < 0.0001);
          }
          if (state === "record") {
            const trail = await main.getByRole("region", { name: "Echo trail" }).boundingBox();
            const record = await main.getByRole("region", { name: "Record" }).boundingBox();
            assert.ok(trail && record && trail.y + trail.height <= record.y);
          }
          if (hasEntries) {
            for (const item of await main.getByRole("listitem").all()) {
              const date = await item.locator("time").boundingBox();
              const title = await item.locator("strong").boundingBox();
              assert.ok(date && title);
              if (viewport.width === 390) {
                assert.ok(date.y + date.height <= title.y);
              } else {
                assert.ok(date.x + date.width <= title.x);
              }
            }
          }
          if (state === "new" && viewport.width === 390) {
            const copy = await main
              .getByText("Your record starts with your first event.")
              .boundingBox();
            const action = await eventLink.boundingBox();
            assert.ok(copy && action && copy.y + copy.height <= action.y);
          }
          if (directory) {
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await page.screenshot({ path: join(directory, `${state}-${viewport.width}.png`) });
          }
        }
        if (state === "new") {
          await page.keyboard.press("Tab");
          assert.equal(await eventLink.evaluate((link) => document.activeElement === link), true);
        }
      }
    },
  );
});
