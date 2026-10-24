// Fixture-only native navigation. No QA identity, network or database is used.
// The same spec is discovered by the ordinary browser-smoke runner in CI.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compileInventoryKit,
  inventoryRow,
  origin,
  renderInventory,
  type Inventory,
  type Renderer,
} from "../test/helpers/admin-inventory-recovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let kitStyles: string[];
test.beforeAll(async () => {
  await compileInventoryKit();
  // Root-layout CSS from the actual Kit build, not a test-owned style substitute.
  const node = await import(
    pathToFileURL(resolve(root, "web/.svelte-kit/output/server/nodes/0.js")).href
  );
  kitStyles = node.stylesheets;
});

async function mount(
  context: BrowserContext,
  renderer: Renderer,
  inventory: Inventory,
  initial: string,
) {
  const gets: URL[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === `/admin/${inventory}`) {
      gets.push(url);
      // Initial state is empty; every recovery URL must leave that state through
      // a genuine document GET before the fixture returns a populated result.
      const rows = url.search === initial ? [] : [inventoryRow(inventory)];
      const result = await renderInventory(renderer, inventory, url.search, rows);
      const html =
        renderer === "Kit"
          ? `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">${kitStyles.map((href) => `<link rel="stylesheet" href="/${href}">`).join("")}</head><body>${result.html}</body></html>`
          : result.html;
      return route.fulfill({ status: result.status, contentType: "text/html", body: html });
    }
    for (const assetRoot of [
      resolve(root, "public"),
      resolve(root, "web/.svelte-kit/output/client"),
    ]) {
      const path = resolve(assetRoot, url.pathname.slice(1));
      if (path.startsWith(assetRoot + sep) && existsSync(path) && /\.(css|js)$/.test(path)) {
        return route.fulfill({
          contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
          body: readFileSync(path),
        });
      }
    }
    return route.fulfill({ status: 404, body: "Outside the read-only inventory fixture" });
  });
  return { gets, unexpected };
}

async function activateByKeyboard(page: Page, control: Locator) {
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // Reach the real anchor by Tab, rather than programmatically focusing/clicking.
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press("Tab");
    if (await control.evaluate((element) => element === document.activeElement)) {
      const focused = await control.boundingBox();
      expect(focused!.x).toBeGreaterThanOrEqual(0);
      expect(focused!.x + focused!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      const previousUrl = page.url();
      await Promise.all([
        page.waitForURL((url) => url.href !== previousUrl),
        page.keyboard.press("Enter"),
      ]);
      return;
    }
  }
  throw new Error("Native inventory navigation was not reachable using Tab");
}

for (const renderer of ["Hono", "Kit"] as Renderer[]) {
  for (const inventory of ["events", "featured"] as Inventory[]) {
    for (const javaScriptEnabled of [false, true]) {
      for (const width of [390, 1280]) {
        const suffix = `${renderer} ${inventory}, JS=${javaScriptEnabled}, ${width}px`;
        for (const recovery of ["Clear filters", "First page of these results"] as const) {
          test(`${suffix}: ${recovery} is visible and keyboard navigable`, async ({ browser }) => {
            const context = await browser.newContext({
              javaScriptEnabled,
              viewport: { width, height: 844 },
              serviceWorkers: "block",
            });
            try {
              const initial =
                inventory === "events"
                  ? "?q=Caf%C3%A9+%26+%22games%22&status=published&series=child&fill=has_seats&rsvp_open=0&sort=title&order=asc&page=87"
                  : "?q=Caf%C3%A9+%26+%22games%22&published=0&sort=updated_at&order=desc&page=87";
              const journal = await mount(context, renderer, inventory, initial);
              const page = await context.newPage();
              await page.goto(`${origin}/admin/${inventory}${initial}`);
              await activateByKeyboard(
                page,
                page.getByRole("link", { name: new RegExp(`^${recovery}(?:$|\\s)`) }),
              );
              await expect(page.getByText("Inventory fixture 1", { exact: true })).toBeVisible();
              const destination = new URL(page.url());
              expect(destination.origin).toBe(origin);
              expect(destination.pathname).toBe(`/admin/${inventory}`);
              expect(Number(destination.searchParams.get("page") ?? "1")).toBe(1);
              destination.searchParams.delete("page");
              const sort =
                inventory === "events"
                  ? { sort: "title", order: "asc" }
                  : { sort: "updated_at", order: "desc" };
              const filters =
                inventory === "events"
                  ? {
                      q: 'Café & "games"',
                      status: "published",
                      series: "child",
                      fill: "has_seats",
                      rsvp_open: "0",
                    }
                  : { q: 'Café & "games"', published: "0" };
              expect(Object.fromEntries(destination.searchParams)).toEqual(
                recovery === "Clear filters" ? sort : { ...filters, ...sort },
              );
              expect(journal.gets).toHaveLength(2);
              expect(journal.unexpected).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      }
    }
    test(`CONTROL: ${renderer} ${inventory} Previous still works by keyboard without JavaScript`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 390, height: 844 },
      });
      try {
        const journal = await mount(context, renderer, inventory, "?q=missing&page=3");
        const page = await context.newPage();
        await page.goto(`${origin}/admin/${inventory}?q=missing&page=3`);
        await activateByKeyboard(page, page.getByRole("link", { name: "Previous", exact: true }));
        await expect(page.getByText("Inventory fixture 1", { exact: true })).toBeVisible();
        const destination = new URL(page.url());
        expect(destination.searchParams.get("q")).toBe("missing");
        expect(destination.searchParams.get("page")).toBe("2");
        expect(journal.gets).toHaveLength(2);
        expect(journal.unexpected).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
