// Independent acceptance; reached by the existing browser-smoke *.spec.ts glob.
// No new browser opt-in or CI/config change. All routes/assets are local fixtures.
// Run in the normal browser harness: npm run e2e -- e2e/admin-roster-status.spec.ts
// Native submission, keyboard access, no-JS, empty recovery and dirty-draft veto
// exercise real rendered Hono/Kit documents, not handcrafted filter HTML.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileRosterKit,
  needle,
  path,
  readRoster,
  root,
  rosterDb,
  type Renderer,
  type RosterKit,
} from "../test/helpers/admin-roster-status";

let kit: RosterKit;
test.beforeAll(async () => {
  kit = await compileRosterKit();
});
const origin = "http://127.0.0.1:18789";

async function mount(context: BrowserContext, renderer: Renderer) {
  const requests: { method: string; url: string }[] = [];
  const errors: string[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) {
      errors.push("non-fixture network attempt");
      return route.abort("blockedbyclient");
    }
    if (req.isNavigationRequest()) {
      requests.push({ method: req.method(), url: req.url() });
      if (req.method() !== "GET")
        return route.fulfill({ status: 405, body: "Unexpected mutation" });
      if (url.pathname !== path) return route.fulfill({ status: 404, body: "Not a fixture route" });
      try {
        const response = await readRoster(renderer, rosterDb(), url.search.slice(1), kit);
        return route.fulfill({
          status: response.status,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: await response.text(),
        });
      } catch (error) {
        errors.push(String(error));
        return route.fulfill({ status: 500, body: "Fixture rendering failed" });
      }
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      /\.(?:js|css|svg|woff2|png)$/.test(asset)
    )
      return route.fulfill({ path: asset });
    return route.fulfill({ status: 404, body: "No external fixture" });
  });
  return { requests, errors };
}
async function keyboardTo(page: Page, selector: string) {
  for (let i = 0; i < 65; i++) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((el) => el === el.ownerDocument.activeElement))
      return;
  }
  throw new Error(`Keyboard cannot reach ${selector}`);
}
async function isGuarded(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

for (const renderer of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    test(`RAF-B01 ${renderer} JS=${javaScriptEnabled}: keyboard/native facet and member submit is GET-only and resets page one`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        await page.goto(
          `${origin}${path}?roster_page=3&roster_sort=status&roster_order=asc#rsvp-roster`,
        );
        const section = page.getByTestId("rsvp-roster");
        const facet = section.locator('select[name="roster_status"]');
        await expect(facet, "native answer facet, not a scripted widget").toHaveCount(1);
        await expect(facet).toHaveAccessibleName(/\S/);
        await keyboardTo(page, '#rsvp-roster select[name="roster_status"]');
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(facet).toHaveValue("waitlisted");
        await section.getByRole("searchbox").fill(needle);
        if (javaScriptEnabled) expect(await isGuarded(page)).toBe(false);
        const submit = section.locator('button[type="submit"]');
        await submit.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/#rsvp-roster$/);
        await expect(page.getByTestId("roster-range")).toContainText(/1\s*[-–]\s*100 of 105/);
        const url = new URL(page.url());
        expect(url.searchParams.get("roster_status")).toBe("waitlisted");
        expect(url.searchParams.get("roster_q")).toBe(needle);
        expect(url.searchParams.has("roster_page")).toBe(false);
        expect(url.searchParams.get("roster_sort")).toBe("status");
        expect(url.searchParams.get("roster_order")).toBe("asc");
        expect(url.searchParams.has("title")).toBe(false);
        expect(harness.requests.every((r) => r.method === "GET")).toBe(true);
        expect(harness.requests).toHaveLength(2);
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test(`RAF-B02 ${renderer} JS=${javaScriptEnabled}: empty/past-end recovery keeps the scoped response set and destination`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        const query = new URLSearchParams({
          roster_status: "waitlisted",
          roster_q: needle,
          roster_page: "999",
        });
        await page.goto(`${origin}${path}?${query}#rsvp-roster`);
        const first = page.getByRole("link", {
          name: "First page of these responses",
          exact: true,
        });
        await expect(first).toHaveCount(1);
        await first.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("roster-range")).toContainText(/1\s*[-–]\s*100 of 105/);
        expect(new URL(page.url()).hash).toBe("#rsvp-roster");
        expect(new URL(page.url()).searchParams.get("roster_status")).toBe("waitlisted");
        expect(new URL(page.url()).searchParams.get("roster_q")).toBe(needle);
        await page.getByTestId("rsvp-roster").getByRole("searchbox").fill("Nobody <&>");
        await page.getByTestId("rsvp-roster").locator('button[type="submit"]').click();
        await expect(page.getByTestId("roster-range")).toContainText(/0\s*[-–]\s*0 of 0/);
        const clear = page.getByRole("link", { name: "Clear roster filters", exact: true });
        await clear.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("roster-range")).toContainText(/of 420/);
        const url = new URL(page.url());
        expect(url.hash).toBe("#rsvp-roster");
        expect(url.searchParams.has("roster_q")).toBe(false);
        expect(url.searchParams.has("roster_status")).toBe(false);
        expect(harness.requests.every((r) => r.method === "GET")).toBe(true);
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  for (const [query, label] of [
    ["roster_status=going&roster_q=Nobody", "Clear roster filters"],
    ["roster_status=waitlisted&roster_page=999", "First page of these responses"],
  ] as const) {
    test(`RAF-B03 ${renderer}: ${label} cannot bypass dirty-event departure protection`, async ({
      browser,
    }) => {
      const context = await browser.newContext();
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        await page.goto(`${origin}${path}?${query}#rsvp-roster`);
        const recovery = page.getByRole("link", { name: label, exact: true });
        await expect(recovery).toHaveCount(1);
        await page.locator('[name="title"]').fill("Unsent moderator draft");
        expect(await isGuarded(page)).toBe(true);
        const dialog = page.waitForEvent("dialog").then(async (d) => {
          expect(d.type()).toBe("beforeunload");
          await d.dismiss();
        });
        await recovery.click();
        await dialog;
        expect(harness.requests).toHaveLength(1);
        await expect(page.locator('[name="title"]')).toHaveValue("Unsent moderator draft");
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test(`RAF-BC01 CONTROL ${renderer}: dirty event draft vetoes an ordinary roster search departure`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const harness = await mount(context, renderer);
      const page = await context.newPage();
      await page.goto(`${origin}${path}#rsvp-roster`);
      await expect(page.locator("[data-event-editor]")).toHaveCount(1);
      expect(await isGuarded(page)).toBe(false);
      await page.locator('[name="title"]').fill("Unsent moderator draft");
      expect(await isGuarded(page)).toBe(true);
      await page.getByTestId("rsvp-roster").getByRole("searchbox").fill("Café");
      const dialog = page.waitForEvent("dialog").then(async (d) => {
        expect(d.type()).toBe("beforeunload");
        await d.dismiss();
      });
      await page.getByTestId("rsvp-roster").locator('button[type="submit"]').click();
      await dialog;
      expect(harness.requests).toHaveLength(1);
      await expect(page.locator('[name="title"]')).toHaveValue("Unsent moderator draft");
      expect(await isGuarded(page)).toBe(true);
      expect(harness.errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
