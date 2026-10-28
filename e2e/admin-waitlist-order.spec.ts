// These are real templates with injected read results, not a second SQL oracle.
// PostgreSQL ranking/filter/page semantics are independently exercised by the
// companion acceptance suite. All browser requests terminate in local fixtures.
import { expect, test, type BrowserContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { root, type RosterKit } from "../test/helpers/admin-roster-status";
import {
  compileRosterKit,
  middleName,
  path,
  renderWaitlist,
} from "../test/helpers/admin-waitlist-order";

let kit: RosterKit;
test.beforeAll(async () => {
  kit = await compileRosterKit();
});
const origin = "http://127.0.0.1:18793";
async function mount(context: BrowserContext, renderer: "Hono" | "Kit") {
  const requests: string[] = [];
  const errors: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      errors.push("external request refused");
      return route.abort();
    }
    if (request.isNavigationRequest()) {
      requests.push(request.method());
      if (request.method() !== "GET" || url.pathname !== path)
        return route.fulfill({ status: 405, body: "Fixture refuses mutation" });
      try {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: await renderWaitlist(renderer, kit, {
            raw: Object.fromEntries(url.searchParams),
            total: 207,
            state: "paused",
          }),
        });
      } catch (error) {
        errors.push(String(error));
        return route.fulfill({ status: 500, body: "fixture render failed" });
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

for (const renderer of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    test(`WQ-B01 ${renderer} JS=${javaScriptEnabled}: native keyboard queue sort/search preserves context and resets paging`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled,
        viewport: { width: 1280, height: 800 },
      });
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        await page.goto(
          `${origin}${path}?roster_sort=answered&roster_order=desc&roster_status=waitlisted&roster_page=2#rsvp-roster`,
        );
        const section = page.getByTestId("rsvp-roster");
        const sort = section.getByRole("link", { name: /sort by waitlist position ascending/i });
        await expect(sort).toHaveCount(1);
        await sort.focus();
        await Promise.all([
          page.waitForURL(/roster_sort=waitlist&roster_order=asc/),
          page.keyboard.press("Enter"),
        ]);
        await expect(page).toHaveURL(/roster_sort=waitlist&roster_order=asc/);
        let url = new URL(page.url());
        expect(url.searchParams.get("roster_sort")).toBe("waitlist");
        expect(url.searchParams.get("roster_status")).toBe("waitlisted");
        expect(url.searchParams.has("roster_page")).toBe(false);
        await section.getByRole("searchbox").fill(middleName);
        await section.getByRole("button", { name: "Search", exact: true }).focus();
        await Promise.all([page.waitForURL(/roster_q=/), page.keyboard.press("Enter")]);
        await expect(page).toHaveURL(/roster_q=/);
        url = new URL(page.url());
        expect(url.searchParams.get("roster_q")).toBe(middleName);
        expect(url.searchParams.get("roster_sort")).toBe("waitlist");
        expect(url.searchParams.get("roster_status")).toBe("waitlisted");
        expect(url.searchParams.has("roster_page")).toBe(false);
        const next = section.getByRole("link", { name: "Next", exact: true });
        await next.focus();
        await Promise.all([page.waitForURL(/roster_page=2/), page.keyboard.press("Enter")]);
        await expect(page).toHaveURL(/roster_page=2/);
        url = new URL(page.url());
        expect(url.searchParams.get("roster_q")).toBe(middleName);
        expect(url.searchParams.get("roster_sort")).toBe("waitlist");
        expect(harness.requests.every((method) => method === "GET")).toBe(true);
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test(`WQ-B02 ${renderer}: mobile position labels and read-only paused guidance remain keyboard accessible`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    try {
      const harness = await mount(context, renderer);
      const page = await context.newPage();
      await page.goto(`${origin}${path}?roster_sort=waitlist&roster_order=asc#rsvp-roster`);
      const section = page.getByTestId("rsvp-roster");
      const header = section.getByRole("columnheader", { name: /waitlist position/i });
      await expect(header).toHaveCount(1);
      await expect(header).toHaveAttribute("aria-sort", "ascending");
      const target = section.getByRole("row").filter({ hasText: middleName });
      await expect(target.getByRole("cell", { name: "57", exact: true })).toHaveCount(1);
      const region = section.getByRole("region", { name: "RSVP roster list" });
      await region.focus();
      await expect(region).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(section).toContainText(/queue order/i);
      await expect(section).toContainText(/attendance/i);
      expect(await section.locator('form[method="post"]').count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(harness.errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
