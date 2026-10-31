// Registered in the existing unconditional Kit admin Chromium CI suite.
// These canned classified reads prove rendered controls/navigation, not SQL filtering.
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import type { Browser, Locator } from "playwright";
import { compilePlanningWindowKit } from "./admin-event-planning-window";
import { pageShellFixture } from "./page-shells";

// Browser callbacks run in Chromium; keep their DOM surface local to this module.
declare const document: { activeElement: unknown };
declare function getComputedStyle(element: unknown): { color: string; backgroundColor: string };

function contrastRatio(color: string, background: string): number {
  function luminance(value: string) {
    const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
    assert.ok(rgb, `notice contrast requires an opaque, measurable RGB color: ${value}`);
    const linear = rgb.slice(1).map((component) => {
      const channel = Number(component) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  }
  const a = luminance(color);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

type LoadedPlanningWindow = Awaited<
  ReturnType<Awaited<ReturnType<typeof compilePlanningWindowKit>>["loadData"]>
>;
export function registerPlanningWindowBrowserAcceptance(
  getBrowser: () => Browser,
  renderKit: (path: string, loaded: LoadedPlanningWindow) => Promise<Response>,
  completed: (id: string) => void,
) {
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
                    : await renderKit(
                        url.href,
                        await kit.loadData({ env: fixture.env, path: url.href }),
                      );
                const html = await response.text();
                if (twin === "Kit")
                  assert.match(
                    html,
                    /_app\/immutable\/assets\/0\.[^"]+\.css/,
                    "actual Kit root stylesheet",
                  );
                return route.fulfill({
                  status: response.status,
                  headers: Object.fromEntries(response.headers),
                  body: html,
                });
              }
              const directory = url.pathname.startsWith("/_app/")
                ? resolve("web/.svelte-kit/output/client")
                : publicRoot;
              const file = resolve(directory, `.${url.pathname}`);
              if (file.startsWith(`${directory}/`) && existsSync(file)) {
                return route.fulfill({
                  body: readFileSync(file),
                  contentType: file.endsWith(".css")
                    ? "text/css"
                    : file.endsWith(".js")
                      ? "text/javascript"
                      : file.endsWith(".svg")
                        ? "image/svg+xml"
                        : file.endsWith(".woff2")
                          ? "font/woff2"
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
            const evidence =
              process.env.PLANNING_WINDOW_EVIDENCE_DIR ??
              process.env.KIT_ADMIN_CONTRAST_EVIDENCE_DIR;
            if (evidence && !javaScriptEnabled) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot({
                path: resolve(evidence, `${twin.toLowerCase()}-${width}-inventory.png`),
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
            const invalid = await page.goto(
              `${origin}/admin/events?starts_from=2032-03-02&starts_before=2032-02-29`,
            );
            assert.ok(
              [200, 400, 422].includes(invalid!.status()),
              "invalid dates reach a safe response",
            );
            const csp = invalid!.headers()["content-security-policy"];
            assert.ok(csp, "the browser response must carry the production CSP");
            const styles = /(?:^|;)\s*style-src\s+([^;]+)/.exec(csp)?.[1];
            assert.equal(styles?.trim(), "'self'", "no inline-style allowance or CSP bypass");
            if (twin === "Kit")
              assert.ok(
                await page.locator('link[rel="stylesheet"][href*="/_app/"]').count(),
                "real Kit root CSS loaded",
              );
            const notice = page.locator('.event-window-notice[role="alert"]');
            assert.equal(await notice.count(), 1, "invalid window notice is actually rendered");
            assert.ok(await notice.isVisible(), "invalid window notice is visible");
            assert.match(await notice.innerText(), /date window was not applied/i);
            const measured = await notice.evaluate((el) => ({
              color: getComputedStyle(el).color,
              background: getComputedStyle(el).backgroundColor,
            }));
            const ratio = contrastRatio(measured.color, measured.background);
            assert.ok(
              ratio >= 4.5,
              `invalid notice text contrast ${ratio.toFixed(2)}:1 is below 4.5:1`,
            );
            // Axe injects page scripts, so only use it on the JS-enabled twin.
            // The real no-JS document above still gets the same 4.5:1 measurement.
            const contrast = javaScriptEnabled
              ? await new AxeBuilder({ page })
                  .include('.event-window-notice[role="alert"]')
                  .withRules(["color-contrast"])
                  .analyze()
              : null;
            if (evidence) {
              const name = `${twin.toLowerCase()}-${width}-invalid-js-${javaScriptEnabled}`;
              if (!javaScriptEnabled)
                await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true });
              writeFileSync(
                resolve(evidence, `${name}.json`),
                JSON.stringify({ csp, measured, ratio, axe: contrast }, null, 2),
              );
            }
            if (contrast) {
              assert.deepEqual(contrast.incomplete, [], "notice contrast must be measurable");
              assert.deepEqual(contrast.violations, [], "invalid notice must meet text contrast");
              assert.ok(
                contrast.passes.some(
                  (rule) => rule.id === "color-contrast" && rule.nodes.length > 0,
                ),
                "axe actually measured the notice, not an empty include",
              );
            }
            assert.deepEqual(escaped, [], "no remote services or mutations");
          } finally {
            await context.close();
          }
          completed(`${twin}/${width}/${javaScriptEnabled}`);
        });
      }
    }
  }
}
