// Acceptance-owned: native browser behavior over real Hono route/model and
// compiled Kit load/SSR. All browser IO is intercepted; fixtures only.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  editorial,
  fixture,
  renderers,
  type Renderer,
} from "../test/helpers/featured-reuse-fixture";

const origin = "http://127.0.0.1:18784";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function mount(context: BrowserContext, f: Fixture, renderer: Renderer) {
  const posts: { path: string; values: Record<string, string>; status: number }[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/islands/") || url.pathname.endsWith(".css")) {
      const asset = path.resolve("public", url.pathname.slice(1));
      if (!asset.startsWith(path.resolve("public") + path.sep)) return route.abort();
      try {
        return await route.fulfill({
          contentType: asset.endsWith(".css") ? "text/css" : "text/javascript",
          body: await readFile(asset),
        });
      } catch {
        return route.fulfill({ status: 404, body: "No fixture asset" });
      }
    }
    if (url.pathname === "/auth/status") return route.fulfill({ status: 204 });
    let response: Response;
    if (request.method() === "POST") {
      const values = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
      response = await f.post(url.pathname + url.search, values);
      posts.push({ path: url.pathname, values, status: response.status });
    } else if (request.method() === "GET")
      response = await f.get(renderer, url.pathname + url.search);
    else return route.abort("blockedbyclient");
    // Intercepted redirect hops are not re-intercepted by Chromium. Follow
    // same-origin locations through the fixture rather than touching a server.
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get("location")!, f.origin);
      if (target.origin !== f.origin) return route.abort("blockedbyclient");
      response = await f.get(renderer, target.pathname + target.search);
    }
    return route.fulfill({
      status: response.status,
      contentType: "text/html; charset=utf-8",
      body: await response.text(),
    });
  });
  return posts;
}
async function tabTo(page: Page, selector: string) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(`FR-KEYBOARD unreachable native control: ${selector}`);
}

