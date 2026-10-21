// Registered inside the existing featured native-browser CI gate. Browser code
// is real Hono minified output / compiled + hydrated Kit; only transport and
// persistence are fixture-owned. No request escapes interception.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgets,
  compileFeaturedClients,
  compileKitForms,
  documentFixture,
  errorsFor,
  fields,
  root,
  saved,
  textCases,
  urlCases,
  type Compiler,
  type Field,
  type Mode,
  type Surface,
} from "./featured-editorial-fixtures";

const origin = "https://editorial.example.test";
const selector = (field: Field) => `[name="${field}"]`;
type Description = {
  id: string;
  exists: boolean;
  serverError: boolean;
  text: string;
  visible: boolean;
  live: boolean;
};
async function descriptions(page: Page, field: Field): Promise<Description[]> {
  return page.evaluate<Description[]>(`(() => {
    const control = document.querySelector(${JSON.stringify(selector(field))});
    return (control.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean).map(id => {
      const node = document.getElementById(id);
      return {
        id, exists: Boolean(node), serverError: id === control.id + '-error',
        text: node?.textContent ?? '',
        visible: Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'),
        live: Boolean(node?.closest('[aria-live="polite"],[aria-live="assertive"],[role="status"],[role="alert"]')),
      };
    });
  })()`);
}
async function feedback(page: Page, field: Field, used: number, over = false) {
  return assertFeedback(await descriptions(page, field), field, used, over);
}
function assertFeedback(
  associated: Awaited<ReturnType<typeof descriptions>>,
  field: Field,
  used: number,
  over = false,
) {
  expect(
    associated.every((node) => node.exists),
    "every description token resolves",
  ).toBe(true);
  const nodes = associated.filter((node) => !node.serverError && node.visible);
  const text = nodes.map((node) => node.text).join(" ");
  expect(nodes.length, `${field} feedback stays associated`).toBeGreaterThan(0);
  expect(
    nodes.every((node) => node.visible),
    `${field} feedback is visible`,
  ).toBe(true);
  expect(
    nodes.every((node) => !node.live),
    "do not announce each keystroke",
  ).toBe(true);
  // Permit used/max or remaining/max presentation, not a particular sentence,
  // test ID, element type or CSS class. The displayed number must be current.
  const remaining = budgets[field] - used;
  const current = new RegExp(`\\b${used}\\b`);
  const left = new RegExp(`${remaining}\\s+(?:[\\w-]+\\s+){0,3}(?:remaining|left)`, "i");
  expect(
    current.test(text) || left.test(text),
    `${field}: expected ${used}/${budgets[field]}, got ${JSON.stringify(text)}`,
  ).toBe(true);
  expect(text).toMatch(new RegExp(`\\b${budgets[field]}\\b`));
  expect(text).toMatch(
    field === "url" || field === "image_url" ? /UTF[ -]?16/i : /code[ -]?points?/i,
  );
  if (over)
    expect(text, "over-budget state is conveyed in text, not just color").toMatch(
      /over|exceed|too long|too many|-[1-9]\d*/i,
    );
  return nodes.map((node) => node.id);
}
async function settle(page: Page) {
  await page.evaluate(
    "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))",
  );
}
async function departureProtected(page: Page) {
  return page.evaluate<boolean>(`(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
}

export function featuredEditorialBrowserTests(getBrowser: () => Browser) {
  describe("featured editorial limits browser acceptance", () => {
    let compiler: Compiler;
    let clients: Record<Mode, string>;
    beforeAll(async () => {
      compiler = await compileKitForms();
      clients = await compileFeaturedClients();
    });
    afterAll(() => compiler?.dispose());

    async function mount(
      context: BrowserContext,
      surface: Surface,
      mode: Mode,
      javaScriptEnabled = true,
      values?: Record<string, string>,
    ) {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let fixture = await documentFixture(compiler, surface, mode, values);
      let current = fixture.html;
      const requests: string[] = [];
      const posts: Array<{ path: string; values: Record<string, string> }> = [];
      function html() {
        if (fixture.surface !== "Kit") return current;
        const data = JSON.stringify(fixture.data).replace(/</g, "\\u003c");
        return `<!doctype html><html><head></head><body><div id="kit-root">${current}</div><script>window.fixtureData=${data}</script><script defer src="/fixture-client.js"></script></body></html>`;
      }
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push(`${request.method()} ${request.url()}`);
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (request.method() === "POST") {
          const values = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
          posts.push({ path: url.pathname, values });
          if (url.pathname !== fixture.action)
            return route.fulfill({ status: 404, body: "Wrong native action" });
          const errors = errorsFor(values);
          if (Object.keys(errors).length) {
            fixture = await documentFixture(compiler, "Hono", mode, values, errors);
            current = fixture.html;
            return route.fulfill({
              status: 422,
              contentType: "text/html; charset=utf-8",
              body: current,
            });
          }
          // Synthetic saved GET: test counter reinitialization, not database CRUD.
          const normalized = Object.fromEntries(
            Object.entries(values).map(([name, value]) => [name, value.trim()]),
          );
          fixture = await documentFixture(compiler, "Hono", "edit", normalized);
          current = fixture.html;
          // Follow with an explicit intercepted GET in the test. Chromium can
          // bypass request interception for a fulfilled HTTP redirect; database
          // persistence and production 303 semantics belong to the route suites.
          return route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: current,
          });
        }
        if (url.pathname === "/fixture-client.js")
          return route.fulfill({ contentType: "text/javascript", body: clients[mode] });
        const asset = resolve(root, "public", url.pathname.slice(1));
        if (
          asset.startsWith(join(root, "public/")) &&
          existsSync(asset) &&
          /\.(?:js|css)$/.test(asset)
        ) {
          return route.fulfill({
            contentType: asset.endsWith(".css") ? "text/css" : "text/javascript",
            body: readFileSync(asset),
          });
        }
        if (request.resourceType() === "document")
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: html() });
        return route.fulfill({ status: 404, body: "" });
      });
      await page.goto(origin + fixture.path);
      if (surface === "Kit" && javaScriptEnabled) {
        await page.waitForFunction("window.kitMounted === true");
      }
      if (javaScriptEnabled) await settle(page);
      expect(pageErrors, "fixture mounts real client code without runtime errors").toEqual([]);
      return { context, page, requests, posts, pageErrors };
    }
    async function withPage(
      surface: Surface,
      mode: Mode,
      run: (h: Awaited<ReturnType<typeof mount>>) => Promise<void>,
      options: { javaScriptEnabled?: boolean; values?: Record<string, string> } = {},
    ) {
      let context: BrowserContext | undefined;
      try {
        context = await getBrowser().newContext({
          javaScriptEnabled: options.javaScriptEnabled ?? true,
          serviceWorkers: "block",
        });
        const h = await mount(context, surface, mode, options.javaScriptEnabled, options.values);
        await run(h);
        expect(h.pageErrors).toEqual([]);
      } finally {
        await context?.close();
      }
    }

    for (const surface of ["Hono", "Kit"] as const) {
      for (const mode of ["new", "edit"] as const) {
        const name = `${surface} ${mode}`;
        it(`${name}: no-JS budgets are visible and associated before Save`, async () => {
          await withPage(
            surface,
            mode,
            async ({ page }) => {
              for (const field of fields) {
                const nodes = await descriptions(page, field);
                expect(nodes.length, `${field} hint exists without enhancement`).toBeGreaterThan(0);
                expect(nodes.every((node) => node.visible)).toBe(true);
                expect(nodes.map((node) => node.text).join(" ")).toContain(String(budgets[field]));
              }
            },
            { javaScriptEnabled: false },
          );
        });
        it(`${name}: initializes feedback from the document's actual values`, async () => {
          await withPage(surface, mode, async ({ page }) => {
            const counts = mode === "new" ? [0, 0, 0, 0, 0] : [10, 14, 15, 26, 36];
            for (const [index, field] of fields.entries())
              await feedback(page, field, counts[index]!);
          });
        });
        if (surface === "Hono" || mode === "edit") {
          it(`${name}: rendered emoji, combining marks and surrounding whitespace initialize without input`, async () => {
            await withPage(
              surface,
              mode,
              async ({ page }) => {
                await feedback(page, "title", 128);
                await feedback(page, "body", 3);
                await feedback(page, "image_alt", 3);
              },
              {
                values: {
                  ...saved,
                  title: `  ${"😀".repeat(128)}  `,
                  body: "  é😀  ",
                  image_alt: "  é😀  ",
                },
              },
            );
          });
        }
        it(`${name}: typing alone preserves all fields and preview bytes with zero requests`, async () => {
          await withPage(surface, mode, async ({ page, requests }) => {
            const preview = await page
              .getByTestId("featured-preview")
              .evaluateAll((nodes: Array<{ outerHTML: string }>) =>
                nodes.map((node) => node.outerHTML),
              );
            const before = requests.length;
            for (const field of fields) {
              const value =
                field === "url" || field === "image_url"
                  ? urlCases(field)[1]!.value
                  : "😀".repeat(budgets[field] + 1);
              await page.locator(selector(field)).fill(value);
              expect(await page.locator(selector(field)).inputValue()).toBe(value);
              expect(await page.locator(selector(field)).getAttribute("maxlength")).toBeNull();
            }
            await page.locator(selector("title")).pressSequentially("abc");
            await settle(page);
            expect(requests.slice(before)).toEqual([]);
            expect(
              await page
                .getByTestId("featured-preview")
                .evaluateAll((nodes: Array<{ outerHTML: string }>) =>
                  nodes.map((node) => node.outerHTML),
                ),
            ).toEqual(preview);
          });
        });
        for (const field of fields) {
          it(`${name}: ${field} input uses the validator's exact trimmed unit without requests or truncation`, async () => {
            await withPage(surface, mode, async ({ page, requests }) => {
              const cases =
                field === "url" || field === "image_url"
                  ? urlCases(field)
                  : textCases(budgets[field]);
              const before = requests.length;
              const preview = await page
                .getByTestId("featured-preview")
                .evaluateAll((nodes: Array<{ outerHTML: string }>) =>
                  nodes.map((node) => node.outerHTML),
                );
              for (const test of cases) {
                await page.locator(selector(field)).fill(test.value);
                await settle(page);
                // URL input's native ASCII-whitespace sanitization is not an
                // application truncation; text controls must retain every unit.
                const retained = await page.locator(selector(field)).inputValue();
                if (field === "url" || field === "image_url")
                  expect(retained.trim()).toBe(test.value.trim());
                else expect(retained).toBe(test.value);
                await feedback(page, field, test.used, test.over);
              }
              expect(
                requests.slice(before),
                "typing performs zero fetches, posts, image loads or previews",
              ).toEqual([]);
              expect(
                await page
                  .getByTestId("featured-preview")
                  .evaluateAll((nodes: Array<{ outerHTML: string }>) =>
                    nodes.map((node) => node.outerHTML),
                  ),
              ).toEqual(preview);
            });
          });
        }
        it(`${name}: image presence changes missing-alt state without submitting`, async () => {
          await withPage(surface, mode, async ({ page, requests }) => {
            await page.locator(selector("image_url")).fill("");
            await page.locator(selector("image_alt")).fill(" \t  ");
            await settle(page);
            const before = (await descriptions(page, "image_alt")).filter((node) => node.visible);
            const invalidBefore = await page
              .locator(selector("image_alt"))
              .getAttribute("aria-invalid");
            const requestCount = requests.length;
            await page.locator(selector("image_url")).fill(saved.image_url);
            await settle(page);
            const missing = (await descriptions(page, "image_alt")).filter((node) => node.visible);
            expect(missing.map((node) => node.text).join(" ")).toMatch(
              /required|missing|describe|description/i,
            );
            const invalid = await page.locator(selector("image_alt")).getAttribute("aria-invalid");
            expect(
              JSON.stringify(missing) !== JSON.stringify(before) ||
                (invalid === "true" && invalidBefore !== "true"),
              "a textual or ARIA state changes when an image makes blank alt invalid",
            ).toBe(true);
            await page.locator(selector("image_alt")).fill(" é😀 ");
            await settle(page);
            await feedback(page, "image_alt", 3);
            await page.locator(selector("image_alt")).fill("");
            await page.locator(selector("image_url")).fill("");
            await settle(page);
            expect((await descriptions(page, "image_alt")).filter((node) => node.visible)).toEqual(
              before,
            );
            expect(await page.locator(selector("image_alt")).getAttribute("aria-invalid")).not.toBe(
              "true",
            );
            expect(requests.slice(requestCount)).toEqual([]);
          });
        });
        it(`${name}: reset restores values and feedback after the browser's reset default action`, async () => {
          await withPage(surface, mode, async ({ page }) => {
            // Preserve native reset semantics, including Svelte's hydrated
            // defaultValue behavior; this slice does not redefine reset values.
            const defaults = await page.evaluate<string[]>(
              `${JSON.stringify(fields)}.map(name => document.querySelector('[name="' + name + '"]').defaultValue)`,
            );
            for (const field of fields) {
              const test =
                field === "url" || field === "image_url"
                  ? urlCases(field)[1]!
                  : textCases(budgets[field])[1]!;
              await page.locator(selector(field)).fill(test.value);
            }
            await settle(page);
            const over = await descriptions(page, "body");
            await page.evaluate("document.querySelector('form[data-event-editor]').reset()");
            await settle(page);
            expect(
              await Promise.all(fields.map((field) => page.locator(selector(field)).inputValue())),
            ).toEqual(defaults);
            for (const [index, field] of fields.entries()) {
              const value = defaults[index]!.trim();
              await feedback(
                page,
                field,
                field === "url" || field === "image_url" ? value.length : [...value].length,
              );
            }
            assertFeedback(over, "body", 1001, true);
          });
        });
        it(`${name}: live validation setup and cleanup preserve persistent description IDs`, async () => {
          await withPage(surface, mode, async ({ page }) => {
            const original = (await descriptions(page, "title")).map((node) => node.id);
            await page.locator(selector("title")).fill("😀".repeat(256));
            await settle(page);
            const over = await descriptions(page, "title");
            await page.locator(selector("title")).fill("x");
            await settle(page);
            const corrected = await descriptions(page, "title");
            expect(original.length, "persistent hints predate validation").toBeGreaterThan(0);
            expect(over.map((node) => node.id)).toEqual(expect.arrayContaining(original));
            expect(corrected.map((node) => node.id)).toEqual(expect.arrayContaining(original));
            expect(new Set(corrected.map((node) => node.id)).size).toBe(corrected.length);
            assertFeedback(over, "title", 256, true);
            assertFeedback(corrected, "title", 1);
          });
        });
        it(`${name}: feedback does not take dirty-draft or repeated-submit ownership`, async () => {
          await withPage(surface, mode, async ({ page, requests }) => {
            await page.locator(selector("title")).fill("A changed 😀 draft");
            expect(await departureProtected(page)).toBe(true);
            const before = requests.length;
            const attempts = await page.evaluate<{ accepted: boolean[]; title: string }>(`(() => {
              const form = document.querySelector('form[data-event-editor]');
              const accepted = [];
              form.addEventListener('submit', event => {
                accepted.push(!event.defaultPrevented);
                event.preventDefault();
              });
              form.requestSubmit(); form.requestSubmit();
              return { accepted, title: new FormData(form).get('title') };
            })()`);
            expect(attempts).toEqual({ accepted: [true, false], title: "A changed 😀 draft" });
            expect(requests.slice(before)).toEqual([]);
          });
        });
        it(`${name}: native rejection retains hints plus errors, then normalized saved navigation reinitializes`, async () => {
          await withPage(surface, mode, async ({ page, posts }) => {
            await page.locator(selector("title")).fill(" \t😀 valid draft   ");
            await page.locator(selector("body")).fill("x".repeat(1001));
            const response = page.waitForNavigation();
            await page.getByTestId("save-featured").click();
            expect((await response)?.status()).toBe(422);
            expect(posts).toHaveLength(1);
            expect(posts[0]!.path).toBe(mode === "new" ? "/admin/featured" : "/admin/featured/7");
            expect(posts[0]!.values.body).toHaveLength(1001);
            expect(await page.locator(selector("body")).inputValue()).toHaveLength(1001);
            const rejected = await descriptions(page, "body");
            expect(rejected.some((node) => node.serverError && node.visible)).toBe(true);
            expect(await departureProtected(page)).toBe(true);
            await page.locator(selector("body")).fill("  é😀   ");
            await settle(page);
            const corrected = await descriptions(page, "body");
            const savedPage = page.waitForNavigation();
            await page.getByTestId("save-featured").click();
            await savedPage;
            await page.goto(origin + "/admin/featured/7");
            expect(page.url()).toBe(origin + "/admin/featured/7");
            expect(posts).toHaveLength(2);
            expect(await page.locator(selector("body")).inputValue()).toBe("é😀");
            const normalized = await descriptions(page, "body");
            expect(normalized.some((node) => node.serverError)).toBe(false);
            expect(await departureProtected(page)).toBe(false);
            const ids = assertFeedback(normalized, "body", 3);
            expect(rejected.map((node) => node.id)).toEqual(expect.arrayContaining(ids));
            assertFeedback(rejected, "body", 1001, true);
            assertFeedback(corrected, "body", 3);
          });
        });
      }
    }
  });
}
