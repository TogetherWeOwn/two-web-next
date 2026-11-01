// Waitlist queue ranks on the moderator roster: the Waitlist column shows
// the global FIFO position (`#n`) for waitlisted rows and a dash otherwise,
// and searching, paging, or sorting never renumbers the queue. Reached by
// the existing browser-smoke *.spec.ts glob. All routes/assets are local
// fixtures. Run in the normal browser harness:
// npm run e2e -- e2e/admin-waitlist-order.spec.ts
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
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

async function waitlistCells(page: Page) {
  const section = page.getByTestId("rsvp-roster");
  return section.locator("tbody tr td:nth-child(3)");
}

for (const renderer of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    test(`WQ-B01 ${renderer} JS=${javaScriptEnabled}: waitlist ranks render and survive a member search`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        await page.goto(`${origin}${path}?roster_status=waitlisted#rsvp-roster`);
        const section = page.getByTestId("rsvp-roster");
        await expect(section.getByRole("columnheader")).toContainText([
          "Member",
          "Status",
          "Waitlist",
          "Answered",
        ]);
        const cells = waitlistCells(page);
        await expect(cells.first()).toHaveText("#1");
        await expect(cells.nth(99)).toHaveText("#100");
        await expect(page.getByTestId("roster-range")).toContainText(/1\s*[-–]\s*100 of 105/);
        await section.getByRole("searchbox").fill(needle);
        await section.locator('button[type="submit"]').click();
        await expect(page.getByTestId("roster-range")).toContainText(/1\s*[-–]\s*100 of 104/);
        await expect(waitlistCells(page).first()).toHaveText("#1");
        await expect(waitlistCells(page).nth(99)).toHaveText("#100");
        expect(harness.requests.every((r) => r.method === "GET")).toBe(true);
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test(`WQ-B02 ${renderer} JS=${javaScriptEnabled}: the waitlist sort orders by queue rank, others show a dash`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const harness = await mount(context, renderer);
        const page = await context.newPage();
        await page.goto(
          `${origin}${path}?roster_status=waitlisted&roster_sort=waitlist&roster_order=desc#rsvp-roster`,
        );
        await expect(waitlistCells(page).first()).toHaveText("#105");
        await page.getByRole("link", { name: "Sort by waitlist ascending", exact: true }).click();
        await expect(page.getByTestId("roster-range")).toContainText(/1\s*[-–]\s*100 of 105/);
        await expect(waitlistCells(page).first()).toHaveText("#1");
        await page.goto(`${origin}${path}?roster_status=going#rsvp-roster`);
        for (const text of await waitlistCells(page).allTextContents()) {
          expect(text).toBe("—");
        }
        expect(harness.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
