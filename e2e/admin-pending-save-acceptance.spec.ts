// Independent Test Author acceptance: protect this file after handoff.
// Run shipped editor bytes on all eight real renderer fixtures. Interrupt the
// native POST navigation at transport, not the submit handler: a write really
// leaves the document, but its result is unknown to the surviving editor.
// The browser clock controls the existing 10-second bound.
// Missing feedback, duplicate writes, focus theft, extended deadlines, lost
// drafts, stale pageshow state and broken native fallback must fail here.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileKitForms,
  formFixtures,
  root,
  type FormFixture,
} from "../test/helpers/admin-validation-correction";

const origin = "http://127.0.0.1:18784";
const draftTitle = 'Unsaved <img src=x onerror="window.draftInjected=1"> & friends';
const names = [
  "Hono event new",
  "Kit event new",
  "Hono featured new",
  "Kit featured new",
  "Hono event edit",
  "Kit event edit",
  "Hono featured edit",
  "Kit featured edit",
];
let compiler: Awaited<ReturnType<typeof compileKitForms>>;
let fixtures: FormFixture[];
test.beforeAll(async () => {
  compiler = await compileKitForms();
  fixtures = await formFixtures(compiler, false);
});
test.afterAll(() => compiler?.dispose());

type Post = { path: string; values: Record<string, string> };
async function mount(context: BrowserContext, f: FormFixture, hold = true) {
  const posts: Post[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external request");
      return route.abort("blockedbyclient");
    }
    if (request.method() === "POST") {
      posts.push({
        path: url.pathname,
        values: Object.fromEntries(new URLSearchParams(request.postData() ?? "")),
      });
      if (url.pathname !== f.action || !request.isNavigationRequest()) {
        unexpected.push("non-native or wrong-target write");
        return route.abort("blockedbyclient");
      }
      if (hold) return route.abort("aborted");
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Fixture record</title><p>Native POST received</p>",
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
    if (url.pathname === f.path) return route.fulfill({ contentType: "text/html", body: f.html });
    unexpected.push(url.pathname);
    return route.abort("blockedbyclient");
  });
  return { posts, unexpected };
}

async function prepare(page: Page, f: FormFixture) {
  await page.goto(origin + f.path);
  const values =
    f.kind === "event"
      ? {
          title: draftTitle,
          game: "Chess",
          description: "Keep my\nsecond line <literal>",
          starts_at: "2099-10-01 20:00",
          ends_at: "2099-10-01 22:00",
          timezone: "Europe/London",
          location: "Voice & games",
          capacity: "8",
          recurrence_count: "",
          recurrence_ends_on: "",
        }
      : {
          title: draftTitle,
          body: "Keep my\nfeatured <copy>",
          url: "",
          image_url: "",
          image_alt: "",
          position: "0",
          starts_at: "",
          ends_at: "",
        };
  for (const [field, value] of Object.entries(values)) {
    const control = page.locator(`[data-event-editor] [name="${field}"]`);
    if (await control.count()) await control.fill(value);
  }
  if (f.kind === "event" && f.mode === "new")
    await page.locator('[name="recurrence_frequency"]').selectOption("");
  expect(
    await page
      .locator("[data-event-editor]")
      .evaluate((form: HTMLFormElement) => form.checkValidity()),
  ).toBe(true);
}

function feedback(page: Page) {
  return page.locator('[role="status"], [aria-live="polite"]').filter({
    hasText: /saving|sending|submi|pending|confirm|in progress/i,
  });
}
async function polite(page: Page) {
  const status = feedback(page);
  await expect(status).toHaveCount(1);
  await expect(status).toBeVisible();
  expect(await status.getAttribute("aria-live")).not.toMatch(/assertive|off/);
  expect(await status.getAttribute("role")).not.toBe("alert");
  expect(
    await status.evaluate((el) => !!el.closest('[aria-hidden="true"], [aria-busy="true"]')),
  ).toBe(false);
  await expect(status).not.toHaveText(
    /saved successfully|successfully saved|save failed|failed to save/i,
  );
  return status;
}
async function dirtyGuard(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function submitByKeyboard(page: Page, f: FormFixture) {
  const save = page.getByTestId(f.kind === "event" ? "save-event" : "save-featured");
  await save.focus();
  await page.keyboard.press("Enter");
  return save;
}
async function start(page: Page, f: FormFixture, posts: Post[]) {
  const request = page.waitForEvent("requestfailed", { predicate: (r) => r.method() === "POST" });
  const save = await submitByKeyboard(page, f);
  await request;
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.path).toBe(f.action);
  expect(posts[0]!.values.title).toBe(draftTitle);
  return save;
}
async function frozenPage(context: BrowserContext, f: FormFixture) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-23T12:00:01Z"));
  await prepare(page, f);
  await page.evaluate(() => {
    const cancelled: boolean[] = [];
    Object.defineProperty(window, "saveSubmitCancellations", { value: cancelled });
    // Observe after the island's form handler, without cancelling navigation.
    // This closes the network-delivery race when checking a blocked repeat.
    document.addEventListener("submit", (event) => {
      if ((event.target as Element).matches("[data-event-editor]"))
        cancelled.push(event.defaultPrevented);
    });
  });
  return page;
}

