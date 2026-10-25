// Registered inside the existing browser-only CI gate; no new opt-in or skip.
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { compileAdminRetryKit, retryPage, type AdminRetryKit } from "./admin-read-retry-acceptance";
import {
  activityRecovery,
  activityRow,
  honoRecovery,
  recoveryDb,
  recoveryEvent,
  recoveryOrigin,
  refusedEvent,
} from "./admin-safe-recovery-acceptance";

export function registerAdminSafeRecoveryBrowserAcceptance(
  getBrowser: () => Browser,
  getCss: () => string,
) {
  let kit: AdminRetryKit;
  let servedCss: string;
  beforeAll(async () => {
    kit = await compileAdminRetryKit();
    servedCss = getCss();
  });
  async function capture(page: Page, name: string) {
    const directory = process.env.ADMIN_RECOVERY_EVIDENCE_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: resolve(directory, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  async function tabTo(page: Page, locator: ReturnType<Page["getByRole"]>) {
    for (let i = 0; i < 32; i++) {
      await page.keyboard.press("Tab");
      if (await locator.evaluate((node) => node === node.ownerDocument.activeElement)) return;
    }
    throw new Error("Recovery action is not in the native tab order");
  }

  for (const width of [1280, 390]) {
    describe(`native no-JS recovery at ${width}px`, () => {
      for (const renderer of ["Hono", "Kit"] as const) {
        for (const state of ["empty", "filtered", "later", "populated", "outage"] as const) {
          it(`${renderer} ${state} exposes real rendered actions and activates only a GET`, async () => {
            const search =
              state === "later"
                ? "?page=9&subject=Event&causer=42"
                : state === "filtered"
                  ? "?subject=Event"
                  : "";
            const result = await activityRecovery(
              renderer,
              search,
              state === "populated" ? [activityRow] : [],
              state === "outage",
            );
            expect(result.status).toBe(state === "outage" ? 503 : 200);
            const html =
              renderer === "Kit" && state === "outage"
                ? `<style>${kit.css}</style>${kit.render("admin", retryPage(503, `/admin/activity-log${search}`, "/admin/activity-log")).body}`
                : result.html;
            const context = await getBrowser().newContext({
              javaScriptEnabled: false,
              viewport: { width, height: width === 390 ? 844 : 800 },
            });
            const page = await context.newPage();
            const journal: { method: string; url: string; body: string | null }[] = [];
            try {
              await page.route("**/*", async (route) => {
                const request = route.request();
                if (request.resourceType() === "stylesheet") {
                  const path = new URL(request.url()).pathname;
                  if (["/styles.css", "/admin-rsvp-review.css"].includes(path)) {
                    return route.fulfill({
                      contentType: "text/css",
                      body: await readFile(resolve("public", path.slice(1)), "utf8"),
                    });
                  }
                }
                if (request.isNavigationRequest()) {
                  journal.push({
                    method: request.method(),
                    url: request.url(),
                    body: request.postData(),
                  });
                  return route.fulfill({
                    status: result.status,
                    contentType: "text/html",
                    body:
                      renderer === "Hono"
                        ? html
                        : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${servedCss}</style></head><body>${html}</body></html>`,
                  });
                }
                return route.abort();
              });
              await page.goto(`${recoveryOrigin}/admin/activity-log${search}`);
              await capture(page, `${renderer}-${state}-${width}`);
              const actionName =
                state === "later"
                  ? "First page of these results"
                  : state === "filtered"
                    ? "Clear filters"
                    : state === "outage" && renderer === "Kit"
                      ? "Retry loading"
                      : null;
              if (!actionName) {
                if (state === "outage") {
                  expect(await page.locator("body").innerText()).toMatch(
                    /temporarily unavailable/i,
                  );
                  expect(await page.getByTestId("activity-log-empty").count()).toBe(0);
                } else {
                  expect(
                    await page.getByRole("button", { name: "Filter", exact: true }).count(),
                  ).toBe(1);
                }
                expect(journal).toHaveLength(1);
                return;
              }
              const action = page.getByRole("link", { name: actionName, exact: true });
              expect(await action.count()).toBe(1);
              const destination = new URL((await action.getAttribute("href"))!, recoveryOrigin);
              const box = await action.boundingBox();
              expect(box).not.toBeNull();
              expect(box!.x).toBeGreaterThanOrEqual(0);
              expect(box!.x + box!.width).toBeLessThanOrEqual(width);
              await tabTo(page, action);
              await Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.url() === destination.href && response.request().isNavigationRequest(),
                ),
                page.keyboard.press("Enter"),
              ]);
              expect(journal).toHaveLength(2);
              expect(journal[1]).toEqual({ method: "GET", url: destination.href, body: null });
            } finally {
              await context.close();
            }
          });
        }
      }

      it("a genuine Hono POST refusal returns by keyboard without retrying that mutation", async () => {
        const context = await getBrowser().newContext({
          javaScriptEnabled: false,
          viewport: { width, height: width === 390 ? 844 : 800 },
        });
        const page = await context.newPage();
        const methods: string[] = [];
        try {
          await page.route("**/*", async (route) => {
            const request = route.request();
            if (request.resourceType() === "stylesheet") {
              const path = new URL(request.url()).pathname;
              if (["/styles.css", "/admin-rsvp-review.css"].includes(path))
                return route.fulfill({
                  contentType: "text/css",
                  body: await readFile(resolve("public", path.slice(1)), "utf8"),
                });
            }
            if (!request.isNavigationRequest()) return route.abort();
            methods.push(request.method());
            if (request.method() === "POST") {
              const result = await honoRecovery(
                `/admin/events/${recoveryEvent}/publish`,
                recoveryDb([refusedEvent()]),
                "POST",
              );
              return route.fulfill({
                status: result.status,
                contentType: "text/html",
                body: result.html,
              });
            }
            return route.fulfill({
              contentType: "text/html",
              body: `<form method="post" action="/admin/events/${recoveryEvent}/publish"><button>Attempt publish</button></form>`,
            });
          });
          await page.goto(`${recoveryOrigin}/launcher`);
          await page.keyboard.press("Tab");
          await Promise.all([page.waitForURL(`**/publish`), page.keyboard.press("Enter")]);
          expect(methods).toEqual(["GET", "POST"]);
          await capture(page, `Hono-refusal-${width}`);
          const editor = page.locator(`main a[href="/admin/events/${recoveryEvent}"]`);
          expect(await editor.count()).toBe(1);
          expect((await editor.innerText()).trim().length).toBeGreaterThan(0);
          await tabTo(page, editor);
          await Promise.all([
            page.waitForURL(`${recoveryOrigin}/admin/events/${recoveryEvent}`),
            page.keyboard.press("Enter"),
          ]);
          expect(methods).toEqual(["GET", "POST", "GET"]);
        } finally {
          await context.close();
        }
      });

      for (const family of ["events", "featured"] as const) {
        it(`Kit missing ${family} keeps keyboard family recovery without a POST`, async () => {
          const rendered = kit.render(
            "admin",
            retryPage(
              404,
              `/admin/${family}/9`,
              `/admin/${family}/[${family === "events" ? "key" : "id"}]`,
            ),
          );
          const context = await getBrowser().newContext({
            javaScriptEnabled: false,
            viewport: { width, height: width === 390 ? 844 : 800 },
          });
          const page = await context.newPage();
          const methods: string[] = [];
          try {
            await page.route("**/*", async (route) => {
              if (!route.request().isNavigationRequest()) return route.abort();
              methods.push(route.request().method());
              return route.fulfill({
                status: 404,
                contentType: "text/html",
                body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${servedCss}
${kit.css}</style></head><body>${rendered.body}</body></html>`,
              });
            });
            await page.goto(`${recoveryOrigin}/admin/${family}/9`);
            await capture(page, `Kit-missing-${family}-${width}`);
            const back = page.getByRole("link", {
              name: family === "events" ? "Back to events" : "Back to featured",
              exact: true,
            });
            await tabTo(page, back);
            await Promise.all([
              page.waitForURL(`${recoveryOrigin}/admin/${family}`),
              page.keyboard.press("Enter"),
            ]);
            expect(methods).toEqual(["GET", "GET"]);
          } finally {
            await context.close();
          }
        });
      }
    });
  }
}
