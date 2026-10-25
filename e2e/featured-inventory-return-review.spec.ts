// Local fixtures, real rendered pages and shipped dirty-navigation controller.
// Discovered by browser-smoke; focused config also works without a dev server.
// Companion acceptance history: this round trip requires the separately
// owned native deletion-review disclosure. It is deliberately RED until
// that contract lands; do not merge this file ahead of it.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  origin,
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

for (const renderer of ["Hono", "Kit"] as Renderer[]) {
  test(`${renderer} no-JS: deletion review is a native saved-slot review, not a navigation or mutation`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    try {
      const journal = await mount(context, renderer);
      const page = await context.newPage();
      await enter(page);
      const review = page.locator("details").filter({ has: page.getByTestId("delete-featured") });
      await expect(
        review,
        "deletion retains the separately owned explicit review boundary",
      ).toHaveCount(1);
      await expect(review).not.toHaveAttribute("open");
      await review.locator("summary").click();
      await expect(page.getByTestId("delete-featured")).toBeVisible();
      await expect(review).toContainText(slot.title);
      await review.locator("summary").click();
      await expect(page.getByTestId("delete-featured")).not.toBeVisible();
      expect(journal.documents).toHaveLength(2);
      expect(journal.unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
