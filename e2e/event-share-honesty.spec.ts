// Test-author owned: Builder consumes unchanged; corrections return to the author.
// Run in browser CI: npm run e2e -- e2e/event-share-honesty.spec.ts
// All documents/data are local SSR fixtures; requests never reach a live site or database.
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  nativeShareFixture,
  SHARE_CANONICAL,
  SHARE_ORIGIN,
  SHARE_PATH,
  SHARE_QUERY,
  SHARE_VIEWS,
  type ShareView,
} from "../test/fixtures/event-native-share";

const publicDir = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const widths = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
type CopyProbe = { writes: string[]; finish?: () => void };

async function open(
  browser: Browser,
  view: ShareView,
  options: {
    javaScriptEnabled?: boolean;
    viewport?: { width: number; height: number };
    status?: "published" | "draft" | "past";
  } = {},
) {
  const fixture = await nativeShareFixture(view, {
    status: options.status,
    viewer: options.status === "draft" ? "moderator" : "guest",
  });
  expect(fixture.status).toBe(200);
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    viewport: options.viewport ?? widths[0],
    serviceWorkers: "block",
    locale: "en-GB",
    timezoneId: "UTC",
  });
  const errors: string[] = [];
  await context.addInitScript(() => {
    const probe: CopyProbe = { writes: [] };
    (window as unknown as { eventCopyProbe: CopyProbe }).eventCopyProbe = probe;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          probe.writes.push(value);
          return new Promise<void>((done) => {
            probe.finish = done;
          });
        },
      },
    });
    // Native sharing is outside this contract; only the existing clipboard island runs.
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === SHARE_ORIGIN && url.pathname === SHARE_PATH) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture.html });
    }
    const path = resolve(publicDir, `.${url.pathname}`);
    if (url.origin === SHARE_ORIGIN && path.startsWith(publicDir + sep)) {
      try {
        const body = await readFile(path);
        const contentType =
          (
            {
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".woff2": "font/woff2",
            } as Record<string, string>
          )[extname(path)] ?? "application/octet-stream";
        return route.fulfill({ contentType, body });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // No external network, real data fetch, or mutating route can escape the fixture.
    return route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const response = await page.goto(SHARE_ORIGIN + SHARE_PATH + SHARE_QUERY);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toBeVisible();
    return { page, context, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

const shareSection = (page: Page) => page.locator("section.event-share");
const copyProbe = (page: Page) =>
  page.evaluate(() => (window as unknown as { eventCopyProbe: CopyProbe }).eventCopyProbe.writes);

async function copyWithFeedback(page: Page) {
  // Catches a visible dead control, navigation instead of copying, private query leakage,
  // and a success toast that fires before the clipboard write actually settles.
  const before = page.url();
  const section = shareSection(page);
  const copy = section.locator(`[data-copy-link="${SHARE_CANONICAL}"]`);
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAccessibleName(/copy.*link/i);
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => copyProbe(page)).toEqual([SHARE_CANONICAL]);
  const toast = section.locator("[data-copy-toast]");
  await expect(toast).not.toContainText(/copied/i);
  await page.evaluate(() => {
    (window as unknown as { eventCopyProbe: CopyProbe }).eventCopyProbe.finish!();
  });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/copied/i);
  await expect(toast).toHaveAttribute("role", "status");
  expect(page.url()).toBe(before);
}

for (const view of SHARE_VIEWS) {
  test.describe(`${view} honest event sharing`, () => {
    for (const viewport of widths) {
      test(`no JavaScript: canonical URL is readonly and keyboard selectable at ${viewport.width}px`, async ({
        browser,
      }) => {
        // Catches a hidden, disabled or missing manual-copy URL on either viewport.
        const { page, context } = await open(browser, view, { javaScriptEnabled: false, viewport });
        try {
          const field = shareSection(page).locator(`input[value="${SHARE_CANONICAL}"]`);
          await expect(field).toBeVisible();
          await expect(field).toHaveAttribute("readonly");
          await expect(field).toBeEnabled();
          await field.click();
          await page.keyboard.press("ControlOrMeta+A");
          expect(
            await field.evaluate((node: HTMLInputElement) =>
              node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0),
            ),
          ).toBe(SHARE_CANONICAL);
        } finally {
          await context.close();
        }
      });

      test(`no JavaScript: no visible control promises copying at ${viewport.width}px`, async ({
        browser,
      }) => {
        // Includes anchors: an anchor named Copy link must not silently navigate.
        const { page, context } = await open(browser, view, { javaScriptEnabled: false, viewport });
        try {
          const section = shareSection(page);
          await expect(section).toBeVisible();
          await expect(section.getByRole("link", { name: /copy/i })).toHaveCount(0);
          await expect(section.getByRole("button", { name: /copy/i })).toHaveCount(0);
        } finally {
          await context.close();
        }
      });
    }

    test("JavaScript enables canonical copying with settled clipboard feedback", async ({
      browser,
    }) => {
      const { page, context, errors } = await open(browser, view);
      try {
        await copyWithFeedback(page);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

    for (const javaScriptEnabled of [false, true]) {
      test(`moderator draft actions are absent or visibly moderator-only (JavaScript ${javaScriptEnabled})`, async ({
        browser,
      }) => {
        // Catches public-looking actions whose draft targets reject ordinary recipients.
        const { page, context } = await open(browser, view, { status: "draft", javaScriptEnabled });
        try {
          await expect(page.getByTestId("event-draft")).toBeVisible();
          const section = shareSection(page);
          const actions = section.locator("a, button, input, textarea").filter({ visible: true });
          if ((await actions.count()) > 0) {
            await expect
              .poll(() => section.innerText())
              .toMatch(/moderator[- ]only|only.{0,30}moderators?/i);
          }
        } finally {
          await context.close();
        }
      });
    }

    test("past page retains its calendar actions and working canonical copy", async ({
      browser,
    }) => {
      // The fixture deliberately exercises the stored past status, not date-based RSVP rules.
      const { page, context, errors } = await open(browser, view, { status: "past" });
      try {
        await expect(page.getByTestId("event-past")).toBeVisible();
        await expect(page.getByTestId("event-ics")).toBeVisible();
        await expect(page.getByTestId("event-google-calendar")).toBeVisible();
        await copyWithFeedback(page);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
}
