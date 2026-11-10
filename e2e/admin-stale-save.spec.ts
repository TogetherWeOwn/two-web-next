// Real renderer/shipped-island fixtures, no external requests or SQL. The real
// guarded route and committing-lock behavior are tested separately in Vitest.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventFormPage, FeaturedFormPage } from "../src/admin/pages";
import { eventSaveBaseline, featuredSaveBaseline } from "../src/admin/save-baseline";
import { parseEventForm, parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { eventRow, featuredRow, root } from "../test/helpers/admin-validation-correction";

type Kind = "event" | "featured";
const origin = "http://127.0.0.1:18785";
const widths = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

function savedValues(kind: Kind, title: string): Record<string, string> {
  return kind === "event"
    ? {
        title,
        game: "Chess",
        description: "Bring snacks.\nA relaxed community night.",
        accessibility_notes: "Step-free entrance.",
        organizer_name: "Community hosts",
        join_url: "",
        join_instructions: "Ask in the games channel.",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
        timezone: "Europe/London",
        location: "Community voice room",
        capacity: "8",
      }
    : {
        title,
        body: "Bring a friend.\nEveryone is welcome.",
        url: "",
        image_url: "",
        image_alt: "",
        is_published: "on",
        position: "0",
        starts_at: "",
        ends_at: "",
      };
}

function fixture(kind: Kind) {
  let title = "Saved community night";
  let version = 0;
  const path =
    kind === "event" ? `/admin/events/${eventRow.eventKey}` : `/admin/featured/${featuredRow.id}`;
  const updatedAt = () => new Date(Date.UTC(2026, 10, 10, 8, 0, version));
  const eventSaved = () => ({ ...eventRow, title, updatedAt: updatedAt() });
  const featuredSaved = () => ({
    ...featuredRow,
    title,
    updatedAt: updatedAt(),
    startsAtText: null,
    endsAtText: null,
  });
  const token = () =>
    kind === "event" ? eventSaveBaseline(eventSaved()) : featuredSaveBaseline(featuredSaved());
  async function render(
    values: Record<string, string>,
    errors: Record<string, string> = {},
    stale = false,
  ) {
    return kind === "event"
      ? await EventFormPage({
          mode: "edit",
          row: eventSaved(),
          values,
          errors,
          rosterHiddenNotice: true,
          saveRefused: stale ? "stale" : undefined,
        })!.toString()
      : await FeaturedFormPage({
          mode: "edit",
          row: featuredSaved(),
          values,
          errors,
          now: new Date("2026-11-10T08:00:00Z"),
          appUrl: origin,
          saveRefused: stale ? "stale" : undefined,
        })!.toString();
  }
  async function mount(context: BrowserContext) {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort("blockedbyclient");
      if (url.pathname === "/auth/status") return route.fulfill({ json: { authenticated: true } });
      if (url.pathname === "/away")
        return route.fulfill({ contentType: "text/html", body: "<p>Another page</p>" });
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
      if (url.pathname !== path) return route.fulfill({ status: 404, body: "No external fixture" });
      if (request.method() === "GET")
        return route.fulfill({
          contentType: "text/html",
          body: await render({ ...savedValues(kind, title), saved_baseline: await token() }),
        });
      const values = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
      const stale = values.saved_baseline !== (await token());
      let errors: Record<string, string> = {};
      try {
        if (kind === "event") parseEventForm(values);
        else parseFeaturedForm(values);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors = error.fields;
      }
      if (stale || Object.keys(errors).length)
        return route.fulfill({
          status: stale ? 409 : 422,
          contentType: "text/html",
          body: await render(values, errors, stale),
        });
      title = values.title!;
      version++;
      return route.fulfill({ status: 303, headers: { location: path }, body: "" });
    });
  }
  return { path, mount };
}

