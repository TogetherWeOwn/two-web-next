// Registered inside the existing featured native browser opt-in. No new skip or CI gate.
// FEATURED_NATIVE_BROWSER_TESTS=true npx vitest run test/featured-native-length.test.ts
import { readFileSync } from "node:fs";
import type { Browser } from "playwright";
import { expect, it } from "vitest";
import {
  APP_URL,
  SAVED_BODY,
  SAVED_TITLE,
  WINDOW_CASES,
  savedFeatured,
} from "./featured-saved-content-cases";
import { renderSavedHono, renderSavedKit } from "./featured-saved-content-render";

const css = readFileSync(new URL("../../public/styles.css", import.meta.url), "utf8");
const editor = readFileSync(
  new URL("../../public/islands/admin-event-editor.js", import.meta.url),
  "utf8",
);

async function openFixture(
  browser: Browser,
  html: string,
  width: number,
  javaScriptEnabled = false,
) {
  const context = await browser.newContext({
    javaScriptEnabled,
    viewport: { width, height: width === 390 ? 844 : 800 },
  });
  const page = await context.newPage();
  const writes: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      writes.push(request.method());
      await route.abort();
    } else if (request.resourceType() === "document") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`,
      });
    } else if (new URL(request.url()).pathname === "/styles.css") {
      await route.fulfill({ contentType: "text/css", body: css });
    } else if (new URL(request.url()).pathname === "/islands/admin-event-editor.js") {
      await route.fulfill({ contentType: "text/javascript", body: editor });
    } else {
      // Fonts and approved image URLs never leave the intercepted fixture context.
      await route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto(`${APP_URL}/admin/featured/41`);
  return { context, page, writes };
}

export function registerSavedContentBrowser(getBrowser: () => Browser) {
  for (const [twin, render] of [
    ["Hono", renderSavedHono],
    ["Kit", renderSavedKit],
  ] as const) {
    for (const width of [1280, 390]) {
      for (const fixture of WINDOW_CASES.slice(0, 4)) {
        it(`SC16-${twin}-${width}-${fixture.status}: saved card and named eligibility work without JavaScript`, async () => {
          const { context, page, writes } = await openFixture(
            getBrowser(),
            await render(savedFeatured(fixture.row)),
            width,
          );
          try {
            const panel = page.locator('[data-testid="featured-preview"]');
            expect(
              await panel
                .getByRole("heading", { name: "Saved content preview", exact: true })
                .count(),
            ).toBe(1);
            expect(
              await panel.getByRole("heading", { name: /Homepage eligibility/i }).count(),
            ).toBe(1);
            const item = panel.locator('[data-testid="featured-item"]');
            expect(await item.count()).toBe(1);
            expect(await item.innerText()).toContain(SAVED_TITLE);
            expect(await item.innerText()).toContain(SAVED_BODY);
            expect(
              await item.getByRole("link", { name: SAVED_TITLE, exact: true }).getAttribute("href"),
            ).toBe("https://example.com/community-night");
            expect(
              await item
                .getByRole("img", { name: "A table ready for board games", exact: true })
                .count(),
            ).toBe(1);
            expect(await panel.locator(`[data-status="${fixture.status}"]`).innerText()).toBe(
              fixture.status,
            );
            expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(1);
            await page.getByRole("textbox", { name: "Headline", exact: true }).focus();
            await page.keyboard.press("Tab");
            expect(
              await page
                .locator('[name="body"]')
                .evaluate((element) => element === document.activeElement),
            ).toBe(true);
            expect(writes).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }

      it(`SC17-${twin}-${width}: typing a draft never replaces a saved unpublished card`, async () => {
        const { context, page, writes } = await openFixture(
          getBrowser(),
          await render(savedFeatured({ isPublished: false })),
          width,
          true,
        );
        try {
          await page
            .getByRole("textbox", { name: "Headline", exact: true })
            .fill("UNSAVED draft headline");
          await page.getByRole("textbox", { name: "Body", exact: true }).fill("UNSAVED draft body");
          const panel = page.locator('[data-testid="featured-preview"]');
          const item = panel.locator('[data-testid="featured-item"]');
          expect(await item.count()).toBe(1);
          expect(await item.innerText()).toContain(SAVED_TITLE);
          expect(await item.innerText()).toContain(SAVED_BODY);
          expect(await panel.innerText()).not.toContain("UNSAVED");
          expect(await panel.locator('[data-status="unpublished"]').innerText()).toBe(
            "unpublished",
          );
          expect(await page.locator('[name="title"]').inputValue()).toBe("UNSAVED draft headline");
          expect(writes).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
}