for (const renderer of renderers) {
  test(`FR-B-C01 ${renderer} ordinary empty form creates by keyboard without JavaScript`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const f = await fixture(undefined, origin);
      const posts = await mount(context, f, renderer);
      const page = await context.newPage();
      await page.goto(origin + "/admin/featured/new");
      await tabTo(page, '[name="title"]');
      await page.keyboard.type("Keyboard-only fresh slot");
      await tabTo(page, '[data-testid="save-featured"]');
      await page.keyboard.press("Enter");
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toMatchObject({
        path: "/admin/featured",
        status: 303,
        values: { title: "Keyboard-only fresh slot", position: "0", starts_at: "", ends_at: "" },
      });
      expect(posts[0]!.values).not.toHaveProperty("is_published");
      expect(f.created()?.createdBy).toBe(f.actorId);
      expect(f.source()?.title).toBe(editorial.title);
    } finally {
      await context.close();
    }
  });

  test(`FR-B01 ${renderer} saved reuse link is keyboard reachable without JavaScript`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const f = await fixture(undefined, origin);
      await mount(context, f, renderer);
      const page = await context.newPage();
      await page.goto(origin + "/admin/featured/41");
      const link = page.getByRole("link", { name: /reuse as (?:a )?new slot/i });
      await expect(link, "FR-B01 missing-link: render a native reuse link").toHaveCount(1);
      const href = await link.getAttribute("href");
      await tabTo(page, `a[href=${JSON.stringify(href)}]`);
      await page.keyboard.press("Enter");
      await expect(page.locator('[name="title"]')).toHaveValue(editorial.title);
      await expect(page.locator('[name="is_published"]')).not.toBeChecked();
      const values = await page
        .locator('form[action="/admin/featured"]')
        .evaluate((form) => Object.fromEntries(new FormData(form as HTMLFormElement)));
      expect(values).toMatchObject({ ...editorial, position: "0", starts_at: "", ends_at: "" });
      expect(values).not.toHaveProperty("is_published");
      expect(f.writes()).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`FR-B02 ${renderer} prefill recovery rejected states at ${viewport.width}x${viewport.height}`, async ({
      browser,
    }, info) => {
      const context = await browser.newContext({ viewport });
      try {
        const f = await fixture(undefined, origin);
        const url = await f.reuseUrl(renderer);
        await mount(context, f, renderer);
        const page = await context.newPage();
        await page.goto(new URL(url, origin).href);
        await page.screenshot({
          path: info.outputPath(`${renderer}-${viewport.width}-prefill.png`),
          fullPage: true,
        });
        await expect
          .soft(
            page.locator('[name="title"]'),
            "FR-B02 missing-prefill: expected saved editorial draft",
          )
          .toHaveValue(editorial.title);
        await expect.soft(page.locator('[name="is_published"]')).not.toBeChecked();
        expect.soft(await page.locator("body").innerText()).toMatch(/unsaved|not (?:yet )?saved/i);
        expect
          .soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        expect(f.writes()).toHaveLength(0);

        f.removeSource();
        const missing = await f.get(renderer, url);
        const redirectsToEmpty =
          [302, 303].includes(missing.status) &&
          new URL(missing.headers.get("location")!, origin).href === origin + "/admin/featured/new";
        await page.goto(new URL(url, origin).href);
        await page.screenshot({
          path: info.outputPath(`${renderer}-${viewport.width}-recovery.png`),
          fullPage: true,
        });
        const recovery = page.locator('a[href$="/admin/featured/new"]');
        if (!redirectsToEmpty)
          await expect
            .soft(recovery, "FR-B02 missing-recovery: offer the ordinary empty form")
            .toHaveCount(1);
        if (!(await page.locator('[name="title"]').count()) && (await recovery.count()) === 1)
          await recovery.click();
        await expect.soft(page.locator('[name="title"]')).toHaveValue("");
        expect(f.writes()).toHaveLength(0);

        // Drive the existing native POST validator to capture the actual 422,
        // not a test-built error document, even on the pre-feature baseline.
        await page.locator('[name="title"]').fill("Moderator's unsaved draft");
        await page
          .locator('[name="image_url"]')
          .fill("https://retired-images.example.org/card.png");
        await page.locator('[name="image_alt"]').fill("The draft image description");
        await page.getByTestId("save-featured").click();
        await expect(page.locator('[name="image_url"]')).toHaveAttribute("aria-invalid", "true");
        await page.screenshot({
          path: info.outputPath(`${renderer}-${viewport.width}-rejected.png`),
          fullPage: true,
        });
        await expect(page.locator('[name="title"]')).toHaveValue("Moderator's unsaved draft");
        expect(
          await page.locator('form[action="/admin/featured"]').getAttribute("data-event-draft"),
        ).not.toBeNull();
        expect(f.writes()).toHaveLength(0);
      } finally {
        await context.close();
      }
    });
  }

  test(`FR-B03 ${renderer} changing a reused draft triggers a real departure dialog and keeps it on Stay`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const f = await fixture(undefined, origin);
      const url = await f.reuseUrl(renderer);
      await mount(context, f, renderer);
      const page = await context.newPage();
      await page.goto(new URL(url, origin).href);
      await expect
        .soft(
          page.locator('[name="title"]'),
          "FR-B03 missing-prefill: keep reuse content before editing",
        )
        .toHaveValue(editorial.title);
      await page.locator('[name="title"]').click();
      await page.keyboard.type(" revised");
      const draft = await page.locator('[name="title"]').inputValue();
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        await dialog.dismiss();
      });
      // A dismissed reload can remain pending in Chromium. Bound the aborted
      // navigation, not the assertion that the real native dialog occurred.
      await page.reload({ timeout: 5_000 }).catch(() => null);
      expect(dialogs).toEqual(["beforeunload"]);
      await expect(page.locator('[name="title"]')).toHaveValue(draft);
      expect(f.writes()).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
}
