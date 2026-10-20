// Native fixture proof for the saved-event review acceptance. Runs in the
// existing Playwright spec path, never in browser-less Vitest CI jobs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  FIELDS,
  KEY,
  ORIGIN,
  UPDATED,
  root,
  savedEventFixture,
} from "../test/helpers/saved-event-review-fixture.mjs";

test.describe.configure({ mode: "default" });
let fixture: Awaited<ReturnType<typeof savedEventFixture>>;

test.beforeAll(async () => {
  fixture = await savedEventFixture();
});
test.afterAll(async () => {
  await fixture?.dispose();
});
test.beforeEach(async () => {
  await fixture.reset();
  await fixture.seed();
});

async function mount(page: Page, html: string) {
  // Both SSR presentations use the shared served editor island. Exercise that
  // real binder, not a fake dirty-state implementation or a Kit hydration claim.
  const document =
    html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "") +
    '<script src="/islands/admin-event-editor.js"></script>';
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname === `/admin/events/${KEY}`) {
      await route.fulfill({ status: 200, contentType: "text/html", body: document });
    } else if (url.origin === ORIGIN && url.pathname === "/islands/admin-event-editor.js") {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: readFileSync(join(root, "public/islands/admin-event-editor.js"), "utf8"),
      });
    } else {
      await route.fulfill({ status: 404, body: "fixture only" });
    }
  });
  await page.goto(`${ORIGIN}/admin/events/${KEY}`);
}
const link = (page: Page) =>
  page.locator(`a[href="/events/${KEY}"]`).filter({ hasText: /review|preview/i });

for (const engine of ["Hono", "Kit"]) {
  for (const javaScriptEnabled of [false, true]) {
    test.describe(`${engine} saved review, JavaScript ${javaScriptEnabled}`, () => {
      test.use({ javaScriptEnabled });
      test("unsaved edits cannot alter the saved link, provenance or separate Publish payload", async ({
        page,
      }) => {
        const response = await fixture.editorResponse(engine);
        expect(response.status).toBe(200);
        await mount(page, await response.text());
        await page.locator('[name="title"]').fill("UNSAVED private title");
        await page.locator('[name="location"]').fill("");
        expect(await link(page).count(), "missing saved-record review action").toBe(1);
        await expect(link(page)).toHaveAttribute("href", `/events/${KEY}`);
        const section = link(page).locator("xpath=ancestor::*[self::section or self::aside][1]");
        await expect(section).toContainText(/unsaved|not (?:yet )?saved/i);
        await expect(section.locator(`time[datetime="${UPDATED.toISOString()}"]`)).toHaveCount(1);
        await expect(section).not.toContainText("UNSAVED private title");
        // Actual native form serialization with JS off or on: no unsaved title
        // or location can travel in the separate status form.
        await expect(
          page.locator(
            `form[action$="/publish"] [name="title"], form[action$="/publish"] [name="location"]`,
          ),
        ).toHaveCount(0);
        // Capture a real browser form POST locally, without invoking a write.
        let submitted: string | undefined;
        await page.route(`**/admin/events/${KEY}/publish`, async (route) => {
          submitted = route.request().postData() ?? "";
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "Captured fixture publish",
          });
        });
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator('form[action$="/publish"] button').click();
        await expect.poll(() => submitted).not.toBeUndefined();
        const payload = new URLSearchParams(submitted);
        expect(payload.has("title")).toBe(false);
        expect(payload.has("location")).toBe(false);
        expect(await fixture.stored()).toMatchObject({
          title: FIELDS.title,
          location: FIELDS.location,
          status: "draft",
        });
      });
    });
  }
  test.describe(`${engine} shared browser island`, () => {
    test.use({ javaScriptEnabled: true });
    test("dirty review departure remains protected when the moderator stays", async ({ page }) => {
      const response = await fixture.editorResponse(engine);
      expect(response.status).toBe(200);
      await mount(page, await response.text());
      await page.locator('[name="title"]').fill("UNSAVED navigation draft");
      // Synthetic beforeunload avoids native prompt suppression on fixture pages;
      // the actual shipped listener still decides whether departure is guarded.
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          (globalThis as unknown as { dispatchEvent: (event: Event) => boolean }).dispatchEvent(
            event,
          );
          return event.defaultPrevented;
        }),
      ).toBe(true);
      await expect(page.locator('[name="title"]')).toHaveValue("UNSAVED navigation draft");
      expect(await fixture.stored()).toMatchObject({ status: "draft" });
    });
  });
}

test("rejected Save restores the draft while preview still identifies the saved record", async ({
  page,
}) => {
  const before = await fixture.stored();
  const response = await fixture.post(`/events/${KEY}`, {
    ...FIELDS,
    title: "Rejected draft title",
    ends_at: "bad date",
    location: "UNSAVED location",
  });
  expect(response.status).toBe(422);
  await mount(page, await response.text());
  await expect(page.locator('[name="title"]')).toHaveValue("Rejected draft title");
  await expect(page.locator('[name="location"]')).toHaveValue("UNSAVED location");
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      (globalThis as unknown as { dispatchEvent: (event: Event) => boolean }).dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  expect(await fixture.stored()).toEqual(before);
  expect(await link(page).count(), "missing saved-record review action").toBe(1);
  const section = link(page).locator("xpath=ancestor::*[self::section or self::aside][1]");
  await expect(section.locator(`time[datetime="${UPDATED.toISOString()}"]`)).toHaveCount(1);
  await expect(section).not.toContainText("UNSAVED location");
});
