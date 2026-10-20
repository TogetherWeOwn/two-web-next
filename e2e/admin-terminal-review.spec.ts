// Offline acceptance, automatically discovered by the existing browser journey
// config. All documents/POST results are intercepted synthetic fixtures. This
// does not exercise a live database or substitute for server admission tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  DIRTY_TARGET,
  REVIEW_ROOT,
  SAVED_TARGET,
  SURFACES,
  actionFor,
  compileKitReview,
  kitReviewData,
  pathFor,
  renderHonoReview,
  resultFor,
  type Presentation,
  type Surface,
} from "../test/helpers/admin-terminal-review";

const ORIGIN = "https://review.example.test";
let kit: Awaited<ReturnType<typeof compileKitReview>>;
test.beforeAll(async () => {
  kit = await compileKitReview();
});
test.afterAll(() => kit?.close());

type FixtureOptions = {
  javaScriptEnabled?: boolean;
  width?: number;
  height?: number;
  responseStatus?: number;
  rejectedSave?: boolean;
};

async function openFixture(
  browser: Browser,
  presentation: Presentation,
  surface: Surface,
  options: FixtureOptions = {},
) {
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? false,
    serviceWorkers: "block",
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
  });
  const page = await context.newPage();
  const html =
    presentation === "hono"
      ? renderHonoReview(surface, "published", options.rejectedSave)
      : kit.render(surface, await kitReviewData(surface, "published", options.rejectedSave));
  const mutations: { path: string; body: string }[] = [];
  const documents: string[] = [];
  const dialogs: string[] = [];
  let acceptDeparture = false;
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    if (acceptDeparture) await dialog.accept();
    else await dialog.dismiss();
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (req.method() !== "GET" && req.method() !== "HEAD") {
      mutations.push({ path: url.pathname, body: req.postData() ?? "" });
      if (url.pathname !== actionFor(surface)) {
        return route.fulfill({ status: 400, body: "Unexpected mutation" });
      }
      if (options.responseStatus) {
        return route.fulfill({
          status: options.responseStatus,
          contentType: "text/html",
          body: `<h1>Fixture terminal refusal ${options.responseStatus}</h1>`,
        });
      }
      return route.fulfill({
        status: 303,
        headers: { location: `${resultFor(surface)}?fixture=complete` },
        body: "",
      });
    }
    if (req.isNavigationRequest()) {
      documents.push(url.pathname + url.search);
      return route.fulfill({
        contentType: "text/html",
        body: url.searchParams.has("fixture") ? "<h1>Fixture terminal result</h1>" : html,
      });
    }
    if (url.pathname.startsWith("/islands/") && /^\/[a-z0-9/.-]+\.js$/.test(url.pathname)) {
      return route.fulfill({
        contentType: "application/javascript",
        body: readFileSync(join(REVIEW_ROOT, "public", url.pathname), "utf8"),
      });
    }
    if (url.pathname.endsWith(".css") && /^\/[a-z0-9/.-]+\.css$/.test(url.pathname)) {
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync(join(REVIEW_ROOT, "public", url.pathname), "utf8"),
      });
    }
    if (url.pathname === "/auth/status") {
      return route.fulfill({ json: { authenticated: true } });
    }
    return route.abort();
  });
  await page.goto(ORIGIN + pathFor(surface));
  await expect(page.locator("h1")).toBeVisible();
  return {
    page,
    context,
    mutations,
    documents,
    dialogs,
    allowDeparture: () => {
      acceptDeparture = true;
    },
  };
}

