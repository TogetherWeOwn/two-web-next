import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, describe, test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import app from "../app";
import { FAQS } from "../../src/faq-content";
import { transformContentLeafChunk } from "../../src/kit-content-chunk";
import { buildKitFaqBundle, FAQ_ORIGIN, loadKitFaq } from "./faq-twins";

// Registered in the existing unconditional Chromium CI entrypoint. Actual
// route/SSR bytes, real native GET navigation, no JS, DB or external services.
export function registerFaqSearchBrowserAcceptance(getBrowser: () => Browser): void {
  describe("FAQ keyword native browser acceptance", () => {
    let kit: Awaited<ReturnType<typeof buildKitFaqBundle>>;
    const root = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));
    const evidence = process.env.FAQ_SEARCH_EVIDENCE_DIR;
    const fullCount = FAQS.reduce((count, group) => count + group.items.length, 0);
    before(async () => {
      kit = await buildKitFaqBundle();
      if (evidence) mkdirSync(evidence, { recursive: true });
    });
    async function capture(page: Page, name: string) {
      if (evidence)
        await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: false });
    }
    for (const twin of ["Hono", "Kit"] as const)
      for (const width of [1280, 390]) {
        async function open(path: string) {
          const context = await getBrowser().newContext({
            javaScriptEnabled: false,
            viewport: { width, height: width === 390 ? 844 : 800 },
            serviceWorkers: "block",
          });
          const external: string[] = [];
          const documents: string[] = [];
          await context.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== FAQ_ORIGIN) {
              external.push(url.origin);
              return route.abort("blockedbyclient");
            }
            if (url.pathname === "/faq") {
              assert.equal(request.method(), "GET");
              assert.equal(request.resourceType(), "document");
              documents.push(url.href);
              if (twin === "Kit") {
                const { html, headers } = await loadKitFaq(kit, url.href);
                const body = transformContentLeafChunk(html).replace(
                  "</head>",
                  `<style>${kit.css}</style></head>`,
                );
                return route.fulfill({
                  status: 200,
                  headers: {
                    ...Object.fromEntries(headers),
                    "content-type": "text/html; charset=utf-8",
                  },
                  body,
                });
              }
              const response = await app.request(url.href, {}, { APP_URL: FAQ_ORIGIN });
              return route.fulfill({
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: await response.text(),
              });
            }
            const file = resolve(root, `.${url.pathname}`);
            if (!file.startsWith(`${root}/`) || !existsSync(file))
              return route.fulfill({ status: 404, body: "" });
            const contentType = file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".svg")
                ? "image/svg+xml"
                : file.endsWith(".woff2")
                  ? "font/woff2"
                  : "application/octet-stream";
            return route.fulfill({ contentType, body: readFileSync(file) });
          });
          const page = await context.newPage();
          await page.goto(new URL(path, FAQ_ORIGIN).href);
          return { context, page, external, documents };
        }
        const label = `${twin.toLowerCase()}-${width}`;
        test(`${label}: CONTROL full FAQ renders offline without scripts`, async () => {
          const { context, page, external } = await open("/faq");
          try {
            assert.equal(
              await page
                .getByRole("heading", { level: 1, name: "Frequently asked questions" })
                .count(),
              1,
            );
            assert.equal(await page.locator('[data-testid="faq-list"] h3').count(), fullCount);
            assert.equal(await page.locator("script, [data-island]").count(), 0);
            assert.deepEqual(external, []);
            assert.ok(
              await page.getByRole("link", { name: "Join with Discord", exact: true }).count(),
            );
            assert.equal(
              await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
              true,
            );
            await capture(page, `${label}-full-before`);
          } finally {
            await context.close();
          }
        });
        test(`${label}: keyboard GET search, reload and clear work with JavaScript disabled`, async () => {
          const { context, page, external, documents } = await open("/faq");
          try {
            const input = page
              .getByRole("textbox", { name: "Find an answer", exact: true })
              .or(page.getByRole("searchbox", { name: "Find an answer", exact: true }));
            assert.equal(await input.count(), 1, "Missing natively labelled Find an answer input");
            const form = page.locator("form").filter({ has: input });
            assert.equal((await form.getAttribute("method"))?.toLowerCase(), "get");
            assert.equal(await form.getAttribute("action"), "/faq");
            assert.equal(await input.getAttribute("name"), "q");
            await input.focus();
            assert.equal(await input.evaluate((element) => element.matches(":focus")), true);
            await page.keyboard.type("  ELIGIBILITY  ");
            await page.keyboard.press("Tab");
            assert.equal(
              await form.getByRole("button").evaluate((element) => element.matches(":focus")),
              true,
            );
            await Promise.all([
              page.waitForURL((url) => url.searchParams.has("q")),
              page.keyboard.press("Enter"),
            ]);
            assert.deepEqual(await page.locator('[data-testid="faq-list"] h3').allTextContents(), [
              "Do I need an invite, referral, or eligibility check?",
            ]);
            assert.equal(await input.inputValue(), "ELIGIBILITY");
            assert.match(
              await page.getByRole("status").innerText(),
              /\b1\s+(?:matching\s+)?answer\b/i,
            );
            assert.equal(
              await page.locator('link[rel="canonical"]').getAttribute("href"),
              `${FAQ_ORIGIN}/faq`,
            );
            assert.equal(
              await page
                .locator('link[rel="alternate"][type="text/markdown"]')
                .getAttribute("href"),
              "/faq.md",
            );
            await capture(page, `${label}-filtered-after`);
            const copied = page.url();
            await page.reload();
            assert.equal(page.url(), copied);
            assert.equal(await page.locator('[data-testid="faq-list"] h3').count(), 1);
            await page.getByRole("link", { name: "Show all answers", exact: true }).click();
            assert.equal(new URL(page.url()).searchParams.has("q"), false);
            assert.equal(await page.locator('[data-testid="faq-list"] h3').count(), fullCount);
            assert.equal(await page.locator("script, [data-island]").count(), 0);
            assert.equal(
              await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
              true,
            );
            assert.deepEqual(external, []);
            assert.ok(documents.length >= 4);
          } finally {
            await context.close();
          }
        });
        test(`${label}: no-match state has native clear recovery and truthful support`, async () => {
          const { context, page } = await open("/faq?q=zz-no-such-answer");
          try {
            await capture(page, `${label}-empty-before`);
            assert.equal(await page.locator('[data-testid="faq-list"] h3').count(), 0);
            assert.match(
              await page.getByRole("status").innerText(),
              /\b0\s+(?:matching\s+)?answers\b/i,
            );
            assert.match(
              await page.locator("main").innerText(),
              /ask in general or DM a moderator/i,
            );
            await page.getByRole("link", { name: "Show all answers", exact: true }).click();
            assert.equal(await page.locator('[data-testid="faq-list"] h3').count(), fullCount);
          } finally {
            await context.close();
          }
        });
      }
  });
}
