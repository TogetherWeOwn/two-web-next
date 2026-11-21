import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const fixture = `<script lang="ts">
import { page } from '$app/state';
import ProfileRecordPreview from '#lib/ProfileRecordPreview.svelte';
const state = page.url.searchParams.get('state');
const entries = [
  { day: '2026-10-18', date: '18 Oct 2026', title: 'Guide role given', detail: 'Helps new members find their feet.', kind: 'Guide' },
  { day: '2026-09-04', date: '4 Sep 2026', title: 'Joined Together We Own', detail: 'Joined the Discord community.', kind: 'Joined' },
] as const;
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
  main { max-width: 46rem; margin-inline: auto; padding: var(--space-6); font-family: var(--font-ui); }
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
    { page: fixture, searches: states.map(search) },
    async ({ page, open }) => {
      const main = page.getByRole("main");
      const headings = [[], ["Echo trail", "Record"], ["Record"], ["Record"]];
      for (const [index, state] of states.entries()) {
        await open(search(state));
        assert.equal(await main.getByRole("heading", { level: 1 }).textContent(), "Lumen");
        assert.deepEqual(
          await main.getByRole("heading", { level: 2 }).allTextContents(),
          headings[index],
        );
        const hasEntries = state === "record" || state === "opt-out";
        const dates = await main
          .locator("time")
          .evaluateAll((times) => times.map((t) => t.dateTime));
        assert.deepEqual(dates, hasEntries ? ["2026-10-18", "2026-09-04"] : []);
        const rows = await main.getByRole("listitem").allTextContents();
        assert.equal(rows.length, hasEntries ? 2 : 0);
        if (hasEntries) {
          assert.match(rows[0], /Guide role given/);
          assert.match(rows[1], /Joined Together We Own/);
        }
        const links = main.getByRole("link");
        assert.deepEqual(await links.allTextContents(), state === "new" ? ["Find an event"] : []);
        assert.equal(
          await main.getByText("Your record starts with your first event.").count(),
          state === "new" ? 1 : 0,
        );
        if (state === "new") assert.equal(await links.first().getAttribute("href"), "/events");
        assert.doesNotMatch(
          await main.innerText(),
          /You and Lumen|rank position|events together|\b0 (?:events|Echoes)\b|Moderators only/i,
        );
        assert.equal(await main.getByRole("img").count(), 0);
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          if (state === "record") {
            const trail = await main.getByRole("region", { name: "Echo trail" }).boundingBox();
            const record = await main.getByRole("region", { name: "Record" }).boundingBox();
            assert.ok(trail && record && trail.y + trail.height <= record.y);
          }
          if (state === "new" && viewport.width === 390) {
            const copy = await main
              .getByText("Your record starts with your first event.")
              .boundingBox();
            const action = await links.first().boundingBox();
            assert.ok(copy && action && copy.y + copy.height <= action.y);
          }
          if (directory) {
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await page.screenshot({ path: join(directory, `${state}-${viewport.width}.png`) });
          }
        }
      }
    },
  );
});
