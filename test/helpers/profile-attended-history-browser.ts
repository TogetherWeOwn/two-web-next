// Attended-history browser cases (U3 Test Author owned).
// Registered inside the existing Chromium suite in
// test/member-profile-native-422-baseline.test.ts, so its existing CI opt-in
// and executed-test verifier apply without a new skip, workflow or gate.
// The builder never edits this file.
//
// No-JS keyboard acceptance for the self-view history section: the five
// recent nights (and the empty-state schedule link) are server-rendered,
// reachable in the native tab order, and navigate to real event pages.
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAttendedHistoryHarness,
  ORIGIN,
  type Actor,
  type AttendedHistoryHarness,
  type Renderer,
} from "./profile-attended-history";

export function registerProfileAttendedHistoryBrowserCases() {
  describe.skipIf(!process.env.DATABASE_URL)("attended history in a real browser", () => {
    let browser: Browser;
    let harness: AttendedHistoryHarness;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      harness = await createAttendedHistoryHarness();
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await harness?.dispose();
    });

    async function open(renderer: Renderer, actor: Actor, width: number) {
      await harness.reset();
      await harness.seedMatrix();
      harness.resetStatements();
      harness.audit.length = 0;
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width, height: width === 390 ? 844 : 800 },
        locale: "en-GB",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      contexts.push(context);
      const page = await context.newPage();
      const assets: Record<string, string> = {
        "/styles.css": "public/styles.css",
        "/theme.css": "public/theme.css",
        "/profile-theme.css": "public/profile-theme.css",
        "/theme-tokens.css": "public/theme-tokens.css",
        "/islands/member-profile.js": "public/islands/member-profile.js",
        "/islands/avatar.js": "public/islands/avatar.js",
      };
      const writes: { method: string; status: number }[] = [];
      const external: string[] = [];
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== ORIGIN) {
          if (request.resourceType() === "fetch" || request.resourceType() === "xhr")
            external.push(url.pathname);
          await route.abort();
          return;
        }
        if (assets[url.pathname]) {
          await route.fulfill({
            status: 200,
            contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
            body: readFileSync(assets[url.pathname]!, "utf8"),
          });
          return;
        }
        if (url.pathname === "/events") {
          await route.fulfill({
            contentType: "text/html",
            body: "<main><h1>Schedule destination fixture</h1></main>",
          });
          return;
        }
        if (url.pathname.startsWith("/e/")) {
          await route.fulfill({
            contentType: "text/html",
            body: `<main><h1>Night destination fixture</h1><p>${url.pathname}</p></main>`,
          });
          return;
        }
        if (["fetch", "xhr"].includes(request.resourceType())) external.push(url.pathname);
        const response = await harness.request(renderer, actor, url.pathname + url.search, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() ?? undefined,
        });
        if (request.method() !== "GET")
          writes.push({ method: request.method(), status: response.status });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        });
      });
      await page.goto(`${ORIGIN}/profile`);
      return { page, writes, external };
    }

    async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, label: string) {
      expect(await target.count(), `${label} is rendered`).toBe(1);
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      expect(box, `${label} has a layout box`).not.toBeNull();
      const width = page.viewportSize()!.width;
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        if (await target.evaluate((element) => element === element.ownerDocument.activeElement))
          return target;
      }
      expect.fail(`${label} is not reachable in the native keyboard tab order`);
    }

    for (const renderer of ["Hono", "Kit"] as const) {
      for (const width of [1280, 390]) {
        it(`RED: ${renderer} ${width}px no-JS owner tabs to a recent night and opens it`, async () => {
          const { page, writes, external } = await open(renderer, "owner", width);
          const section = page.getByTestId("profile-attended");
          await section.waitFor();
          // Accessible structure: a labelled section with a heading, a
          // status count and real list markup around the night links.
          expect(await page.getByRole("heading", { name: "Nights you attended" }).count()).toBe(1);
          expect(await page.getByTestId("profile-attended-count").count()).toBe(1);
          expect(await page.getByTestId("profile-attended-count").textContent()).toContain(
            "Attended 8 nights",
          );
          const links = section.getByRole("link");
          expect(await links.count()).toBe(5);
          expect(await section.locator("time[datetime]").count()).toBe(5);
          const first = section.getByRole("link", { name: "Attended Alpha Night" });
          await tabTo(page, first, "newest attended night");
          expect(await first.getAttribute("href")).toBe("/e/attended-alpha");
          const loaded = harness.statements();
          await page.keyboard.press("Enter");
          await page.waitForURL(`${ORIGIN}/e/attended-alpha`);
          expect(await page.getByRole("heading").textContent()).toBe("Night destination fixture");
          // Keyboard traversal and the static navigation issued no writes,
          // no extra reads and no background requests.
          expect(writes).toEqual([]);
          expect(external).toEqual([]);
          expect(harness.statements()).toBe(loaded);
          expect(harness.audit).toEqual([]);
        });

        it(`RED: ${renderer} ${width}px no-JS empty history links to the schedule by keyboard`, async () => {
          const { page, writes, external } = await open(renderer, "empty", width);
          const section = page.getByTestId("profile-attended");
          await section.waitFor();
          expect(await page.getByTestId("profile-attended-empty").count()).toBe(1);
          expect(await page.getByTestId("profile-attended-count").count()).toBe(0);
          const link = section.getByRole("link", { name: /event|schedule/i });
          await tabTo(page, link, "empty-history schedule link");
          expect(await link.getAttribute("href")).toBe("/events");
          await page.keyboard.press("Enter");
          await page.waitForURL(`${ORIGIN}/events`);
          expect(await page.getByRole("heading").textContent()).toBe(
            "Schedule destination fixture",
          );
          expect(writes).toEqual([]);
          expect(external).toEqual([]);
          expect(harness.audit).toEqual([]);
        });

        it(`GREEN: ${renderer} ${width}px no-JS other-member view carries no history`, async () => {
          const { page } = await open(renderer, "viewer", width);
          await page.goto(`${ORIGIN}/members/100000000000000001`);
          expect(await page.getByTestId("profile-attended").count()).toBe(0);
          expect(await page.getByTestId("profile-attended-count").count()).toBe(0);
          expect(await page.getByTestId("profile-attended-empty").count()).toBe(0);
        });
      }
    }
  });
}
