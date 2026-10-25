// Local fixtures, real rendered pages and shipped dirty-navigation controller.
// Discovered by browser-smoke; focused config also works without a dev server.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  origin,
  query,
  search,
  slot,
  renderInventory,
  renderEditor,
  type Renderer,
} from "../test/helpers/featured-inventory-return";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let kitStyles: string[];
test.beforeAll(async () => {
  const node = await import(
    pathToFileURL(resolve(root, "web/.svelte-kit/output/server/nodes/0.js")).href
  );
  kitStyles = node.stylesheets;
});
async function mount(context: BrowserContext, renderer: Renderer) {
  const documents: string[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (["/admin/featured", "/admin/featured/7"].includes(url.pathname)) {
      documents.push(url.pathname + url.search);
      const rendered =
        url.pathname === "/admin/featured"
          ? await renderInventory(renderer, "featured", url.search, [slot])
          : await renderEditor(renderer, url);
      const body =
        renderer === "Kit"
          ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${kitStyles.map((href) => `<link rel="stylesheet" href="/${href}">`).join("")}</head><body>${rendered.html}</body></html>`
          : rendered.html;
      return route.fulfill({ status: rendered.status, contentType: "text/html", body });
    }
    for (const base of [resolve(root, "public"), resolve(root, "web/.svelte-kit/output/client")]) {
      const path = resolve(base, url.pathname.slice(1));
      if (path.startsWith(base + sep) && existsSync(path) && /\.(css|js|woff2)$/.test(path)) {
        return route.fulfill({
          body: readFileSync(path),
          contentType: path.endsWith(".css")
            ? "text/css"
            : path.endsWith(".js")
              ? "text/javascript"
              : "font/woff2",
        });
      }
    }
    return route.fulfill({ status: 404, body: "Outside the fixture" });
  });
  return { documents, unexpected };
}
async function enter(page: Page) {
  await page.goto(`${origin}/admin/featured${search}`);
  await page.getByRole("link", { name: slot.title, exact: true }).click();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(slot.title);
}
async function keyboardActivate(page: Page, control: Locator) {
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    if (await control.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
  }
  throw new Error("The return anchor is not reachable with Tab/Enter");
}
for (const renderer of ["Hono", "Kit"] as Renderer[]) {
  for (const width of [390, 1280])
    for (const label of ["Back to these featured results", "Cancel"]) {
      test(`${renderer} ${width}px no-JS: ${label} returns by keyboard to the same page two`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          viewport: { width, height: width === 390 ? 844 : 800 },
          serviceWorkers: "block",
        });
        try {
          const journal = await mount(context, renderer);
          const page = await context.newPage();
          await enter(page);
          const anchor = page.getByRole("link", { name: label, exact: true });
          await keyboardActivate(page, anchor);
          await expect(page).toHaveURL(/\/admin\/featured\?/);
          expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
            q: query,
            published: "0",
            sort: "updated_at",
            order: "desc",
            page: "2",
          });
          await expect(page.getByLabel("Search titles")).toHaveValue(query);
          await expect(page.getByRole("link", { name: slot.title, exact: true })).toBeVisible();
          expect(journal.documents).toHaveLength(3);
          expect(journal.unexpected).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }

  test(`CONTROL: ${renderer} Cancel still protects the unsaved draft with the real island`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    try {
      const journal = await mount(context, renderer);
      const page = await context.newPage();
      await enter(page);
      await page.getByLabel("Headline", { exact: true }).fill("Keep my unsaved draft");
      const dialog = page.waitForEvent("dialog");
      const navigation = page.getByRole("link", { name: "Cancel", exact: true }).click();
      const departure = await dialog;
      expect(departure.type()).toBe("beforeunload");
      await departure.dismiss();
      await navigation;
      await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
        "Keep my unsaved draft",
      );
      expect(new URL(page.url()).pathname).toBe("/admin/featured/7");
      expect(journal.unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // The no-JS deletion-review round trip lives in
  // e2e/featured-inventory-return-review.spec.ts on the companion
  // acceptance history. It requires the separately owned native
  // deletion-review disclosure, which is not part of this
  // inventory-return change; the two histories combine once that
  // contract lands.
}
