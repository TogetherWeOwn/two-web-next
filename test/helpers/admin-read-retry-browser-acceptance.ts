// Registered inside the existing Kit Chromium gate: no new skip or CI change.
// Route interception serves real boundary SSR, not fabricated recovery markup.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { Browser } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_RETRY_ORIGIN,
  type AdminBoundary,
  type AdminRetryKit,
  compileAdminRetryKit,
  retryPage,
} from "./admin-read-retry-acceptance";

export function registerAdminReadRetryBrowserAcceptance(getBrowser: () => Browser): void {
  describe("admin failed-read retry: native keyboard/no-JS recovery", () => {
    let kit: AdminRetryKit;
    let styles: string;
    beforeAll(async () => {
      kit = await compileAdminRetryKit();
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const webRequire = createRequire(join(root, "web/package.json"));
      const { compile } = webRequire("@tailwindcss/node");
      const candidates = new Set<string>();
      for (const boundary of ["admin", "join-attempts"] as const) {
        for (const status of [404, 503, 500]) {
          const path =
            boundary === "admin" ? "/admin/events?page=2" : "/admin/join-attempts?page=2";
          const { head, body } = kit.render(boundary, retryPage(status, path, path.split("?")[0]!));
          for (const match of `${head}${body}`.matchAll(/class="([^"]+)"/g)) {
            for (const token of match[1]!.split(/\s+/)) candidates.add(token);
          }
        }
      }
      const compiler = await compile(readFileSync(join(root, "web/src/app.css"), "utf8"), {
        base: join(root, "web/src"),
        onDependency: () => {},
      });
      styles = ["public/styles.css", "public/theme.css"]
        .map((path) => readFileSync(join(root, path), "utf8"))
        .join("\n");
      styles += `\n${compiler.build([...candidates])}\n${kit.css}`;
      expect(styles).not.toContain("</style");
    });

    for (const boundary of ["admin", "join-attempts"] as AdminBoundary[]) {
      for (const width of [1280, 390]) {
        for (const status of [503, 500, 404]) {
          it(`${boundary} ${status} at ${width}px: keyboard/no-JS same-view GET, no automatic replay`, async () => {
            const listPath = boundary === "admin" ? "/admin/events" : "/admin/join-attempts";
            const path =
              status === 404
                ? `${listPath}/${boundary === "admin" ? "no-such-key" : "7"}?page=2`
                : `${listPath}?page=2&status=${boundary === "admin" ? "published" : "failed"}`;
            const routeId =
              status === 404 ? `${listPath}/${boundary === "admin" ? "[key]" : "[id]"}` : listPath;
            const context = await getBrowser().newContext({
              javaScriptEnabled: false,
              viewport: { width, height: width === 390 ? 844 : 800 },
              serviceWorkers: "block",
            });
            try {
              const requests: { url: string; method: string; postData: string | null }[] = [];
              await context.route("**/*", async (route) => {
                const request = route.request();
                const url = new URL(request.url());
                if (
                  url.origin !== ADMIN_RETRY_ORIGIN ||
                  ![path.split("?")[0], listPath].includes(url.pathname)
                ) {
                  return route.abort("blockedbyclient");
                }
                requests.push({
                  url: url.href,
                  method: request.method(),
                  postData: request.postData(),
                });
                const { head, body } = kit.render(boundary, retryPage(status, path, routeId));
                await route.fulfill({
                  status: requests.length === 1 ? status : 200,
                  contentType: "text/html; charset=utf-8",
                  body:
                    requests.length === 1
                      ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${styles}</style></head><body>${body}</body></html>`
                      : '<!doctype html><html lang="en"><head><title>Recovered read</title></head><body><h1>Recovered read</h1></body></html>',
                });
              });
              const page = await context.newPage();
              await page.goto(`${ADMIN_RETRY_ORIGIN}${path}`);
              expect(requests).toEqual([
                { url: `${ADMIN_RETRY_ORIGIN}${path}`, method: "GET", postData: null },
              ]);
              const screenshots = process.env.ADMIN_RETRY_SCREENSHOT_DIR;
              if (screenshots) {
                mkdirSync(screenshots, { recursive: true });
                await page.screenshot({
                  path: join(screenshots, `${boundary}-${status}-${width}.png`),
                  fullPage: true,
                });
              }
              const retry = page.getByRole("link", { name: /^Retry loading\b/i });
              expect(
                await retry.count(),
                "the failed GET needs a native Retry loading anchor, except on 404",
              ).toBe(status === 404 ? 0 : 1);
              // Existing 404 list exits calibrate the entire keyboard/GET harness
              // on unchanged code; only the new transient retry is RED.
              const recovery =
                status === 404
                  ? page.getByRole("link", {
                      name: boundary === "admin" ? "Back to events" : "Back to join attempts",
                      exact: true,
                    })
                  : retry;
              const expectedHref = status === 404 ? listPath : path;
              expect(await recovery.isVisible()).toBe(true);
              expect(await recovery.getAttribute("href")).toBe(expectedHref);
              expect(
                await page.locator("body").evaluate((element) => element.scrollWidth),
              ).toBeLessThanOrEqual(width);
              const box = await recovery.boundingBox();
              expect(box?.width).toBeGreaterThan(0);
              expect(box!.x).toBeGreaterThanOrEqual(0);
              expect(box!.x + box!.width).toBeLessThanOrEqual(width);
              let keyboardReachedRecovery = false;
              for (let tab = 0; tab < 25; tab += 1) {
                await page.keyboard.press("Tab");
                keyboardReachedRecovery = await recovery.evaluate(
                  (element) => element === element.ownerDocument.activeElement,
                );
                if (keyboardReachedRecovery) break;
              }
              expect(
                keyboardReachedRecovery,
                "the recovery link participates in native keyboard focus order",
              ).toBe(true);
              await Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.url() === `${ADMIN_RETRY_ORIGIN}${expectedHref}` &&
                    response.request().isNavigationRequest(),
                ),
                page.keyboard.press("Enter"),
              ]);
              await page
                .getByRole("heading", { name: "Recovered read" })
                .waitFor({ state: "visible" });
              expect(page.url()).toBe(`${ADMIN_RETRY_ORIGIN}${expectedHref}`);
              expect(requests).toEqual([
                { url: `${ADMIN_RETRY_ORIGIN}${path}`, method: "GET", postData: null },
                { url: `${ADMIN_RETRY_ORIGIN}${expectedHref}`, method: "GET", postData: null },
              ]);
            } finally {
              await context.close();
            }
          });
        }
      }
    }
  });
}
