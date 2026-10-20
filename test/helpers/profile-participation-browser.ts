// Registered inside the existing Chromium suite, so its existing CI opt-in
// and executed-test verifier apply without a new skip, workflow or gate.
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXED_NOW,
  ORIGIN,
  OWNER,
  participationFixture,
  type Presentation,
  type Renderer,
} from "./profile-participation";

export function registerProfileParticipationBrowserCases() {
  describe("profile participation: native and shipped-island acceptance", () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED_NOW);
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      vi.useRealTimers();
    });

    async function open(
      renderer: Renderer,
      presentation: Presentation,
      javaScriptEnabled: boolean,
      width = 390,
    ) {
      const fixture = await participationFixture(presentation);
      const context = await browser.newContext({
        javaScriptEnabled,
        viewport: { width, height: width === 390 ? 844 : 800 },
        locale: "en-GB",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      contexts.push(context);
      const page = await context.newPage();
      if (javaScriptEnabled) await page.clock.setFixedTime(FIXED_NOW);
      const assets: Record<string, string> = {
        "/styles.css": "public/styles.css",
        "/theme.css": "public/theme.css",
        "/profile-theme.css": "public/profile-theme.css",
        "/islands/member-profile.js": "public/islands/member-profile.js",
        "/islands/avatar.js": "public/islands/avatar.js",
      };
      const writes: { method: string; status: number }[] = [];
      const external: string[] = [];
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== ORIGIN) {
          // Fonts and CDN images are not part of the navigation contract.
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
          // Terminal navigation witness only, not a substitute Events renderer.
          await route.fulfill({
            contentType: "text/html",
            body: "<main><h1>Events destination fixture</h1></main>",
          });
          return;
        }
        if (
          ["fetch", "xhr"].includes(request.resourceType()) &&
          !(request.method() === "PATCH" && url.pathname === `/members/${OWNER}`)
        )
          external.push(url.pathname);
        const response = await fixture.request(renderer, url.pathname + url.search, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() ?? undefined,
        });
        if (request.method() !== "GET")
          writes.push({ method: request.method(), status: response.status });
        let body = await response.text();
        if (response.headers.get("content-type")?.includes("text/html")) {
          // Model five seconds of editing, without sleeping or changing the trap.
          body = body.replace(
            /(name="formOpenedAt" value=")[^"]+/,
            `$1${FIXED_NOW.getTime() - 5000}`,
          );
        }
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body,
        });
      });
      await page.goto(ORIGIN + fixture.path);
      return { ...fixture, page, writes, external };
    }

    const events = (page: Page) =>
      page
        .getByRole("navigation", { name: "Primary", exact: true })
        .getByRole("link", { name: "Events", exact: true });
    async function keyboardToEvents(page: Page) {
      const link = events(page);
      expect(await link.count(), "Events must remain in primary navigation").toBe(1);
      await link.scrollIntoViewIfNeeded();
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      const width = page.viewportSize()!.width;
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        if (await link.evaluate((element) => element === element.ownerDocument.activeElement))
          return link;
      }
      expect.fail("Events is not reachable in the native keyboard tab order");
    }
    async function fillAndSave(page: Page) {
      await page.locator('[name="bio"]').fill("Ready to meet people for Chess.");
      await page.locator('[name="games_text"]').fill("Chess");
      await page.locator('[name="timezone"]').fill("Europe/London");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("profile-saved").waitFor({ state: "visible" });
    }

    for (const renderer of ["Hono", "Kit"] as const) {
      for (const width of [1280, 390]) {
        it.each<Presentation>(["new owner", "completed owner", "other member", "moderator"])(
          `${renderer} ${width}px no-JS: %s can reach Events by keyboard without new reads`,
          async (presentation) => {
            const fixture = await open(renderer, presentation, false, width);
            const { page } = fixture;
            expect(await page.getByTestId("profile-form").count()).toBe(
              presentation.endsWith("owner") ? 1 : 0,
            );
            expect(await page.getByTestId("profile-new-member").isVisible()).toBe(
              presentation === "new owner",
            );
            expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
            if (presentation === "new owner") {
              const panel = page.getByTestId("profile-new-member");
              expect(await panel.locator('a[href="#edit-heading"]').count()).toBe(1);
              expect(
                await panel.locator('a[href="/events"]').count(),
                "Distinct event next step in the owner panel",
              ).toBe(1);
            }
            const link = await keyboardToEvents(page);
            expect(await link.getAttribute("href")).toBe("/events");
            await page.keyboard.press("Enter");
            await page.waitForURL(ORIGIN + "/events");
            expect(await page.getByRole("heading").textContent()).toBe(
              "Events destination fixture",
            );
            expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
            expect(fixture.writes).toEqual([]);
            expect(fixture.external).toEqual([]);
          },
        );
      }

      it.each<Presentation>(["new owner", "completed owner"])(
        `${renderer}: %s can save, reopen, reset and then choose Events without automatic navigation`,
        async (presentation) => {
          const fixture = await open(renderer, presentation, true);
          const { page } = fixture;
          const initialUrl = page.url();
          const dialogs: string[] = [];
          page.on("dialog", async (dialog) => {
            dialogs.push(dialog.type());
            await dialog.dismiss();
          });
          await fillAndSave(page);
          expect(page.url()).toBe(initialUrl);
          expect(await page.getByTestId("profile-new-member").isVisible()).toBe(false);
          expect(await page.getByTestId("profile-form").isVisible()).toBe(false);
          expect
            .soft(await events(page).count(), "Events survives successful save with hidden panels")
            .toBe(1);
          await page.getByTestId("profile-edit-again").click();
          await page.locator('[name="bio"]').fill("Discard this second draft");
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect
            .poll(() => page.locator('[name="bio"]').inputValue())
            .toBe("Ready to meet people for Chess.");
          expect(page.url()).toBe(initialUrl);
          expect(await page.getByTestId("profile-bio").textContent()).toContain(
            "Ready to meet people for Chess.",
          );
          expect(await page.locator('[name="bio"]').inputValue()).toBe(
            "Ready to meet people for Chess.",
          );
          expect(fixture.writes).toEqual([{ method: "PATCH", status: 200 }]);
          expect(
            fixture.operations.filter((operation) => operation.method === "save"),
          ).toHaveLength(1);
          expect(fixture.external).toEqual([]);
          const link = events(page);
          expect(
            await link.count(),
            "Participation must survive hidden onboarding/editor panels",
          ).toBe(1);
          await link.click();
          await page.waitForURL(ORIGIN + "/events");
          expect(dialogs).toEqual([]);
        },
      );

      it(`${renderer} positive control: existing navigation warns for a dirty draft and Cancel clears it`, async () => {
        const fixture = await open(renderer, "completed owner", true);
        const { page } = fixture;
        const initialUrl = page.url();
        await page.locator('[name="bio"]').fill("Keep this unsaved draft");
        const departure = page.waitForEvent("dialog");
        const click = page
          .getByRole("navigation", { name: "Primary", exact: true })
          .getByRole("link", { name: "Your profile", exact: true })
          .click();
        const dialog = await departure;
        expect(dialog.type()).toBe("beforeunload");
        await dialog.dismiss();
        await click;
        expect(page.url()).toBe(initialUrl);
        expect(await page.locator('[name="bio"]').inputValue()).toBe("Keep this unsaved draft");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect
          .poll(() => page.locator('[name="bio"]').inputValue())
          .toBe("A member who likes board games.");
        expect(
          await page.evaluate<boolean>(
            "(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()",
          ),
        ).toBe(false);
        expect(fixture.writes).toEqual([]);
      });

      it(`${renderer}: dirty Events departure can be refused, then explicit Cancel permits navigation`, async () => {
        const fixture = await open(renderer, "completed owner", true);
        const { page } = fixture;
        const initialUrl = page.url();
        await page.locator('[name="bio"]').fill("Unsaved draft must survive refused departure");
        const link = events(page);
        expect(await link.count()).toBe(1);
        const refused = page.waitForEvent("dialog");
        const click = link.click();
        const dialog = await refused;
        expect(dialog.type()).toBe("beforeunload");
        await dialog.dismiss();
        await click;
        expect(page.url()).toBe(initialUrl);
        expect(await page.locator('[name="bio"]').inputValue()).toBe(
          "Unsaved draft must survive refused departure",
        );
        expect(fixture.writes).toEqual([]);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect
          .poll(() => page.locator('[name="bio"]').inputValue())
          .toBe("A member who likes board games.");
        await link.click();
        await page.waitForURL(ORIGIN + "/events");
        expect(fixture.writes).toEqual([]);
      });

      it(`${renderer} positive control: native invalid save retains draft, then corrected save uses shared Hono`, async () => {
        const fixture = await open(renderer, "new owner", false);
        const { page } = fixture;
        await page.locator('[name="bio"]').fill("Native draft");
        await page.locator('[name="timezone"]').fill("Mars/Olympus");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByTestId("profile-error").waitFor();
        expect(await page.locator('[name="bio"]').inputValue()).toBe("Native draft");
        expect(await page.locator('[name="timezone"]').inputValue()).toBe("Mars/Olympus");
        expect(fixture.writes).toEqual([{ method: "POST", status: 422 }]);
        await page.locator('[name="timezone"]').fill("Europe/London");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL(ORIGIN + `/members/${OWNER}`);
        expect((await fixture.store.find(OWNER))!.bio).toBe("Native draft");
        expect(fixture.writes).toEqual([
          { method: "POST", status: 422 },
          { method: "POST", status: 303 },
        ]);
      });
    }
  });
}
