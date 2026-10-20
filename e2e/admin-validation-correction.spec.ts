// Test Author owned. Real Chromium, rendered application pages and shipped
// assets; all requests intercepted. Actual guard/POST classification is covered
// independently in test/admin-validation-correction.test.ts, not mocked here.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileKitForms,
  eventValues,
  featuredValues,
  formFixtures,
  globalError,
  rejectedHtml,
  root,
  type FormFixture,
} from "../test/helpers/admin-validation-correction";

let compiler: Awaited<ReturnType<typeof compileKitForms>>;
let rejected: FormFixture[];
let clean: FormFixture[];
test.beforeAll(async () => {
  compiler = await compileKitForms();
  rejected = await formFixtures(compiler, true);
  clean = await formFixtures(compiler, false);
});
test.afterAll(() => compiler?.dispose());

const origin = "http://127.0.0.1:18783";
const rejectedNames = [
  "Hono event new",
  "Kit event new",
  "Hono featured new",
  "Hono event edit",
  "Kit event edit",
  "Hono featured edit",
];
const cleanNames = [...rejectedNames, "Kit featured new", "Kit featured edit"];

type Post = { path: string; values: Record<string, string> };
async function mount(context: BrowserContext, fixture: FormFixture) {
  const posts: Post[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (req.method() === "POST") {
      const values = Object.fromEntries(new URLSearchParams(req.postData() ?? ""));
      posts.push({ path: url.pathname, values });
      if (url.pathname !== fixture.action)
        return route.fulfill({ status: 404, body: "Wrong POST target" });
      return route.fulfill({
        status: 422,
        contentType: "text/html",
        body: await rejectedHtml(fixture.kind, fixture.mode, values),
      });
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      (url.pathname.startsWith("/islands/") || url.pathname.endsWith(".css")) &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset)
    ) {
      return route.fulfill({
        contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        body: readFileSync(asset),
      });
    }
    if (url.pathname === fixture.path)
      return route.fulfill({
        status: fixture.kit || !Object.keys(fixture.errors).length ? 200 : 422,
        contentType: "text/html",
        body: fixture.html,
      });
    return route.fulfill({ status: 404, body: "No external fixture" });
  });
  return posts;
}
async function activeId(page: Page) {
  return page.evaluate<string>('document.activeElement?.id ?? ""');
}
async function guardsDeparture(page: Page) {
  return page.evaluate<boolean>(`(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
}
async function tabToLink(page: Page, href: string) {
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    if (
      (await page.evaluate<string | null>('document.activeElement?.getAttribute("href")')) === href
    )
      return;
  }
  throw new Error(`Keyboard Tab could not reach ${href}`);
}

for (const name of rejectedNames) {
  test(`${name}: a rejected document announces and focuses a visible correction starting point`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const f = rejected.find((row) => row.name === name)!;
      await mount(context, f);
      const page = await context.newPage();
      await page.goto(origin + f.path);
      const summary = page.getByTestId("form-errors");
      await expect(summary).toBeVisible();
      expect(["-1", "0"]).toContain(await summary.getAttribute("tabindex"));
      expect(await summary.evaluate("(el) => el === document.activeElement")).toBe(true);
      expect(
        await summary.evaluate(
          (el) =>
            el.getAttribute("role") === "alert" ||
            ["assertive", "polite"].includes(el.getAttribute("aria-live") ?? ""),
        ),
      ).toBe(true);
      expect(await summary.innerText()).toContain(globalError);
      expect(await summary.locator("img,script").count()).toBe(0);
      expect(await page.evaluate("window.summaryInjected")).toBeUndefined();
      expect(await guardsDeparture(page)).toBe(true);
    } finally {
      await context.close();
    }
  });
  for (const javaScriptEnabled of [true, false]) {
    test(`${name}: every correction link works by keyboard, JS=${javaScriptEnabled}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const f = rejected.find((row) => row.name === name)!;
        await mount(context, f);
        const page = await context.newPage();
        await page.goto(origin + f.path);
        const summary = page.getByTestId("form-errors");
        await expect(summary).toBeVisible();
        const links = summary.locator('a[href^="#"]');
        expect(await links.count()).toBe(Object.keys(f.targets).length);
        for (const [field, id] of Object.entries(f.targets)) {
          const link = summary.locator(`a[href="#${id}"]`);
          expect(await link.count(), field).toBe(1);
          await tabToLink(page, `#${id}`);
          await page.keyboard.press("Enter");
          expect(await activeId(page), `${field} receives correction focus`).toBe(id);
          const target = page.locator(`#${id}`);
          await expect(target).toBeVisible();
          expect(await target.getAttribute("aria-invalid")).toBe("true");
          const tokens = (await target.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
          expect(tokens).toContain(`${id}-error`);
          expect(await page.locator(`#${id}-error`).innerText()).toBe(f.errors[field]);
          await page.keyboard.press("Tab");
          expect(await activeId(page), "no focus trap").not.toBe(id);
        }
        expect(await summary.innerText()).toContain(globalError);
        expect(await summary.locator('a[href="#global"],a[href="#f-global"]').count()).toBe(0);
      } finally {
        await context.close();
      }
    });
  }
}

