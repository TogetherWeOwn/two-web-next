// Fixture-only acceptance: real Hono routes and compiled Kit loader/page, no live traffic.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compileInventoryKit,
  inventoryDb,
  origin,
  renderInventory,
} from "../test/helpers/admin-inventory-recovery";
import {
  inventoryRow,
  loadKitInventory,
  INVENTORY_TWINS,
  type InventoryTwin,
} from "../test/helpers/featured-inventory-acceptance";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let styles: string[];
let renderKitHead: (data: Record<string, unknown>) => string;
test.beforeAll(async () => {
  await compileInventoryKit();
  // The shared semantic harness deliberately returns body only. Execute the
  // real leaf again for its head so browser evidence includes AdminShell's
  // stylesheet links/islands rather than a test-authored imitation of them.
  const { compile } = createRequire(resolve(root, "web/package.json"))("svelte/compiler");
  const bundled = await build({
    stdin: {
      contents: `import {render} from 'svelte/server';
        import Page from './web/src/routes/admin/featured/+page.svelte';
        export const head = data => render(Page, {props:{data}}).head;`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: {},
    logLevel: "silent",
    nodePaths: [resolve(root, "web/node_modules"), resolve(root, "node_modules")],
    alias: { "#lib": resolve(root, "web/src/lib"), $lib: resolve(root, "web/src/lib") },
    plugins: [
      {
        name: "inventory-browser-real-head",
        setup(builder) {
          builder.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), { filename: path, generate: "server" }).js
              .code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  renderKitHead = (
    await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`
    )
  ).head;
  const node = await import(
    pathToFileURL(resolve(root, "web/.svelte-kit/output/server/nodes/0.js")).href
  );
  styles = node.stylesheets;
});

async function mount(context: BrowserContext, twin: InventoryTwin, scene: string) {
  const gets: URL[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/admin/featured") {
      gets.push(url);
      const rows =
        scene === "empty"
          ? []
          : [
              inventoryRow(),
              ...(scene === "unavailable"
                ? [
                    inventoryRow({
                      id: 902,
                      title: "Inspect undecodable slot",
                      startsAt: new Date(Number.NaN),
                      startsAtText: "infinity",
                    }),
                  ]
                : []),
            ];
      let result: { html: string; status: number };
      let kitHead = "";
      try {
        if (twin === "Kit") {
          const loaded = await loadKitInventory(url.search, inventoryDb("featured", rows).db);
          kitHead = renderKitHead(loaded.data);
          result = { html: loaded.html, status: 200 };
        } else {
          result = await renderInventory(twin, "featured", url.search, rows);
        }
      } catch (error) {
        // Explicit failed fixture response, never an invented successful empty list.
        return route.fulfill({
          status: 500,
          contentType: "text/plain",
          body: `FI-RENDER-REJECTED: ${error instanceof Error ? error.name : "unknown"}`,
        });
      }
      const body =
        twin === "Kit"
          ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((href) => `<link rel="stylesheet" href="/${href}">`).join("")}${kitHead}</head><body>${result.html}</body></html>`
          : result.html;
      return route.fulfill({ status: result.status, contentType: "text/html", body });
    }
    for (const assetRoot of [
      resolve(root, "public"),
      resolve(root, "web/.svelte-kit/output/client"),
    ]) {
      const filename = resolve(assetRoot, url.pathname.slice(1));
      if (
        filename.startsWith(assetRoot + sep) &&
        existsSync(filename) &&
        /\.(?:css|js|woff2?|svg|png)$/.test(filename)
      ) {
        const contentType = filename.endsWith(".css")
          ? "text/css"
          : filename.endsWith(".js")
            ? "text/javascript"
            : filename.endsWith(".svg")
              ? "image/svg+xml"
              : filename.endsWith(".png")
                ? "image/png"
                : "font/woff2";
        return route.fulfill({ contentType, body: readFileSync(filename) });
      }
    }
    return route.fulfill({ status: 404, body: "Outside the read-only inventory fixture" });
  });
  return { gets, unexpected };
}

async function keyboardActivate(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  for (let index = 0; index < 70; index++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) {
      const previousUrl = page.url();
      await Promise.all([
        page.waitForURL((url) => url.href !== previousUrl),
        page.keyboard.press("Enter"),
      ]);
      return;
    }
  }
  throw new Error(
    "FI-KEYBOARD: native control was not reachable using Tab; restore keyboard access",
  );
}

for (const twin of INVENTORY_TWINS) {
  for (const width of [1280, 390]) {
    for (const scene of ["normal", "empty", "unavailable"]) {
      for (const javaScriptEnabled of scene === "normal" ? [false, true] : [false]) {
        test(`FI-B-${twin}-${width}-${scene}-JS${javaScriptEnabled}: native inventory contract`, async ({
          browser,
        }, info) => {
          const context = await browser.newContext({
            javaScriptEnabled,
            viewport: { width, height: width === 1280 ? 800 : 844 },
            serviceWorkers: "block",
          });
          try {
            const journal = await mount(context, twin, scene);
            const page = await context.newPage();
            const initial =
              scene === "empty"
                ? "?state=unavailable&sort=updated_at&order=desc"
                : "?published=1&q=Night&sort=updated_at&order=desc&page=2";
            const response = await page.goto(`${origin}/admin/featured${initial}`);
            const image = info.outputPath(`${twin}-${width}-${scene}.png`);
            await page.screenshot({ path: image, fullPage: true });
            await info.attach("real baseline inventory", { path: image, contentType: "image/png" });
            expect(
              response?.status(),
              "FI-ROW-LOSS: saved bad bounds must not replace inventory with an outage",
            ).toBe(200);
            if (scene === "normal") {
              const facet = page.getByRole("combobox", { name: /effective|eligib|state|status/i });
              await expect(
                facet,
                "FI-FACET-MISSING: add the labelled native state selector",
              ).toHaveCount(1);
              await facet.selectOption("scheduled");
              await page.getByRole("searchbox", { name: "Search titles" }).fill("Night & day");
              await keyboardActivate(
                page,
                page.getByRole("button", { name: "Filter", exact: true }),
              );
              const destination = new URL(page.url());
              expect(Object.fromEntries(destination.searchParams)).toEqual({
                state: "scheduled",
                q: "Night & day",
                published: "1",
                sort: "updated_at",
                order: "desc",
              });
              expect(journal.gets).toHaveLength(2);
            } else if (scene === "empty") {
              await expect(page.getByTestId("featured-empty")).toContainText(
                /matches these filters/i,
              );
              await keyboardActivate(
                page,
                page.getByRole("link", { name: "Clear filters", exact: true }),
              );
              expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
                sort: "updated_at",
                order: "desc",
              });
            } else {
              await expect(
                page.getByRole("link", { name: "Healthy inventory sibling", exact: true }),
              ).toBeVisible();
              await expect(
                page.getByRole("link", { name: "Inspect undecodable slot", exact: true }),
              ).toHaveAttribute("href", "/admin/featured/902");
              await expect(page.getByTestId("featured-status-902")).toContainText(/unavailable/i);
              expect(
                await page
                  .locator('time[datetime="infinity"], time[datetime="Invalid Date"]')
                  .count(),
              ).toBe(0);
            }
            expect(journal.unexpected).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
    test(`FI-B-CONTROL-${twin}-${width}: existing Clear is keyboard reachable without JavaScript`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width, height: width === 1280 ? 800 : 844 },
      });
      try {
        const journal = await mount(context, twin, "empty");
        const page = await context.newPage();
        await page.goto(
          `${origin}/admin/featured?q=missing&published=1&sort=updated_at&order=desc&page=2`,
        );
        await keyboardActivate(
          page,
          page.getByRole("link", { name: "Clear filters", exact: true }),
        );
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
          sort: "updated_at",
          order: "desc",
        });
        expect(journal.gets).toHaveLength(2);
        expect(journal.unexpected).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
