// Independent, hermetic browser acceptance. No QA login, live server or DB.
// Local command uses test/helpers/activity-log-window.config.ts; standard E2E
// discovers this file too. Both paths execute the same native no-JS journeys.
import { readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  activityWindowHarness,
  compileActivityWindowKit,
  WINDOW_ORIGIN,
  windowRows,
} from "../test/helpers/activity-log-window";

let kit: Awaited<ReturnType<typeof compileActivityWindowKit>>;
test.beforeAll(async () => {
  kit = await compileActivityWindowKit();
});
test.use({ javaScriptEnabled: false, serviceWorkers: "block" });

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 24; i++) {
    if (await target.evaluate((el) => el === el.ownerDocument.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const [name, viewport, timezoneId] of [
    ["desktop", { width: 1280, height: 800 }, "America/New_York"],
    ["mobile", { width: 390, height: 844 }, "Pacific/Auckland"],
  ] as const) {
    test.describe(`${twin} activity windows without JavaScript (${name})`, () => {
      test.use({ viewport, timezoneId });

      test("keyboard selection submits page one and both paging links retain all filters", async ({
        page,
      }) => {
        const fixture = activityWindowHarness(kit, { rows: windowRows(153) });
        const requests: { method: string; url: URL }[] = [];
        await page.route("**/*", async (route) => {
          const req = route.request();
          const url = new URL(req.url());
          if (url.origin !== WINDOW_ORIGIN)
            throw new Error("External requests are not fixture traffic");
          if (req.isNavigationRequest()) {
            requests.push({ method: req.method(), url });
            const reply = await fixture.request(twin, `${url.pathname}${url.search}`);
            await route.fulfill({
              status: reply.status,
              contentType: "text/html",
              body: reply.html,
            });
          } else if (url.pathname === "/styles.css") {
            await route.fulfill({
              contentType: "text/css",
              body: readFileSync(new URL("../public/styles.css", import.meta.url), "utf8"),
            });
          } else {
            await route.abort();
          }
        });
        await page.goto(
          `${WINDOW_ORIGIN}/admin/activity-log?subject=Event&causer=100&when=all&page=3`,
        );
        const when = page.getByLabel("When", { exact: true });
        // Count fails immediately on the old renderer, not after a navigation timeout.
        expect(await when.count()).toBe(1);
        await expect(when).toHaveJSProperty("tagName", "SELECT");
        await expect(when.locator("option")).toHaveText([
          "All recorded time",
          "Last 24 hours",
          "Last 7 days",
          "Last 30 days",
        ]);
        await tabTo(page, when);
        await expect(when).toBeFocused();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(when).toHaveValue("7d");
        await tabTo(page, page.getByRole("button", { name: "Filter", exact: true }));
        await Promise.all([
          page.waitForURL(
            (url) => url.searchParams.get("when") === "7d" && url.searchParams.get("page") !== "3",
          ),
          page.keyboard.press("Enter"),
        ]);
        let url = new URL(page.url());
        expect(url.searchParams.get("page") ?? "1").toBe("1");
        expect(url.searchParams.get("subject")).toBe("Event");
        expect(url.searchParams.get("causer")).toBe("100");
        await expect(page.getByLabel("When", { exact: true })).toHaveValue("7d");
        const next = page.getByRole("link", { name: "Next", exact: true });
        await tabTo(page, next);
        await Promise.all([
          page.waitForURL((u) => u.searchParams.get("page") === "2"),
          page.keyboard.press("Enter"),
        ]);
        url = new URL(page.url());
        expect(Object.fromEntries(url.searchParams)).toEqual({
          when: "7d",
          subject: "Event",
          causer: "100",
          page: "2",
        });
        const previous = page.getByRole("link", { name: "Previous", exact: true });
        await tabTo(page, previous);
        await Promise.all([
          page.waitForURL((u) => u.searchParams.get("page") === "1"),
          page.keyboard.press("Enter"),
        ]);
        url = new URL(page.url());
        expect(Object.fromEntries(url.searchParams)).toEqual({
          when: "7d",
          subject: "Event",
          causer: "100",
          page: "1",
        });
        expect(requests).toHaveLength(4);
        expect(requests.every((r) => r.method === "GET")).toBe(true);
        expect(await page.locator('input[type="date"], input[type="datetime-local"]').count()).toBe(
          0,
        );
      });

      test("CONTROL: subject/causer GET filtering works without JavaScript", async ({ page }) => {
        const fixture = activityWindowHarness(kit, { rows: [] });
        const methods: string[] = [];
        await page.route("**/*", async (route) => {
          const req = route.request();
          const url = new URL(req.url());
          if (url.origin !== WINDOW_ORIGIN)
            throw new Error("External requests are not fixture traffic");
          if (!req.isNavigationRequest()) {
            await route.abort();
            return;
          }
          methods.push(req.method());
          const reply = await fixture.request(twin, `${url.pathname}${url.search}`);
          await route.fulfill({ status: reply.status, contentType: "text/html", body: reply.html });
        });
        await page.goto(`${WINDOW_ORIGIN}/admin/activity-log?page=3`);
        const subject = page.getByLabel("Subject", { exact: true });
        await tabTo(page, subject);
        await page.keyboard.type("Event");
        const causer = page.getByLabel("Causer", { exact: true });
        await tabTo(page, causer);
        await page.keyboard.type("100");
        await tabTo(page, page.getByRole("button", { name: "Filter", exact: true }));
        await Promise.all([
          page.waitForURL((u) => u.searchParams.get("subject") === "Event"),
          page.keyboard.press("Enter"),
        ]);
        const url = new URL(page.url());
        expect(url.searchParams.get("causer")).toBe("100");
        expect(url.searchParams.get("page") ?? "1").toBe("1");
        await expect(page.getByTestId("activity-log-empty")).toHaveText(
          "No activity matches these filters.",
        );
        expect(methods).toEqual(["GET", "GET"]);
      });
    });
  }
}
