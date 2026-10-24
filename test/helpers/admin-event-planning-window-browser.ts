// Registered in the existing unconditional Kit admin Chromium CI suite.
// These canned classified reads prove rendered controls/navigation, not SQL filtering.
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import type { Browser, Locator } from "playwright";
import { compilePlanningWindowKit } from "./admin-event-planning-window";
import { pageShellFixture } from "./page-shells";

export function registerPlanningWindowBrowserAcceptance(getBrowser: () => Browser) {
  let kit: Awaited<ReturnType<typeof compilePlanningWindowKit>>;
  before(async () => {
    kit = await compilePlanningWindowKit();
  });
  const origin = "https://next.example.test";
  const publicRoot = resolve("public");

  for (const twin of ["Hono", "Kit"] as const) {
    for (const width of [1280, 390]) {
      for (const javaScriptEnabled of [false, true]) {
        test(`${twin} UTC planning native GET + keyboard at ${width}, JavaScript=${javaScriptEnabled}`, async () => {
          const fixture = pageShellFixture();
          const context = await getBrowser().newContext({
            javaScriptEnabled,
            viewport: { width, height: width === 390 ? 844 : 800 },
            serviceWorkers: "block",
          });
          const requests: string[] = [];
          const escaped: string[] = [];
          try {
            await context.route("**/*", async (route) => {
              const request = route.request();
              const url = new URL(request.url());
              if (url.origin !== origin || request.method() !== "GET") {
                escaped.push(`${request.method()} ${url.pathname}`);
                return route.abort();
              }
              if (url.pathname === "/admin/events") {
                assert.equal(
                  request.resourceType(),
                  "document",
                  "native inventory navigation, not a JS-only fetch",
                );
                requests.push(url.href);
                const response =
                  twin === "Hono"
                    ? await fixture.request(`/admin/events${url.search}`)
                    : await kit.request({ env: fixture.env, path: url.href });
                let html = await response.text();
                if (twin === "Kit")
                  html = html.replace("</head>", `<style>${kit.css}</style></head>`);
                return route.fulfill({
                  status: response.status,
                  headers: Object.fromEntries(response.headers),
                  body: html,
                });
              }
              const file = resolve(publicRoot, `.${url.pathname}`);
              if (file.startsWith(`${publicRoot}/`) && existsSync(file)) {
                return route.fulfill({
                  body: readFileSync(file),
                  contentType: file.endsWith(".css")
                    ? "text/css"
                    : file.endsWith(".js")
                      ? "text/javascript"
                      : file.endsWith(".svg")
                        ? "image/svg+xml"
                        : "application/octet-stream",
                });
              }
              return route.fulfill({ status: 404, body: "" });
            });
            const page = await context.newPage();
            const response = await page.goto(`${origin}/admin/events?page=4&sort=title&order=asc`);
            assert.equal(
              response?.status(),
              200,
              "fixture reaches the real inventory, not an error shell",
            );
            assert.equal(
              await page.getByRole("button", { name: "Filter", exact: true }).count(),
              1,
            );
            assert.ok(
              (await page.locator('[data-testid^="event-status-"]').count()) > 0,
              "fixture renders an actual event row",
            );
            const evidence = process.env.PLANNING_WINDOW_EVIDENCE_DIR;
            if (evidence && !javaScriptEnabled) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot({
                path: resolve(evidence, `${twin.toLowerCase()}-${width}-baseline.png`),
                fullPage: true,
              });
            }
            const from = page.getByLabel(/Starts from.*UTC|UTC.*Starts from/i);
            const beforeDate = page.getByLabel(/Starts before.*UTC|UTC.*Starts before/i);
            assert.equal(await from.count(), 1, "missing rendered UTC Starts from input");
            assert.equal(await beforeDate.count(), 1, "missing rendered UTC Starts before input");
            assert.equal(await from.getAttribute("type"), "date");
            assert.equal(await beforeDate.getAttribute("type"), "date");
            await from.fill("2030-01-01");
            await beforeDate.fill("2030-01-03");
            // Reach the control and the submit action through actual Tab traversal.
            async function tabTo(target: Locator) {
              for (let i = 0; i < 80; i++) {
                if (
                  await target.evaluate(
                    (element) =>
                      element === document.activeElement ||
                      element.contains(document.activeElement),
                  )
                )
                  return;
                await page.keyboard.press("Tab");
              }
              assert.fail("Date filter control is not reachable by keyboard");
            }
            await tabTo(from);
            await tabTo(beforeDate);
            const form = beforeDate.locator("xpath=ancestor::form");
            const submit = form.getByRole("button", { name: "Filter", exact: true });
            await tabTo(submit);
            await Promise.all([
              page.waitForURL((url) => url.searchParams.get("starts_from") === "2030-01-01"),
              page.keyboard.press("Enter"),
            ]);
            const committed = new URL(page.url());
            assert.equal(committed.searchParams.get("starts_before"), "2030-01-03");
            assert.ok(
              !committed.searchParams.has("page") || committed.searchParams.get("page") === "1",
              "changed filter starts on page one",
            );
            assert.equal(await from.inputValue(), "2030-01-01");
            assert.equal(await beforeDate.inputValue(), "2030-01-03");
            assert.ok(requests.length >= 2, "the no-JS form actually navigated");
            assert.deepEqual(escaped, [], "no remote services or mutations");
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}
