import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { assertNoViolations, WCAG_AA_TAGS } from "./a11y-policy.mjs";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const out = "artifacts/kit-members-directory";
const required = {
  default: "",
  "empty-e1": "?state=e1",
  "empty-e2": "?state=e2",
  "empty-e3": "?state=e3&filter=guides",
  "no-results": "?filter=guides&q=zz",
  "no-newcomers": "?state=nonew",
  guest: "?state=guest",
};
const extra = [
  "?filter=everyone",
  "?filter=guides",
  "?state=e2&filter=everyone",
  "?state=e3&filter=everyone",
  "?q=quiet",
  "?q=%40quiet_inactive",
  "?q=hidden",
  "?state=nooptout",
  "?state=nooptout&q=hidden",
  "?state=many",
  "?state=many&page=2",
  "?state=many&page=9",
];
const source = () =>
  readFile(new URL("../test/fixtures/kit-members-directory-route.svelte", import.meta.url), "utf8");
const names =
  /Fixture Member|Quiet Inactive|Hidden Opt Out|fixture_handle|quiet_inactive|hidden_opt_out|\/members\/|\/welcome\//;

test("members directory renders its states without JavaScript", { timeout: 720_000 }, async () => {
  await mkdir(out, { recursive: true });
  await withKitOfflineBrowser(
    { page: await source(), searches: [...Object.values(required), ...extra] },
    async ({ page, open }) => {
      const html = {};
      for (const [name, search] of Object.entries(required)) {
        html[name] = await open(search);
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
          { width: 320, height: 640 },
        ]) {
          await page.setViewportSize(viewport);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${name} overflows at ${viewport.width}`,
          );
          if (viewport.width !== 320)
            await page.screenshot({ path: `${out}/${name}-${viewport.width}.png`, fullPage: true });
          if (name === "default" || name === "guest") {
            const header = page.getByRole("banner");
            const join = header.getByRole("link", { name: "Join", exact: true });
            const expectedJoin = name === "guest" ? 1 : 0;
            assert.equal(await join.count(), expectedJoin, `${name} header at ${viewport.width}px`);
            if (viewport.width === 390) {
              await header.getByRole("link", { name: "Menu", exact: true }).click();
              const account = header.getByRole("navigation", { name: "Account" });
              assert.equal(await account.isVisible(), true);
              assert.equal(
                await account.getByRole("link", { name: "Join", exact: true }).count(),
                expectedJoin,
              );
              assert.equal(
                await account.getByRole("link", { name: "Your profile", exact: true }).count(),
                1 - expectedJoin,
              );
              await page.screenshot({ path: `${out}/${name}-menu-open-390.png` });
              await header.getByRole("link", { name: "Close menu" }).click();
            }
          }
        }
      }
      // Default: six newcomers, active list, a Guide and an organizer; opted-out alias hidden.
      assert.equal(html.default.match(/\/welcome\/fixture-\d/g)?.length, 6);
      assert.match(html.default, /Guide/);
      assert.match(html.default, /Event host/);
      assert.match(html.default, /Fixture Member 1(?!\d)/);
      assert.doesNotMatch(html.default, /Quiet Inactive|Hidden Opt Out|hidden_opt_out/);
      // No newcomers: the strip disappears, but the organizer help link can remain.
      assert.doesNotMatch(html["no-newcomers"], /Joined this week|\/welcome\/fixture-\d/);
      assert.match(html["no-newcomers"], /Fixture Member 7/);
      // Empty and no-result states.
      assert.match(html["empty-e1"], /No members to list yet\./);
      assert.match(html["empty-e2"], /No active members this month yet\./);
      assert.match(html["empty-e3"], /No Guides yet\./);
      assert.match(html["no-results"], /Nobody matches (&quot;|")zz/);
      // Guest: counts only, no synthetic member data anywhere in the HTML.
      assert.doesNotMatch(html.guest, names);
      assert.match(html.guest, /814 members · 212 came to something this month/);
      assert.doesNotMatch(
        await page.getByRole("main").innerText(),
        /Joined this week|Who runs this/i,
      );
      assert.equal(await page.getByRole("search").count(), 0);

      // Search matches name and handle, including inactive members; opted out never match.
      for (const search of ["?q=quiet", "?q=%40quiet_inactive"])
        assert.match(await open(search), /Quiet Inactive Fixture/);
      assert.doesNotMatch(await open("?q=hidden"), /Hidden Opt Out/);
      assert.match(await open("?state=nooptout&q=hidden"), /Hidden Opt Out/);
      assert.match(await open("?state=nooptout"), /Hidden Opt Out Alias/);
      // Follow the server-rendered filter and recovery links.
      const list = page.getByRole("list", { name: "Members", exact: true });
      const filters = page.getByRole("navigation", { name: "Which members" });
      await open(required.default);
      for (const [start, label, selected, count, member] of [
        [null, /^Everyone\b/, /^Everyone\b/, 8, "Quiet Inactive Fixture"],
        [null, /^Guides\b/, /^Guides\b/, 1, "Fixture Member 7"],
        [null, /^Active\b/, /^Active\b/, 7, "Fixture Member 1"],
        [required["no-results"], "Clear search", /^Guides\b/, 1, "Fixture Member 7"],
        [required["empty-e2"], "Show everyone", /^Everyone\b/, 2, "Fixture Member 1"],
        [required["empty-e3"], "Show everyone", /^Everyone\b/, 2, "Fixture Member 2"],
      ]) {
        if (start) await open(start);
        await (start ? page : filters).getByRole("link", { name: label }).click();
        assert.match(await filters.locator('[aria-current="page"]').innerText(), selected);
        assert.equal(await list.getByRole("listitem").count(), count);
        assert.equal(await list.getByRole("link", { name: member, exact: true }).count(), 1);
      }
      // Pagination: follow both links, then directly request an out-of-range page.
      await open("?state=many");
      const pager = page.getByRole("navigation", { name: "Member pages" });
      await pager.getByRole("link", { name: "Next page" }).click();
      assert.match(await list.innerText(), /Fixture Member 21(?!\d)/);
      assert.doesNotMatch(await list.innerText(), /Fixture Member 1(?!\d)/);
      await pager.getByRole("link", { name: "Previous page" }).click();
      assert.equal(new URL(page.url()).search, "?state=many");
      assert.match(await list.innerText(), /Fixture Member 1(?!\d)/);
      assert.doesNotMatch(await list.innerText(), /Fixture Member 21(?!\d)/);
      assert.match(await open("?state=many&page=9"), /Fixture Member 45(?!\d)/);

      // Click helpers can scroll controls back into view, hiding a sticky overlap.
      for (const { width, height } of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
        { width: 320, height: 640 },
      ]) {
        await page.setViewportSize({ width, height });
        await open("?state=many");
        const form = page.getByRole("search", { name: "Search members" });
        const top = await form.evaluate((node) => node.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => scrollTo({ top: y + 200, behavior: "instant" }), top);
        assert.ok(
          await page.evaluate((y) => scrollY > y, top),
          `did not scroll past search at ${width}px`,
        );
        for (const control of [
          form.getByRole("searchbox"),
          form.getByRole("button", { name: "Search" }),
        ]) {
          assert.ok(
            await control.evaluate((node) => {
              const { left, top, bottom, width, height } = node.getBoundingClientRect();
              return (
                top >= 0 &&
                bottom <= innerHeight &&
                node.contains(document.elementFromPoint(left + width / 2, top + height / 2))
              );
            }),
            `sticky search control is obscured at ${width}px`,
          );
        }
        await page.screenshot({ path: `${out}/scrolled-${width}.png` });
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await open("");
      assert.match((await page.locator("h1").textContent()) ?? "", /here\. Say hi/);
      const rows = list.getByRole("listitem");
      const gameColumnStart = (name) =>
        rows
          .filter({ has: page.getByRole("link", { name, exact: true }) })
          .locator(".directory-games")
          .evaluate((cell) => cell.getBoundingClientRect().left);
      assert.equal(
        await gameColumnStart("Fixture Member 7"),
        await gameColumnStart("Fixture Member 1"),
        "the Guide badge must not shift the game column at 1280px",
      );
      // Keyboard: Tab reaches the search field and Enter submits it without JavaScript.
      let focused = false;
      for (let i = 0; i < 40 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await page.evaluate(() => document.activeElement?.matches("input"));
      }
      assert.equal(focused, true, "search input is not keyboard reachable");
      await page.keyboard.type("quiet");
      await Promise.all([page.waitForURL(/q=quiet/), page.keyboard.press("Enter")]);
      assert.match(await page.locator("body").innerText(), /Quiet Inactive Fixture/);
    },
  );
});

test("members directory passes Axe with JavaScript", { timeout: 720_000 }, async () => {
  await mkdir(out, { recursive: true });
  const searches = [required.default, required["no-results"], required.guest, required["empty-e1"]];
  await withKitOfflineBrowser(
    { page: await source(), searches, javaScriptEnabled: true, headerMenu: true, csr: true },
    async ({ page, open }) => {
      for (const search of searches) {
        await open(search);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
          assertNoViolations(results, `members directory ${search || "default"} ${width}`);
        }
      }
    },
  );
});
