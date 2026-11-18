import postgres from "postgres";
import { requireTestDatabase } from "../ci-only.mjs";
import { expect, localOrigin, test } from "../fixtures";
import {
  captureWithGeometry,
  captureWithoutFontWait,
  expectStablePublicPageCapture,
  loadVisualFont,
  readCaptureGeometry,
  renderedPlatformFonts,
} from "./font-evidence";

// Public pages only: no session, no writes. Server-rendered times depend on the
// wall clock, so every <time> element is masked; everything else must match the
// committed baseline within maxDiffPixels (playwright.visual.config.ts).
// Changing a baseline is a deliberate act: see docs/visual-regression.md.
const ROUTES: Array<[name: string, path: string]> = [
  ["home", "/"],
  ["events", "/events"],
  ["event", "/e/01J00000000000000000000001"],
  ["past", "/events/past"],
  ["about", "/about"],
  ["rules", "/rules"],
  ["privacy", "/privacy"],
];

const VIEWPORTS: Array<[name: string, size: { width: number; height: number }]> = [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
];

for (const [viewport, size] of VIEWPORTS) {
  for (const [name, path] of ROUTES) {
    test(`${name} @ ${viewport}`, async ({ page: fixturePage }, testInfo) => {
      let page = fixturePage;
      await page.setViewportSize(size);
      if (name === "privacy") {
        await page.route("**/fonts/fragment-mono-latin-400.woff2", (route) => route.abort());
      }
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      if (name === "privacy") {
        await page.evaluate(() => document.fonts.ready);
        const code = page.locator(".base-theme.content-theme code").first();
        await code.evaluate((node) => node.setAttribute("data-font-evidence", ""));
        const selector = ".base-theme.content-theme code[data-font-evidence]";
        const selectors = { code: selector };
        const fonts = await renderedPlatformFonts(page, selector);
        expect(fonts.some((font) => font.isCustomFont && font.familyName === "Fragment Mono")).toBe(
          false,
        );
        expect(fonts.some((font) => font.glyphCount > 0)).toBe(true);
        const beforeIdle = await readCaptureGeometry(page, selectors);
        await page.evaluate(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        });
        const afterIdle = await readCaptureGeometry(page, selectors);
        const idleFonts = await renderedPlatformFonts(page, selector);
        expect(afterIdle).toEqual(beforeIdle);
        expect(idleFonts).toEqual(fonts);
        const settling = await captureWithGeometry(page, selectors);
        const settlingFonts = await renderedPlatformFonts(page, selector);
        await testInfo.attach(`privacy-${viewport}-baseline-settling.png`, {
          body: settling.png,
          contentType: "image/png",
        });
        await testInfo.attach(`privacy-${viewport}-baseline-settling.json`, {
          body: JSON.stringify(
            { before: settling.before, after: settling.after, idleFonts, settlingFonts },
            null,
            2,
          ),
          contentType: "application/json",
        });
        expect(settling.before).toEqual(afterIdle);
        if (JSON.stringify(settling.before) !== JSON.stringify(settling.after)) {
          expect(settlingFonts.map((font) => font.familyName)).not.toEqual(
            idleFonts.map((font) => font.familyName),
          );
        }
        await expect.soft(page).toHaveScreenshot(`privacy-fallback-${viewport}.png`, {
          fullPage: true,
          mask: [page.locator("time")],
        });
        // The normalized capture must be the first capture on a fresh page.
        page = await page.context().newPage();
        await page.setViewportSize(size);
        expect((await page.goto(path))?.status()).toBe(200);
        await page.waitForLoadState("networkidle");
      }
      // Normalize content screenshots with a separately named, explicitly
      // loaded face; it must not compete with the shipped optional face.
      const OPTIONAL_FACE =
        "font-family:Mona Sans Content;font-weight:200 900;font-display:optional;";
      expect(OPTIONAL_FACE.replace("optional;", "optionalfoo;")).not.toContain(OPTIONAL_FACE);
      const isContentPage = await page.evaluate(() =>
        Boolean(document.querySelector(".content-theme")),
      );
      if (isContentPage) {
        const saw = await page.evaluate(
          (s: string) => Boolean(document.head.textContent?.includes(s)),
          OPTIONAL_FACE,
        );
        expect(saw).toBe(true);
        let normalizedCodeFonts: Awaited<ReturnType<typeof renderedPlatformFonts>> | undefined;
        const font = await loadVisualFont(page, {
          url: "/fonts/mona-sans-latin-wght.woff2",
          weight: "200 900",
        });
        expect(font.status).toBe("loaded");
        await page.evaluate((family) => {
          const root = document.querySelector<HTMLElement>(".content-theme")!;
          const stack = getComputedStyle(root).getPropertyValue("--font-display");
          if (!/^\s*['"]?Mona Sans Content['"]?\s*,/.test(stack)) {
            throw new Error("Unexpected content display font stack");
          }
          root.style.setProperty(
            "--font-display",
            stack.replace(/^\s*['"]?Mona Sans Content['"]?\s*,/, `"${family}",`),
          );
        }, font.family);
        if (name === "privacy") {
          // Normalize the code face independently of the blocked-font control above.
          const codeFont = await loadVisualFont(page, {
            url: "/fonts/fragment-mono-latin-400.woff2",
          });
          await page.locator(".content-theme code").evaluateAll((nodes, family) => {
            for (const node of nodes) (node as HTMLElement).style.fontFamily = `"${family}"`;
            nodes[0]?.setAttribute("data-code-proof", "");
          }, codeFont.family);
          normalizedCodeFonts = await renderedPlatformFonts(page, "code[data-code-proof]");
          expect(normalizedCodeFonts.length).toBeGreaterThan(0);
          expect(
            normalizedCodeFonts.every(
              (used) =>
                used.isCustomFont &&
                used.postScriptName === "FragmentMono-Regular" &&
                used.glyphCount > 0,
            ),
          ).toBe(true);
        }
        await page.evaluate(() => document.fonts.ready);
        const fonts = await renderedPlatformFonts(page, ".content-theme h1");
        expect(fonts.length).toBeGreaterThan(0);
        expect(
          fonts.every(
            (used) =>
              used.isCustomFont &&
              used.glyphCount > 0 &&
              used.postScriptName === "MonaSansExtraLight-Regular",
          ),
        ).toBe(true);
        await expectStablePublicPageCapture(page, testInfo, {
          heading: ".content-theme h1",
          width: size.width,
          snapshot: `${name}-${viewport}.png`,
          afterFirst: async () => {
            if (name === "privacy") {
              expect(await renderedPlatformFonts(page, "code[data-code-proof]")).toEqual(
                normalizedCodeFonts,
              );
            }
          },
        });
      } else {
        await expect(page).toHaveScreenshot(`${name}-${viewport}.png`, {
          fullPage: true,
          mask: [page.locator("time")],
        });
      }
    });
  }
}

for (const [viewport, size] of VIEWPORTS) {
  test(`cold optional fallback does not swap @ ${viewport}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const request = page.waitForRequest((req) => req.url().includes("mona-sans-latin-wght.woff2"));
    await page.route("**/fonts/mona-sans-latin-wght.woff2", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      expect((await page.goto("/about", { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      await request;
      const heading = ".content-theme h1";
      await expect
        .poll(async () => {
          const fonts = await renderedPlatformFonts(page, heading);
          return (
            fonts.length > 0 &&
            fonts.every(
              (font) => font.glyphCount > 0 && !/^MonaSansExtraLight/.test(font.postScriptName),
            )
          );
        })
        .toBe(true);
      expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
      const before = await readCaptureGeometry(page, { heading });
      const fonts = await renderedPlatformFonts(page, heading);
      const painted = await captureWithoutFontWait(page);
      expect([painted.readUInt32BE(16), painted.readUInt32BE(20)]).toEqual([
        size.width,
        size.height,
      ]);
      await testInfo.attach("cold-fallback", { body: painted, contentType: "image/png" });
      // Keep layout unchanged and prove the visible heading contributed pixels.
      await page.locator(heading).evaluate((el) => {
        (el as HTMLElement).style.visibility = "hidden";
      });
      const hidden = await captureWithoutFontWait(page);
      expect(hidden.equals(painted)).toBe(false);
      await page.locator(heading).evaluate((el) => {
        (el as HTMLElement).style.removeProperty("visibility");
      });
      release();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await renderedPlatformFonts(page, heading)).toEqual(fonts);
      expect(await readCaptureGeometry(page, { heading })).toEqual(before);
    } finally {
      release();
    }
  });
}

// Event member states. Both fixtures are inserted AFTER the public routes
// above have been compared and deleted before the journeys start: a future
// paused or cancelled row would otherwise join /events, the seeded event's
// "more events" cards and the journeys' lists, and re-baseline pages this
// block does not own. The seed (e2e/seed.mjs) stays untouched for the same
// reason. Tests in one file run in declaration order (workers: 1, not fully
// parallel), so this block always runs last.
const STATE_FIXTURES = {
  // Published with RSVPs paused: only a signed-in member sees the paused notice
  // (a guest gets the sign-in link whatever the flag says).
  paused: {
    key: "01J00000000000000000000005",
    title: "E2E Visual Paused Night",
    status: "published",
    rsvpOpen: false,
  },
  // The cancelled page renders before any session read, so it is the same 410
  // for a guest and a member: no login needed.
  cancelled: {
    key: "01J00000000000000000000006",
    title: "E2E Visual Cancelled Night",
    status: "cancelled",
    rsvpOpen: true,
  },
} as const;

test.describe("event member states", () => {
  test.beforeAll(async () => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      for (const [index, fixture] of Object.values(STATE_FIXTURES).entries()) {
        // Delete first: a worker restart after a failed test re-runs this hook.
        await sql`delete from events where event_key = ${fixture.key}`;
        await sql`
          insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
          values (${fixture.key}, ${fixture.title}, 'Disposable visual-state fixture',
            ${`2099-09-${15 + index}T18:00:00Z`}, ${`2099-09-${15 + index}T20:00:00Z`}, 'UTC',
            ${fixture.status}, 10, ${fixture.rsvpOpen})
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test.afterAll(async () => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      for (const fixture of Object.values(STATE_FIXTURES)) {
        await sql`delete from events where event_key = ${fixture.key}`;
      }
    } finally {
      await sql.end();
    }
  });

  for (const [viewport, size] of VIEWPORTS) {
    test(`cancelled @ ${viewport}`, async ({ page }) => {
      await page.setViewportSize(size);
      const response = await page.goto(`/e/${STATE_FIXTURES.cancelled.key}`);
      expect(response?.status()).toBe(410);
      await expect(page.getByTestId("event-cancelled")).toHaveText("Cancelled");
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`event-cancelled-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    });
  }

  // Sign in through the stubbed Discord OAuth round trip (the same stub as
  // e2e/join.spec.ts), not POST /auth/qa/:identity: the journeys that run next
  // already spend the whole 10/min qa-login throttle (e2e/fixtures.ts), so one
  // more QA login here pushes the last journey login into a 429. The OAuth
  // routes have their own buckets with plenty of headroom. One login serves
  // both widths.
  test("paused as a signed-in member @ desktop and mobile", async ({ page, context }) => {
    await context.route(`${localOrigin}/auth/discord`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const state = new URL(response.headers().location!).searchParams.get("state");
      expect(state).toBeTruthy();
      // Keep the production state cookie; swap only the authorize hop for the
      // stub's local callback. No request reaches Discord.
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          location: `${localOrigin}/auth/discord/callback?code=e2e-code&state=${encodeURIComponent(state!)}`,
        },
      });
    });
    await page.goto("/auth/discord");
    // The landing page also consumes any one-shot sign-in flash, so neither
    // width's screenshot below carries it.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    for (const [viewport, size] of VIEWPORTS) {
      await page.setViewportSize(size);
      const response = await page.goto(`/e/${STATE_FIXTURES.paused.key}`);
      expect(response?.status()).toBe(200);
      // The member view, not the guest one: paused notice, no join control.
      await expect(page.getByTestId("rsvp-paused")).toBeVisible();
      await expect(page.getByTestId("rsvp-going")).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      // Soft: a desktop diff must not hide the mobile image, so one run
      // yields both actual images for ci/visual-accept.mjs.
      await expect.soft(page).toHaveScreenshot(`event-paused-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    }
  });
});
