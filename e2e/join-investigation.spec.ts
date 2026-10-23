// Test Author owned. Real SSR/loads + Chromium, native navigation with JS off.
// All requests intercepted; no server, database, staging or external network.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  compileInvestigationKit,
  investigationDocument,
  listPath,
  listState,
  recorded,
  root,
  twins,
  type Twin,
} from "../test/helpers/join-investigation";

let kit: Awaited<ReturnType<typeof compileInvestigationKit>>;
let rootCss: { build: (candidates: string[]) => string };
const origin = "http://127.0.0.1:18785";
const from = `${listPath}?outcome=error&q=request%3Afixture-7&page=2`;
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });
test.beforeAll(async () => {
  kit = await compileInvestigationKit();
  rootCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});
test.afterAll(() => kit?.dispose());

async function mount(
  context: BrowserContext,
  twin: Twin,
  state: "records" | "empty" | "incomplete",
) {
  const documents: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") return route.abort("blockedbyclient");
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
    if (url.pathname !== listPath && url.pathname !== `${listPath}/7`)
      return route.abort("blockedbyclient");
    const rows =
      state === "empty"
        ? []
        : state === "incomplete"
          ? [{ ...recorded, source: null, requestId: null, discordId: null }]
          : [recorded];
    const result = await investigationDocument(kit, twin, url.pathname + url.search, rows);
    documents.push(url.pathname + url.search);
    const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    const html =
      twin === "Kit"
        ? result.html.replace("</head>", `<style>${rootCss.build(candidates)}</style></head>`)
        : result.html;
    return route.fulfill({
      status: result.status,
      headers: result.headers,
      contentType: "text/html",
      body: html,
    });
  });
  return documents;
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement)) return;
  }
  throw new Error(`Native keyboard navigation did not reach ${await target.textContent()}`);
}
async function follow(page: Page, target: Locator) {
  const destination = new URL((await target.getAttribute("href"))!, page.url()).href;
  await tabTo(page, target);
  await Promise.all([page.waitForURL(destination), page.keyboard.press("Enter")]);
}
async function screenshot(page: Page, name: string) {
  if (!process.env.JOIN_INVESTIGATION_SCREENSHOT_DIR) return;
  mkdirSync(process.env.JOIN_INVESTIGATION_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(process.env.JOIN_INVESTIGATION_SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

for (const twin of twins) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const name = `${twin}-${viewport.width}`;
    test(`JIB-01 ${name}: filtered page 2 → detail → refresh/new tab → same results by keyboard without JS`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport,
        serviceWorkers: "block",
      });
      try {
        const requests = await mount(context, twin, "records");
        const page = await context.newPage();
        await page.goto(origin + from);
        const entry = page.getByRole("link", { name: "View join attempt 7: error", exact: true });
        await expect(entry).toBeVisible();
        const href = (await entry.getAttribute("href"))!;
        await screenshot(page, `${name}-list-before`);
        await follow(page, entry);
        await expect(
          page.getByRole("heading", { name: "Join attempt 7", exact: true }),
        ).toBeVisible();
        await page.reload();
        // A new tab starts at the emitted detail URL, not a Referer/history shortcut.
        const tab = await context.newPage();
        await tab.goto(origin + href);
        const back = tab.getByRole("link", {
          name: /back to join attempts|back to results|return to results/i,
        });
        await expect(back).toBeVisible();
        await follow(tab, back);
        expect(listState(new URL(tab.url()).pathname + new URL(tab.url()).search)).toEqual({
          origin: "https://example.test",
          path: listPath,
          outcome: "error",
          q: "request:fixture-7",
          page: "2",
        });
        expect(requests.filter((p) => p.startsWith(`${listPath}/7`))).toHaveLength(3);
        await expect(tab.getByRole("searchbox", { name: "Discord id or request id" })).toHaveValue(
          "request:fixture-7",
        );
      } finally {
        await context.close();
      }
    });

    test(`JIB-02 ${name}: empty later page offers native First page and Clear filters`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport,
        serviceWorkers: "block",
      });
      try {
        await mount(context, twin, "empty");
        const page = await context.newPage();
        await page.goto(origin + from);
        await screenshot(page, `${name}-empty-before`);
        const first = page.getByRole("link", { name: /first page/i });
        const clear = page.getByRole("link", { name: /clear filters/i });
        await expect(first).toBeVisible();
        await expect(clear).toBeVisible();
        await follow(page, first);
        expect(new URL(page.url()).searchParams.get("q")).toBe("request:fixture-7");
        expect(new URL(page.url()).searchParams.get("page") ?? "1").toBe("1");
        await follow(page, clear);
        expect(new URL(page.url()).searchParams.get("q") ?? "").toBe("");
        expect(new URL(page.url()).searchParams.get("outcome") ?? "").toBe("");
        await expect(page.getByTestId("join-attempts-empty")).toContainText(/90|retention|window/i);
      } finally {
        await context.close();
      }
    });

    test(`JIB-03 ${name}: direct incomplete detail keeps a native unfiltered fallback and no write controls`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport,
        serviceWorkers: "block",
      });
      try {
        await mount(context, twin, "incomplete");
        const page = await context.newPage();
        const response = await page.goto(origin + `${listPath}/7`);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["cache-control"]).toBe("private, no-store");
        await screenshot(page, `${name}-detail-before`);
        await expect(page.locator("main form,main button,main input,a[download]")).toHaveCount(0);
        const back = page.getByRole("link", {
          name: /back to join attempts|back to results|return to results/i,
        });
        await expect(back).toHaveAttribute("href", listPath);
        await follow(page, back);
        expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(listPath);
      } finally {
        await context.close();
      }
    });
  }
}
