// Independent focus regression for join investigation links.
// Real SSR/loads + Chromium, native Tab with JS off, actual stylesheets.
// All requests intercepted; no server, database, staging or external network.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  compileInvestigationKit,
  investigationDocument,
  listPath,
  recorded,
  root,
  twins,
  type Twin,
} from "../test/helpers/join-investigation";

let kit: Awaited<ReturnType<typeof compileInvestigationKit>>;
let kitCss: { build: (candidates: string[]) => string };
const origin = "http://127.0.0.1:18786";
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });
test.beforeAll(async () => {
  kit = await compileInvestigationKit();
  kitCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});
test.afterAll(() => kit?.dispose());

type FocusState = "filtered-empty" | "incomplete-list";

async function serve(context: BrowserContext, twin: Twin, state: FocusState) {
  const externals: string[] = [];
  const served: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      externals.push(request.url());
      return route.abort("blockedbyclient");
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      (url.pathname.endsWith(".css") || url.pathname.endsWith(".woff2")) &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset)
    ) {
      return route.fulfill({
        contentType: url.pathname.endsWith(".css") ? "text/css" : "font/woff2",
        body: readFileSync(asset),
      });
    }
    if (!url.pathname.startsWith(listPath)) {
      externals.push(request.url());
      return route.abort("blockedbyclient");
    }
    const rows =
      state === "filtered-empty"
        ? []
        : [{ ...recorded, source: null, requestId: null, discordId: null }];
    const result = await investigationDocument(kit, twin, url.pathname + url.search, rows);
    served.push(url.pathname + url.search);
    const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    const html =
      twin === "Kit"
        ? result.html.replace("</head>", `<style>${kitCss.build(candidates)}</style></head>`)
        : result.html;
    return route.fulfill({
      status: result.status,
      headers: result.headers,
      contentType: "text/html",
      body: html,
    });
  });
  return { externals, served };
}

async function tabUntilFocused(page: Page, target: Locator) {
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === el.ownerDocument.activeElement)) return;
  }
  throw new Error(`Keyboard Tab did not reach ${await target.textContent()}`);
}

for (const twin of twins) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const state of ["filtered-empty", "incomplete-list"] as const) {
      const label = `${twin}-${viewport.width}-${state}`;
      test(`JIF-01 ${label}: join links keep a visible 3px current-color focus ring by keyboard without JS`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          viewport,
          serviceWorkers: "block",
        });
        try {
          const { externals, served } = await serve(context, twin, state);
          const page = await context.newPage();
          const path =
            state === "filtered-empty" ? `${listPath}?outcome=error&q=exact-missing` : listPath;
          const response = await page.goto(origin + path);
          expect(response?.status()).toBe(200);
          const target =
            state === "filtered-empty"
              ? page.getByRole("link", { name: /clear filters/i })
              : page.getByRole("link", { name: /view join attempt/i }).first();
          await expect(target).toBeVisible();
          const href = await target.getAttribute("href");
          expect(href).toMatch(/^\/admin\/join-attempts/);
          await tabUntilFocused(page, target);
          const styles = await target.evaluate((el) => {
            const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
            return {
              outlineWidth: computed.outlineWidth,
              outlineStyle: computed.outlineStyle,
              outlineColor: computed.outlineColor,
              color: computed.color,
            };
          });
          expect(styles.outlineWidth).toBe("3px");
          expect(styles.outlineStyle).toBe("solid");
          expect(styles.outlineColor).toBe(styles.color);
          expect(styles.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
          expect(served.length).toBeGreaterThanOrEqual(1);
          expect(externals).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
}
