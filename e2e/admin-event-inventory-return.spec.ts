// Test Author owned. U3.7: real native navigation and shipped editor island.
// Every request is intercepted; real Hono/Kit fixture documents and public assets.
// Companion route contract: test/admin-event-inventory-return-acceptance.test.ts.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileInventoryReturn,
  editPath,
  inventory,
  origin,
  root,
  rowLink,
  sameInventory,
  type Harness,
} from "../test/helpers/admin-event-inventory-return";

let h: Harness;
test.beforeAll(async () => {
  h = await compileInventoryReturn();
});
test.afterAll(() => h?.dispose());
test.beforeEach(() => h.reset());

async function mount(context: BrowserContext, twin: "Hono" | "Kit") {
  const posts: string[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (request.method() === "POST") {
      posts.push(url.pathname);
      const response = await h.request(url.pathname + url.search, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: request.postData() ?? "",
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        // Follow same-origin redirects server-side, like the node U3.2
        // companion: a fulfilled 303 cannot be followed by the harness because
        // the followed GET is not re-intercepted and fails closed on the dead
        // proxy (see playwright.config.ts). Both twins share this mount; Kit
        // POSTs already route to h.request, and h.document serves the twin.
        const target = new URL(location, origin);
        if (target.origin === origin) {
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: await h.document(twin, target.pathname + target.search),
          });
        }
      }
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      /\.(css|js|woff2|svg|png|ico)$/.test(asset)
    ) {
      const contentType = asset.endsWith(".css")
        ? "text/css"
        : asset.endsWith(".js")
          ? "text/javascript"
          : asset.endsWith(".woff2")
            ? "font/woff2"
            : "image/svg+xml";
      return route.fulfill({ contentType, body: readFileSync(asset) });
    }
    if (url.pathname === "/admin/events" || url.pathname === editPath) {
      return route.fulfill({
        contentType: "text/html",
        body: await h.document(twin, url.pathname + url.search),
      });
    }
    // Auth probe is deliberately offline; it cannot reload or renew a real session.
    return route.fulfill({ status: 404, body: "Fixture only" });
  });
  return { posts, unexpected };
}
async function tabTo(page: Page, href: string, text?: string) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => ({
      href: document.activeElement?.getAttribute("href"),
      text: document.activeElement?.textContent?.trim(),
    }));
    if (active.href === href && (text === undefined || active.text === text)) return;
  }
  throw Error("U3.7_KEYBOARD_RETURN_UNREACHABLE");
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    for (const label of ["Back to these event results", "Cancel"]) {
      test(`${twin} U3.7 keyboard ${label}, JS=${javaScriptEnabled}`, async ({ browser }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          viewport: {
            width: javaScriptEnabled ? 1280 : 390,
            height: javaScriptEnabled ? 800 : 844,
          },
        });
        try {
          const { posts, unexpected } = await mount(context, twin);
          const page = await context.newPage();
          await page.goto(origin + inventory);
          const target = rowLink(await page.content());
          await tabTo(page, target);
          await page.keyboard.press("Enter");
          await expect(page.locator("[data-event-editor]")).toBeVisible();
          const link = page.getByRole("link", { name: label, exact: true });
          await expect(link).toHaveCount(1);
          expect(
            sameInventory(await link.getAttribute("href")),
            "U3.7_NATIVE_RETURN_LOST_ORIGIN",
          ).toBe(true);
          await tabTo(page, (await link.getAttribute("href"))!, label);
          await page.keyboard.press("Enter");
          await expect(page).toHaveURL((url) => sameInventory(url.pathname + url.search));
          expect(posts).toEqual([]);
          expect(unexpected).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  test(`${twin} U3.7 native no-JS Save retains contextual Back after one POST`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const { posts, unexpected } = await mount(context, twin);
      const page = await context.newPage();
      const list = await h.document(twin, inventory);
      await page.goto(origin + rowLink(list));
      await page.locator('[name="title"]').fill("Saved native fixture");
      await page.locator('[data-event-editor] button[type="submit"]').click();
      await expect(page).toHaveURL((url) => url.pathname === editPath);
      expect(posts).toEqual([editPath]);
      expect(h.state.writes.map((write) => write.operation)).toEqual(["save"]);
      const back = page.getByRole("link", { name: "Back to these event results", exact: true });
      await expect(back).toHaveCount(1);
      expect(sameInventory(await back.getAttribute("href")), "U3.7_NATIVE_SAVE_LOST_ORIGIN").toBe(
        true,
      );
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`${twin} U3.7 direct no-JS Cancel still returns to unfiltered inventory`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const { posts, unexpected } = await mount(context, twin);
      const page = await context.newPage();
      await page.goto(origin + editPath);
      await page.getByRole("link", { name: "Cancel", exact: true }).click();
      await expect(page).toHaveURL(origin + "/admin/events");
      expect(posts).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`${twin} U3.7 contextual Cancel remains a dirty-draft departure, not a Save exemption`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      await mount(context, twin);
      const page = await context.newPage();
      const list = await h.document(twin, inventory);
      await page.goto(origin + rowLink(list));
      await page.locator('[name="title"]').fill("Unsaved local draft");
      const guarded = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(guarded).toBe(true);
      const link = page.getByRole("link", { name: "Cancel", exact: true });
      expect(sameInventory(await link.getAttribute("href")), "U3.7_DIRTY_CANCEL_LOST_ORIGIN").toBe(
        true,
      );
    } finally {
      await context.close();
    }
  });

  test(`${twin} U3.7 pending Save suppresses duplicate activation without adding a network retry`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const { posts, unexpected } = await mount(context, twin);
      const page = await context.newPage();
      await page.goto(origin + editPath);
      // Capture submit events without completing navigation: no mocked island,
      // and no mutation whose success could be mistaken for an uncertain save.
      const result = await page.locator("[data-event-editor]").evaluate((form) => {
        const first = new Event("submit", { bubbles: true, cancelable: true });
        const second = new Event("submit", { bubbles: true, cancelable: true });
        form.dispatchEvent(first);
        form.dispatchEvent(second);
        return {
          first: first.defaultPrevented,
          second: second.defaultPrevented,
          busy: form.getAttribute("aria-busy"),
        };
      });
      expect(result).toEqual({ first: false, second: true, busy: "true" });
      expect(posts).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