async function nativeReview(page: Page, surface: Surface) {
  const form = page.locator(`form[action="${actionFor(surface)}"]`);
  await expect(form).toHaveCount(1);
  const review = page.locator("details").filter({ has: form });
  // Immediate assertion failures, not selector timeouts, prove the baseline
  // lacks a native review while the positive controls prove rendering works.
  expect(await review.count(), "terminal form must be inside its native review").toBe(1);
  const summary = review.locator(":scope > summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveAccessibleName(/review|cancel|delet/i);
  const final = form.getByRole("button", {
    includeHidden: true,
    name:
      surface === "featured-edit"
        ? /delete.*slot|confirm.*delet/i
        : /cancel.*event|confirm.*cancel/i,
  });
  await expect(final).toHaveCount(1);
  return { review, summary, final };
}

for (const presentation of ["hono", "kit"] as const) {
  for (const surface of SURFACES) {
    test(`${presentation} ${surface}: positive control renders safe real markup and existing POST`, async ({
      browser,
    }) => {
      const f = await openFixture(browser, presentation, surface);
      try {
        await expect(f.page.locator(`form[action="${actionFor(surface)}"]`)).toHaveCount(1);
        await expect(f.page.locator("form form")).toHaveCount(0);
        await expect(f.page.locator("img[onerror]")).toHaveCount(0);
        await expect(f.page.locator("body")).toContainText(SAVED_TARGET);
        if (surface !== "event-list") {
          await expect(f.page.locator('input[name="title"]')).toHaveValue(SAVED_TARGET);
        }
        expect(f.mutations).toEqual([]);
      } finally {
        await f.context.close();
      }
    });

    for (const viewport of [
      { label: "desktop", width: 1280, height: 800 },
      { label: "mobile", width: 390, height: 844 },
    ]) {
      test(`${presentation} ${surface}: no-JS ${viewport.label} keyboard review/abandon makes zero POSTs; final posts once`, async ({
        browser,
      }) => {
        const f = await openFixture(browser, presentation, surface, viewport);
        try {
          const { review, summary, final } = await nativeReview(f.page, surface);
          await expect(final).toBeHidden();
          await summary.focus();
          await expect(summary).toBeFocused();
          await summary.press("Enter");
          await expect(final).toBeVisible();
          await expect(review).toContainText(SAVED_TARGET);
          await expect(review.locator("img[onerror]")).toHaveCount(0);
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          await summary.press("Space");
          await expect(final).toBeHidden();
          await expect(summary).toBeFocused();
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          expect(f.dialogs).toEqual([]);
          await summary.press("Enter");
          await final.focus();
          await expect(final).toBeFocused();
          await final.press("Enter");
          await expect(f.page.locator("h1")).toHaveText("Fixture terminal result");
          expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          expect(new URL(f.page.url()).pathname).toBe(resultFor(surface));
        } finally {
          await f.context.close();
        }
      });
    }

    for (const status of [403, 422, 503]) {
      test(`${presentation} ${surface}: no-JS final preserves a ${status} refusal without retry or success`, async ({
        browser,
      }) => {
        const f = await openFixture(browser, presentation, surface, { responseStatus: status });
        try {
          const { summary, final } = await nativeReview(f.page, surface);
          await summary.press("Enter");
          await final.press("Enter");
          await expect(f.page.locator("h1")).toHaveText(`Fixture terminal refusal ${status}`);
          expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          expect(new URL(f.page.url()).pathname).toBe(actionFor(surface));
        } finally {
          await f.context.close();
        }
      });
    }

    if (surface !== "event-list") {
      for (const rejectedSave of [false, true]) {
        test(`${presentation} ${surface}: ${rejectedSave ? "rejected Save" : "dirty draft"} survives abandon; final keeps departure protection`, async ({
          browser,
        }) => {
          const f = await openFixture(browser, presentation, surface, {
            javaScriptEnabled: true,
            rejectedSave,
          });
          try {
            const title = f.page.locator('input[name="title"]');
            if (!rejectedSave) await title.fill(DIRTY_TARGET);
            const { review, summary, final } = await nativeReview(f.page, surface);
            await summary.press("Enter");
            await expect(review).toContainText(SAVED_TARGET);
            await expect(review).not.toContainText(DIRTY_TARGET);
            await summary.press("Space");
            await expect(final).toBeHidden();
            await expect(title).toHaveValue(DIRTY_TARGET);
            expect(f.mutations).toEqual([]);
            expect(f.documents).toEqual([pathFor(surface)]);
            expect(f.dialogs).toEqual([]);
            // A real deliberate final submit retains the existing dirty-draft
            // warning; opening or abandoning must not globally disarm it.
            f.allowDeparture();
            await summary.press("Enter");
            await final.press("Enter");
            await expect(f.page.locator("h1")).toHaveText("Fixture terminal result");
            expect(f.dialogs).toEqual(["beforeunload"]);
            expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          } finally {
            await f.context.close();
          }
        });
      }
    }
  }
}