for (const name of names) {
  test(`${name}: pending and repeated keyboard Save explain one native write without moving focus`, async ({
    browser,
  }) => {
    const f = fixtures.find((row) => row.name === name)!;
    const context = await browser.newContext();
    const h = await mount(context, f);
    try {
      const page = await frozenPage(context, f);
      await expect(feedback(page)).toBeHidden();
      const save = await start(page, f, h.posts);
      await expect(save).toBeFocused();
      await expect(await polite(page)).toContainText(
        /saving|sending|submitting|pending|in progress/i,
      );
      await expect(page.locator("[data-event-editor]")).toHaveAttribute("aria-busy", "true");
      await page.keyboard.press("Enter");
      expect(await page.evaluate("window.saveSubmitCancellations")).toEqual([false, true]);
      await expect(await polite(page)).toContainText(/already|still|pending|in progress/i);
      await expect(save).toBeFocused();
      expect(h.posts).toHaveLength(1);
      expect(h.unexpected).toEqual([]);
      await expect(page.locator('[name="title"]')).toHaveValue(draftTitle);
      expect(await page.evaluate("window.draftInjected")).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  test(`${name}: repeat at 9 seconds cannot extend the exact 10-second uncertainty bound or resend`, async ({
    browser,
  }) => {
    const f = fixtures.find((row) => row.name === name)!;
    const context = await browser.newContext();
    const h = await mount(context, f);
    try {
      const page = await frozenPage(context, f);
      const save = await start(page, f, h.posts);
      await page.clock.runFor(9_000);
      await page.keyboard.press("Enter");
      expect(await page.evaluate("window.saveSubmitCancellations")).toEqual([false, true]);
      await page.clock.runFor(999);
      await expect(page.locator("[data-event-editor]")).toHaveAttribute("aria-busy", "true");
      await page.clock.runFor(1);
      const status = await polite(page);
      await expect(status).toContainText(
        /not (?:yet )?confirmed|isn.t confirmed|unconfirmed|cannot confirm|could not confirm|can.t confirm|unable to confirm|may have (?:been )?saved/i,
      );
      await expect(status).toContainText(/check|review|open/i);
      await expect(status).toContainText(/record|event|featured|saved/i);
      await expect(status).toContainText(/before.*(?:resubmi|sav(?:e|ing)|try|retry)/i);
      expect(await page.locator("[data-event-editor]").getAttribute("aria-busy")).not.toBe("true");
      await expect(save).toBeFocused();
      await expect(page.locator('[name="title"]')).toHaveValue(draftTitle);
      expect(await dirtyGuard(page)).toBe(true);
      await page.clock.runFor(60_000);
      expect(h.posts).toHaveLength(1);
      expect(h.unexpected).toEqual([]);
      expect(
        await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
      ).toEqual({ local: 0, session: 0 });
    } finally {
      await context.close();
    }
  });

  test(`${name}: pageshow clears pending and uncertain feedback but keeps newer dirty input`, async ({
    browser,
  }) => {
    const f = fixtures.find((row) => row.name === name)!;
    const context = await browser.newContext();
    const h = await mount(context, f);
    try {
      const page = await frozenPage(context, f);
      await start(page, f, h.posts);
      await polite(page);
      await page.locator('[name="title"]').fill("Newer input while saving");
      await submitByKeyboard(page, f);
      expect(await page.evaluate("window.saveSubmitCancellations")).toEqual([false, true]);
      expect(h.posts).toHaveLength(1);
      expect(await dirtyGuard(page)).toBe(true);
      for (const elapsed of [0, 10_000]) {
        if (elapsed) {
          await page.evaluate(() =>
            document.querySelector<HTMLFormElement>("[data-event-editor]")!.requestSubmit(),
          );
          await page.clock.runFor(elapsed);
          await polite(page);
        }
        await page.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
        );
        await expect(feedback(page)).toBeHidden();
        expect(await page.locator("[data-event-editor]").getAttribute("aria-busy")).not.toBe(
          "true",
        );
        await expect(page.locator('[name="title"]')).toHaveValue("Newer input while saving");
        expect(await dirtyGuard(page)).toBe(true);
        await page.clock.runFor(10_000);
        await expect(feedback(page)).toBeHidden();
      }
    } finally {
      await context.close();
    }
  });

  for (const javaScriptEnabled of [false, true]) {
    test(`${name}: native keyboard submission sends the draft once, JS=${javaScriptEnabled}`, async ({
      browser,
    }) => {
      const f = fixtures.find((row) => row.name === name)!;
      const context = await browser.newContext({ javaScriptEnabled });
      const h = await mount(context, f, false);
      try {
        const page = await context.newPage();
        await prepare(page, f);
        const response = page.waitForNavigation();
        await submitByKeyboard(page, f);
        expect((await response)?.status()).toBe(200);
        expect(h.posts).toHaveLength(1);
        expect(h.posts[0]!.path).toBe(f.action);
        expect(h.posts[0]!.values.title).toBe(draftTitle);
        expect(h.unexpected).toEqual([]);
        await expect(page.getByText("Native POST received")).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }
}

for (const name of ["Hono event edit", "Kit featured edit"]) {
  test(`${name}: session expiry preserves its recovery alert and dirty guard through the save deadline`, async ({
    browser,
  }) => {
    const f = fixtures.find((row) => row.name === name)!;
    const context = await browser.newContext();
    const h = await mount(context, f);
    try {
      const page = await frozenPage(context, f);
      await start(page, f, h.posts);
      const vetoed = await page.evaluate(() => {
        const event = new CustomEvent("two:session-expired", {
          cancelable: true,
          detail: { recoveryUrl: "/auth/recover?next=%2Fadmin" },
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(vetoed).toBe(true);
      const alert = page.getByTestId("admin-session-expired");
      await expect(alert).toBeVisible();
      await expect(alert).toBeFocused();
      await expect(alert.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
        "href",
        "/auth/recover?next=%2Fadmin",
      );
      await page.clock.runFor(10_000);
      await expect(alert).toBeVisible();
      await expect(alert).toBeFocused();
      await expect(page.locator('[name="title"]')).toHaveValue(draftTitle);
      expect(await dirtyGuard(page)).toBe(true);
      expect(h.posts).toHaveLength(1);
      expect(h.unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