async function submit(page: Page, kind: Kind) {
  const response = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByTestId(kind === "event" ? "save-event" : "save-featured").click();
  return (await response).status();
}
async function capture(page: Page, name: string) {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

for (const kind of ["event", "featured"] as const) {
  for (const viewport of widths) {
    for (const invalid of [false, true]) {
      test(`${kind} ${viewport.width}: retained stale draft, field-errors=${invalid}`, async ({
        browser,
      }) => {
        const f = fixture(kind);
        const first = await browser.newContext({ viewport });
        const second = await browser.newContext({ viewport });
        try {
          await f.mount(first);
          await f.mount(second);
          const a = await first.newPage();
          const b = await second.newPage();
          await a.goto(origin + f.path);
          await b.goto(origin + f.path);
          await capture(b, `${kind}-before-${viewport.width}`);
          const original = await b.locator('[name="saved_baseline"]').inputValue();
          await a.locator('[name="title"]').fill("Winner's saved title");
          expect(await submit(a, kind)).toBe(303);
          await b.locator('[name="title"]').fill("My retained draft");
          if (invalid)
            await b.locator(`[name="${kind === "event" ? "capacity" : "position"}"]`).fill("-1");
          expect(await submit(b, kind)).toBe(409);
          await expect(b.getByTestId("stale-save")).toBeFocused();
          await expect(b.locator('[name="title"]')).toHaveValue("My retained draft");
          await expect(b.locator('[name="saved_baseline"]')).toHaveValue(original);
          await expect(b.locator("[data-admin-validation-summary]")).toHaveCount(1);
          if (invalid)
            await expect(
              b.getByTestId(`error-${kind === "event" ? "capacity" : "position"}`),
            ).toBeVisible();
          await capture(b, `${kind}-stale-${invalid ? "errors" : "valid"}-${viewport.width}`);
          expect(await submit(b, kind)).toBe(409);
          const opened = b.waitForEvent("popup");
          await b.getByTestId("stale-open-latest").click();
          const latest = await opened;
          await expect(latest.locator('[name="title"]')).toHaveValue("Winner's saved title");
          await expect(latest.getByTestId("stale-save")).toHaveCount(0);
          expect(await latest.locator('[name="saved_baseline"]').inputValue()).not.toBe(original);
          await capture(latest, `${kind}-fresh-${viewport.width}`);
          await b.evaluate(() =>
            window.dispatchEvent(new CustomEvent("two:session-expired", { cancelable: true })),
          );
          await expect(b.getByTestId("admin-session-expired")).toBeFocused();
          await expect(b.locator('[name="title"]')).toHaveValue("My retained draft");
          expect(
            await b.evaluate(() => {
              const e = new Event("beforeunload", { cancelable: true });
              window.dispatchEvent(e);
              return e.defaultPrevented;
            }),
          ).toBe(true);
        } finally {
          await first.close();
          await second.close();
        }
      });
    }
  }

  test(`${kind}: Back restoration cannot refresh a losing draft's token`, async ({ browser }) => {
    const f = fixture(kind);
    const context = await browser.newContext();
    try {
      await f.mount(context);
      const page = await context.newPage();
      const winner = await context.newPage();
      await page.goto(origin + f.path);
      const original = await page.locator('[name="saved_baseline"]').inputValue();
      await page.locator('[name="title"]').fill("Restored draft");
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(origin + "/away");
      await winner.goto(origin + f.path);
      await winner.locator('[name="title"]').fill("New saved title");
      expect(await submit(winner, kind)).toBe(303);
      await page.goBack();
      // Assert the unsafe restoration explicitly even if this Chromium chooses
      // not to autofill after its no-cache intercepted navigation.
      await page.locator('[name="title"]').fill("Restored draft");
      expect(await submit(page, kind)).toBe(409);
      await expect(page.locator('[name="saved_baseline"]')).toHaveValue(original);
      await expect(page.locator('[name="title"]')).toHaveValue("Restored draft");
    } finally {
      await context.close();
    }
  });

  test(`${kind}: stale recovery works with JavaScript disabled`, async ({ browser }) => {
    const f = fixture(kind);
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await f.mount(context);
      const a = await context.newPage();
      const b = await context.newPage();
      await a.goto(origin + f.path);
      await b.goto(origin + f.path);
      await a.locator('[name="title"]').fill("Winner");
      expect(await submit(a, kind)).toBe(303);
      await b.locator('[name="title"]').fill("No-JavaScript draft");
      expect(await submit(b, kind)).toBe(409);
      await expect(b.locator('[name="title"]')).toHaveValue("No-JavaScript draft");
      const opened = b.waitForEvent("popup");
      await b.getByTestId("stale-open-latest").click();
      await expect((await opened).locator('[name="title"]')).toHaveValue("Winner");
    } finally {
      await context.close();
    }
  });
}

test("current invalid event draft retains the existing 422 presentation", async ({ browser }) => {
  const f = fixture("event");
  const context = await browser.newContext({ viewport: widths[0] });
  try {
    await f.mount(context);
    const page = await context.newPage();
    await page.goto(origin + f.path);
    await page.locator('[name="capacity"]').fill("-1");
    expect(await submit(page, "event")).toBe(422);
    await expect(page.getByTestId("form-errors")).toBeFocused();
    await expect(page.getByTestId("stale-save")).toHaveCount(0);
    await capture(page, "event-current-422-1280");
    await page.setViewportSize(widths[1]!);
    await capture(page, "event-current-422-390");
  } finally {
    await context.close();
  }
});
