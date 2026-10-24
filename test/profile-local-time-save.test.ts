// Post-save regressions kept separate from the independent acceptance contract.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXED_NOW,
  ORIGIN,
  OWNER,
  participationFixture,
  type Renderer,
} from "./helpers/profile-participation";

const START = new Date("2026-07-15T19:00:00.000Z");
const compare = (page: Page) =>
  page.getByRole("button", { name: "Compare local times", exact: true });
const result = (page: Page) => page.locator("[data-local-time-compare] [role='status']");

describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "profile local time after save in Chromium",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED_NOW);
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((context) => context.close()));
    });
    afterAll(async () => {
      await browser?.close();
      vi.useRealTimers();
    });

    async function open(
      renderer: Renderer,
      artifact: "source" | "shipped",
      zone: string | null = "Europe/London",
      noIntl = false,
    ) {
      const fixture = await participationFixture("completed owner");
      fixture.store.rows.get(OWNER)!.timezone = zone;
      const context = await browser.newContext({
        locale: "en-GB",
        timezoneId: "America/New_York",
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.clock.setFixedTime(START);
      const errors: string[] = [];
      const writes: number[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push(`${request.method()} ${url.href}`);
        if (url.origin !== ORIGIN) return route.abort();
        if (/^\/islands\/[a-z0-9-]+\.js$/.test(url.pathname))
          return route.fulfill({
            contentType: "text/javascript",
            body: readFileSync(
              (artifact === "source" ? "assets" : "public") + url.pathname,
              "utf8",
            ),
          });
        if (url.pathname.endsWith(".css"))
          return route.fulfill({
            contentType: "text/css",
            body: readFileSync("public" + url.pathname, "utf8"),
          });
        if (url.pathname !== fixture.path && url.pathname !== `/members/${OWNER}`)
          return route.fulfill({ status: 204 });
        const response = await fixture.request(renderer, url.pathname, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() ?? undefined,
        });
        if (request.method() === "PATCH") {
          writes.push(response.status);
          // Validation ran with Intl available; lose it before the accepted-save
          // display update, without changing the editor's existing validation.
          if (noIntl && response.status === 200) await page.evaluate("globalThis.Intl = undefined");
        }
        let body = await response.text();
        if (response.headers.get("content-type")?.includes("text/html"))
          body = body.replace(
            /(name="formOpenedAt" value=")[^"]+/,
            `$1${FIXED_NOW.getTime() - 5000}`,
          );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body,
        });
      });
      await page.goto(ORIGIN + fixture.path);
      await settle(page);
      expect(errors).toEqual([]);
      return { ...fixture, page, errors, writes, requests };
    }
    async function settle(page: Page) {
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    }
    async function edit(page: Page, zone: string) {
      if (!(await page.locator('[name="timezone"]').isVisible()))
        await page.getByTestId("profile-edit-again").click();
      await page.locator('[name="timezone"]').fill(zone);
    }
    async function save(page: Page, zone: string) {
      await edit(page, zone);
      await page.getByTestId("profile-save").click();
      await page.getByTestId("profile-saved").waitFor({ state: "visible" });
      await settle(page);
    }
    async function tokyo(fixture: Awaited<ReturnType<typeof open>>) {
      const { page } = fixture;
      const requests = fixture.requests.slice();
      const operations = fixture.operations.slice();
      expect(await compare(page).isVisible()).toBe(true);
      await compare(page).click();
      const text = await result(page).innerText();
      expect(text).toContain("Member (Asia/Tokyo)");
      expect(text).toContain("16 July 2026");
      expect(text).toContain("04:00");
      expect(text).toContain("Device (America/New_York)");
      expect(text).toContain("15:00");
      expect(text).toContain("Checked at");
      expect(text).not.toContain("Europe/London");
      expect(
        await compare(page).evaluate((node) => node === node.ownerDocument.activeElement),
      ).toBe(true);
      expect(fixture.requests).toEqual(requests);
      expect(fixture.operations).toEqual(operations);
      expect(fixture.errors).toEqual([]);
    }

    async function capture(page: Page, renderer: Renderer, artifact: string, state: string) {
      const dir = process.env.PROFILE_TIME_SAVE_EVIDENCE_DIR;
      if (!dir || artifact !== "shipped") return;
      mkdirSync(dir, { recursive: true });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        await page.screenshot({
          path: join(dir, `${state}-${renderer.toLowerCase()}-${width}.png`),
        });
      }
    }

    for (const renderer of ["Hono", "Kit"] as const) {
      for (const artifact of ["source", "shipped"] as const) {
        it(`${renderer}/${artifact} changing the saved zone discards the old result until requested again`, async () => {
          const fixture = await open(renderer, artifact);
          await compare(fixture.page).click();
          expect(await result(fixture.page).innerText()).toContain("Europe/London");
          await save(fixture.page, "Asia/Tokyo");
          expect(fixture.store.rows.get(OWNER)!.timezone).toBe("Asia/Tokyo");
          expect(await fixture.page.getByTestId("profile-timezone").innerText()).toContain(
            "Asia/Tokyo",
          );
          expect(await result(fixture.page).count()).toBe(0);
          await tokyo(fixture);
          expect(fixture.writes).toEqual([200]);
          await capture(fixture.page, renderer, artifact, "saved");
        });
        it(`${renderer}/${artifact} clearing a saved zone removes the action and stale result`, async () => {
          const fixture = await open(renderer, artifact);
          await compare(fixture.page).click();
          expect(await result(fixture.page).count()).toBe(1);
          await save(fixture.page, "");
          expect(fixture.store.rows.get(OWNER)!.timezone).toBeNull();
          expect(await compare(fixture.page).count()).toBe(0);
          expect(await result(fixture.page).count()).toBe(0);
          expect(fixture.writes).toEqual([200]);
          expect(fixture.errors).toEqual([]);
          await capture(fixture.page, renderer, artifact, "cleared");
        });
        for (const initial of [null, "", "Mars/Olympus"]) {
          it(`${renderer}/${artifact} adding a first valid zone after ${JSON.stringify(initial)} enables comparison without reload`, async () => {
            const fixture = await open(renderer, artifact, initial);
            expect(await compare(fixture.page).count()).toBe(0);
            await save(fixture.page, "Asia/Tokyo");
            expect(await result(fixture.page).count()).toBe(0);
            await tokyo(fixture);
            expect(fixture.writes).toEqual([200]);
          });
        }
        it(`${renderer}/${artifact} a save with no timezone change keeps the requested snapshot`, async () => {
          const fixture = await open(renderer, artifact);
          await compare(fixture.page).click();
          const snapshot = await result(fixture.page).innerText();
          await pageAdvance(fixture.page);
          await save(fixture.page, "Europe/London");
          expect(await result(fixture.page).innerText()).toBe(snapshot);
          expect(fixture.writes).toEqual([200]);
        });
        it(`${renderer}/${artifact} an accepted older save advances comparison without consuming a newer draft`, async () => {
          const fixture = await open(renderer, artifact);
          const { page } = fixture;
          let release!: () => void;
          let arrived!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const seen = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          await page.route("**/members/*", async (route) => {
            if (route.request().method() !== "PATCH") return route.fallback();
            arrived();
            await gate;
            return route.fallback();
          });
          try {
            await edit(page, "Asia/Tokyo");
            await page.getByTestId("profile-save").click();
            await seen;
            await page.locator('[name="timezone"]').fill("America/Los_Angeles");
            await compare(page).click();
            expect(await result(page).innerText()).toContain("Europe/London");
          } finally {
            release();
          }
          await page.getByTestId("profile-saved").waitFor({ state: "visible" });
          await tokyo(fixture);
          expect(await page.locator('[name="timezone"]').inputValue()).toBe("America/Los_Angeles");
          expect(await page.locator('[name="timezone"]').getAttribute("value")).toBe("Asia/Tokyo");
          expect(fixture.writes).toEqual([200]);
        });
        it(`${renderer}/${artifact} invalid draft refusal cannot advance the comparison`, async () => {
          const fixture = await open(renderer, artifact);
          await compare(fixture.page).click();
          const snapshot = await result(fixture.page).innerText();
          await edit(fixture.page, "Mars/Olympus");
          await fixture.page.getByTestId("profile-save").click();
          await fixture.page.getByTestId("profile-error").waitFor();
          expect(await result(fixture.page).innerText()).toBe(snapshot);
          expect(fixture.store.rows.get(OWNER)!.timezone).toBe("Europe/London");
          expect(fixture.writes).toEqual([]);
          expect(fixture.errors).toEqual([]);
        });
        it(`${renderer}/${artifact} losing Intl during a save keeps the ordinary text only`, async () => {
          const fixture = await open(renderer, artifact, null, true);
          await save(fixture.page, "Asia/Tokyo");
          expect(await fixture.page.getByTestId("profile-timezone").innerText()).toContain(
            "Asia/Tokyo",
          );
          expect(await compare(fixture.page).count()).toBe(0);
          expect(await result(fixture.page).count()).toBe(0);
          expect(fixture.writes).toEqual([200]);
          expect(fixture.errors).toEqual([]);
        });
      }
    }
    async function pageAdvance(page: Page) {
      await page.clock.setFixedTime(new Date("2026-07-15T20:00:00.000Z"));
    }
  },
);