for (const name of cleanNames) {
  test(`${name}: ordinary GET does not steal focus or mark the saved form dirty`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const f = clean.find((row) => row.name === name)!;
      const posts = await mount(context, f);
      const page = await context.newPage();
      await page.goto(origin + f.path);
      expect(await page.getByTestId("form-errors").count()).toBe(0);
      expect(await page.evaluate("document.activeElement?.tagName")).toBe("BODY");
      expect(await guardsDeparture(page)).toBe(false);
      await page.locator('[name="title"]').fill("A newer unsaved draft");
      await page.evaluate(
        'window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))',
      );
      expect(await page.locator('[name="title"]').inputValue()).toBe("A newer unsaved draft");
      expect(await page.getByTestId("form-errors").count()).toBe(0);
      expect(await guardsDeparture(page)).toBe(true);
      expect(posts).toEqual([]);
    } finally {
      await context.close();
    }
  });
  for (const javaScriptEnabled of [false, true]) {
    test(`${name}: native POST retains the draft in the shared Hono 422, JS=${javaScriptEnabled}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const f = clean.find((row) => row.name === name)!;
        const posts = await mount(context, f);
        const page = await context.newPage();
        await page.goto(origin + f.path);
        const values = f.kind === "event" ? eventValues : featuredValues;
        for (const [field, value] of Object.entries(values)) {
          const control = page.locator(`[name="${field}"]`);
          if (!(await control.count())) continue; // Edit has no recurrence controls.
          if (field === "is_published") await control.check();
          else if (field === "recurrence_frequency") await control.selectOption(value);
          else await control.fill(value);
        }
        const responsePromise = page.waitForNavigation();
        await page.getByTestId(f.kind === "event" ? "save-event" : "save-featured").click();
        const response = await responsePromise;
        expect(response?.status()).toBe(422);
        expect(posts).toHaveLength(1);
        expect(posts[0]!.path).toBe(f.action);
        for (const [field, value] of Object.entries(values)) {
          const control = page.locator(`[name="${field}"]`);
          if (!(await control.count())) continue;
          if (field === "is_published") await expect(control).toBeChecked();
          else expect(await control.inputValue(), `${field} retained`).toBe(value);
        }
        const summary = page.getByTestId("form-errors");
        await expect(summary).toBeVisible();
        expect(await summary.locator('a[href^="#"]').count()).toBeGreaterThan(1);
        if (javaScriptEnabled) {
          expect(await summary.evaluate("(el) => el === document.activeElement")).toBe(true);
          // Correction and BFCache/cancelled-navigation events cannot turn the
          // rejected document into a saved baseline or clear the newer draft.
          await page.locator('[name="title"]').fill("A newer correction <keep>");
          await page.evaluate(
            'window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))',
          );
          expect(await page.locator('[name="title"]').inputValue()).toBe(
            "A newer correction <keep>",
          );
          expect(await guardsDeparture(page)).toBe(true);
          expect(posts).toHaveLength(1);
        }
      } finally {
        await context.close();
      }
    });
  }
}
