// Acceptance-owned functional SSR fixtures. No QA login, DB, deployed origin,
// or network fallback. Builder still owns real-app before/after visual evidence.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { parseJoinAttemptsQuery } from "../src/admin/table-list";
import {
  DIAGNOSTIC_OUTCOME,
  DIAGNOSTIC_TWINS,
  compileDiagnosticsKit,
  renderDiagnostics,
} from "../test/helpers/admin-diagnostics-acceptance";

const origin = "https://localhost:8787";
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
let kit: Awaited<ReturnType<typeof compileDiagnosticsKit>>;
test.beforeAll(async () => {
  kit = await compileDiagnosticsKit();
});
test.afterAll(() => kit?.dispose());

for (const twin of DIAGNOSTIC_TWINS)
  for (const width of [1280, 390]) {
    test(`${twin} ${width}: native outcome drill-down works by keyboard without JavaScript`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width, height: width === 390 ? 844 : 800 },
        serviceWorkers: "block",
      });
      const documents: string[] = [];
      const unexpected: string[] = [];
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== origin) {
            unexpected.push("external request");
            return route.abort();
          }
          if (request.resourceType() === "document") {
            documents.push(url.pathname + url.search);
            if (url.pathname === "/admin") {
              return route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: renderDiagnostics(twin, kit, "populated", "unavailable"),
              });
            }
            if (url.pathname === "/admin/join-attempts") {
              // Destination is an inert receipt, not a mocked production viewer.
              // The real parser below verifies the committed native navigation.
              return route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: "<!doctype html><title>Fixture navigation receipt</title><h1>Fixture destination</h1>",
              });
            }
          }
          if (url.pathname === "/styles.css") {
            return route.fulfill({
              contentType: "text/css",
              body: readFileSync(resolve(publicRoot, "styles.css")),
            });
          }
          unexpected.push(request.resourceType());
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(`${origin}/admin`);
        const section = page.getByTestId("join-funnel");
        // Count before interacting: a missing anchor must fail as behavior, not a timeout.
        const links = section.locator('a[href*="outcome="]');
        expect(await links.count(), "each recorded outcome needs a native anchor").toBe(3);
        for (const outcome of ["added", "denied", DIAGNOSTIC_OUTCOME]) {
          let target = "";
          for (const link of await links.all()) {
            const href = await link.getAttribute("href");
            if (new URL(href!, origin).searchParams.get("outcome") === outcome) target = href!;
          }
          expect(target, `a real anchor for ${outcome}`).not.toBe("");
        }
        const allLinks = await links.all();
        let unknownIndex = -1;
        for (const [index, link] of allLinks.entries()) {
          const href = await link.getAttribute("href");
          if (new URL(href!, origin).searchParams.get("outcome") === DIAGNOSTIC_OUTCOME)
            unknownIndex = index;
        }
        expect(unknownIndex).toBeGreaterThanOrEqual(0);
        const target = links.nth(unknownIndex);
        let reached = false;
        for (let step = 0; step < 40; step++) {
          await page.keyboard.press("Tab");
          if (await target.evaluate((node) => node.matches(":focus"))) {
            reached = true;
            break;
          }
        }
        expect(reached, "native outcome anchor is in sequential keyboard focus order").toBe(true);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp("/admin/join-attempts\\?"));
        const url = new URL(page.url());
        expect(parseJoinAttemptsQuery(Object.fromEntries(url.searchParams))).toEqual({
          outcome: DIAGNOSTIC_OUTCOME,
          q: "",
          page: 1,
        });
        expect(documents).toEqual(["/admin", url.pathname + url.search]);
        expect(unexpected, "no extra document, fetch, telemetry or mutation request").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
