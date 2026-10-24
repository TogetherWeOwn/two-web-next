// Offline acceptance, automatically discovered by the existing browser journey
// config. All documents/POST results are intercepted synthetic fixtures. This
// does not exercise a live database or substitute for server admission tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  REVIEW_ROOT,
  SAVED_TARGET,
  SURFACES,
  compileKitPauseReview,
  kitReviewData,
  pathFor,
  pauseActionFor,
  renderHonoReview,
  reopenActionFor,
  type Presentation,
  type Surface,
} from "../test/helpers/admin-rsvp-pause-review";

const ORIGIN = "https://review.example.test";
let kit: Awaited<ReturnType<typeof compileKitPauseReview>>;
test.beforeAll(async () => {
  kit = await compileKitPauseReview();
});
test.afterAll(() => kit?.close());

type FixtureOptions = {
  javaScriptEnabled?: boolean;
  width?: number;
  height?: number;
  responseStatus?: number;
  rejectedSave?: boolean;
  rsvpOpen?: boolean;
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
  const rsvpOpen = options.rsvpOpen ?? true;
  const html =
    presentation === "hono"
      ? renderHonoReview(surface, { rsvpOpen, rejectedSave: options.rejectedSave })
      : kit.render(
          surface,
          await kitReviewData(surface, { rsvpOpen, rejectedSave: options.rejectedSave }),
        );
  const mutations: { path: string; body: string }[] = [];
  const documents: string[] = [];
  const expectedAction = rsvpOpen ? pauseActionFor(surface) : reopenActionFor(surface);
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (req.method() !== "GET" && req.method() !== "HEAD") {
      mutations.push({ path: url.pathname, body: req.postData() ?? "" });
      if (url.pathname !== expectedAction) {
        return route.fulfill({ status: 400, body: "Unexpected mutation" });
      }
      if (options.responseStatus) {
        return route.fulfill({
          status: options.responseStatus,
          contentType: "text/html",
          body: `<h1>Fixture pause refusal ${options.responseStatus}</h1>`,
        });
      }
      // A direct 200 result: Playwright's route.fulfill does not follow a
      // synthetic 303 for a navigation POST (the browser lands on
      // chrome-error), so the redirect itself is left to the existing server
      // suites (rsvp-toggle pins the 303). This proves the final submit POSTs
      // once to the unchanged endpoint and renders its result.
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Fixture pause result</h1>",
      });
    }
    if (req.isNavigationRequest()) {
      documents.push(url.pathname + url.search);
      return route.fulfill({ contentType: "text/html", body: html });
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
  return { page, context, mutations, documents };
}

async function nativeReview(page: Page, surface: Surface) {
  const form = page.locator(`form[action="${pauseActionFor(surface)}"]`);
  await expect(form).toHaveCount(1);
  const review = page.locator("details").filter({ has: form });
  // Immediate assertion failures, not selector timeouts, prove the baseline
  // lacks a native review while the positive controls prove rendering works.
  expect(await review.count(), "pause form must be inside its native review").toBe(1);
  const summary = review.locator(":scope > summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveAccessibleName(/review|pause/i);
  const final = form.getByRole("button", {
    includeHidden: true,
    name: /pause.*rsvp|confirm.*pause/i,
  });
  await expect(final).toHaveCount(1);
  return { review, summary, final };
}

for (const presentation of ["hono", "kit"] as const) {
  for (const surface of SURFACES) {
    test(`${presentation} ${surface}: positive control renders safe real markup and existing pause POST`, async ({
      browser,
    }) => {
      const f = await openFixture(browser, presentation, surface);
      try {
        await expect(f.page.locator(`form[action="${pauseActionFor(surface)}"]`)).toHaveCount(1);
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

    test(`${presentation} ${surface}: reopen stays one-click with no review wrapper`, async ({
      browser,
    }) => {
      const f = await openFixture(browser, presentation, surface, { rsvpOpen: false });
      try {
        const reopen = f.page.locator(`form[action="${reopenActionFor(surface)}"]`);
        await expect(reopen).toHaveCount(1);
        await expect(f.page.locator(`form[action="${pauseActionFor(surface)}"]`)).toHaveCount(0);
        const wrapped = f.page.locator("details").filter({ has: reopen });
        expect(await wrapped.count(), "reopen must not be wrapped in a review").toBe(0);
        const submit = reopen.getByRole("button", { name: /reopen/i });
        await expect(submit).toHaveCount(1);
        await submit.click();
        await expect(f.page.locator("h1")).toHaveText("Fixture pause result");
        expect(f.mutations).toEqual([{ path: reopenActionFor(surface), body: "" }]);
        expect(new URL(f.page.url()).pathname).toBe(reopenActionFor(surface));
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
          await expect(review).toContainText(/sign[- ]?ups? close|close.*sign[- ]?ups?|paused/i);
          await expect(review).toContainText(/freez|frozen/i);
          await expect(review.locator("img[onerror]")).toHaveCount(0);
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          await summary.press("Space");
          await expect(final).toBeHidden();
          await expect(summary).toBeFocused();
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          await summary.press("Enter");
          await final.focus();
          await expect(final).toBeFocused();
          await final.press("Enter");
          await expect(f.page.locator("h1")).toHaveText("Fixture pause result");
          expect(f.mutations).toEqual([{ path: pauseActionFor(surface), body: "" }]);
          expect(new URL(f.page.url()).pathname).toBe(pauseActionFor(surface));
        } finally {
          await f.context.close();
        }
      });
    }

    test(`${presentation} ${surface}: rejected-Save draft keeps the saved target in review`, async ({
      browser,
    }) => {
      if (surface === "event-list") {
        const f = await openFixture(browser, presentation, surface);
        try {
          const { review } = await nativeReview(f.page, surface);
          await expect(review).toContainText(SAVED_TARGET);
        } finally {
          await f.context.close();
        }
        return;
      }
      const f = await openFixture(browser, presentation, surface, { rejectedSave: true });
      try {
        await expect(f.page.locator('input[name="title"]')).toHaveValue("Unsaved editor headline");
        const { review, summary } = await nativeReview(f.page, surface);
        await summary.press("Enter");
        await expect(review).toContainText(SAVED_TARGET);
        await expect(review).not.toContainText("Unsaved editor headline");
        await expect(f.page.locator('input[name="title"]')).toHaveValue("Unsaved editor headline");
        expect(f.mutations).toEqual([]);
      } finally {
        await f.context.close();
      }
    });
  }
}
