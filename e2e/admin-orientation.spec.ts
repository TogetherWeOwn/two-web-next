// TEST AUTHOR OWNED. Real app SSR and shipped assets, intercepted local fixtures.
// Included by the normal CI *.spec.ts inventory; the companion fixture config
// also runs this suite locally without starting Wrangler or weakening a gate.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileOrientation, orientationForms } from "../test/helpers/admin-orientation";
import { root, type FormFixture } from "../test/helpers/admin-validation-correction";

let forms: FormFixture[];
test.beforeAll(async () => {
  forms = await orientationForms(await compileOrientation());
});
const origin = "http://127.0.0.1:18789";
const names = [
  "Hono event new",
  "Kit event new",
  "Hono event edit",
  "Kit event edit",
  "Hono featured new",
  "Kit featured new",
  "Hono featured edit",
  "Kit featured edit",
];
const parentFor = (f: FormFixture) => (f.kind === "event" ? "/admin/events" : "/admin/featured");

async function mount(context: BrowserContext, f: FormFixture) {
  const posts: { path: string; title: string | null }[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (req.method() === "POST") {
      posts.push({
        path: url.pathname,
        title: new URLSearchParams(req.postData() ?? "").get("title"),
      });
      return route.fulfill({ contentType: "text/html", body: "<h1>Native save received</h1>" });
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      (url.pathname.endsWith(".css") || url.pathname.startsWith("/islands/")) &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset)
    ) {
      return route.fulfill({
        contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        body: readFileSync(asset),
      });
    }
    if (url.pathname === f.path) return route.fulfill({ contentType: "text/html", body: f.html });
    if (url.pathname === parentFor(f))
      return route.fulfill({ contentType: "text/html", body: "<h1>Parent list fixture</h1>" });
    return route.fulfill({ status: 404, body: "No external fixture" });
  });
  return posts;
}

async function upperLink(page: Page, parent: string): Promise<Locator> {
  const links = page.locator(`main a[href="${parent}"]`);
  const indices = await links.evaluateAll((nodes) => {
    const field = document.querySelector(
      'main input:not([type="hidden"]),main textarea,main select',
    );
    return nodes.flatMap((node, index) =>
      field && node.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
        ? [index]
        : [],
    );
  });
  expect(
    indices,
    "a header link or bottom Cancel cannot satisfy the upper-page journey",
  ).toHaveLength(1);
  const link = links.nth(indices[0]!);
  await expect(link).toBeVisible();
  expect(
    ((await link.getAttribute("aria-label")) ?? (await link.textContent()))?.trim(),
  ).toBeTruthy();
  return link;
}

async function tabTo(page: Page, link: Locator) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await link.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error("Upper parent link is not reachable by Tab");
}

for (const name of names) {
  for (const javaScriptEnabled of [false, true]) {
    test(`AO-12 ${name}: native upper navigation works by keyboard, JS=${javaScriptEnabled}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const f = forms.find((row) => row.name === name)!;
        const posts = await mount(context, f);
        const page = await context.newPage();
        const dialogs: string[] = [];
        page.on("dialog", async (dialog) => {
          dialogs.push(dialog.type());
          await dialog.dismiss();
        });
        await page.goto(origin + f.path);
        const link = await upperLink(page, parentFor(f));
        await tabTo(page, link);
        await Promise.all([page.waitForURL(origin + parentFor(f)), page.keyboard.press("Enter")]);
        await expect(page.getByRole("heading", { name: "Parent list fixture" })).toBeVisible();
        expect(dialogs).toEqual([]);
        expect(posts).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test(`AO-13 ${name}: dirty upper departure prompts; staying preserves the draft; accepting leaves`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const f = forms.find((row) => row.name === name)!;
      const posts = await mount(context, f);
      const page = await context.newPage();
      const dialogs: string[] = [];
      let accept = false;
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      });
      await page.goto(origin + f.path);
      const link = await upperLink(page, parentFor(f));
      const title = page.locator('input[name="title"]');
      await title.fill("Keep this unsaved draft");
      await title.pressSequentially("!"); // Real user activation for beforeunload.
      await link.click();
      expect(dialogs).toEqual(["beforeunload"]);
      expect(page.url()).toBe(origin + f.path);
      expect(await title.inputValue()).toBe("Keep this unsaved draft!");
      expect(posts).toEqual([]);
      accept = true;
      await Promise.all([page.waitForURL(origin + parentFor(f)), link.click()]);
      expect(dialogs).toEqual(["beforeunload", "beforeunload"]);
      expect(posts).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`AO-14 CONTROL ${name}: a dirty native Save is exempt, posts once, and retains its action`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const f = forms.find((row) => row.name === name)!;
      const posts = await mount(context, f);
      const page = await context.newPage();
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        await dialog.dismiss();
      });
      await page.goto(origin + f.path);
      const values =
        f.kind === "event"
          ? {
              title: "A saved draft",
              starts_at: "2030-01-01 20:00",
              ends_at: "2030-01-01 22:00",
              timezone: "UTC",
            }
          : { title: "A saved draft" };
      for (const [field, value] of Object.entries(values))
        await page.locator(`[name="${field}"]`).fill(value);
      await page.locator('[name="title"]').press("End");
      await page.locator('[name="title"]').pressSequentially("!");
      await page.getByTestId(f.kind === "event" ? "save-event" : "save-featured").click();
      await expect(page.getByRole("heading", { name: "Native save received" })).toBeVisible();
      expect(dialogs).toEqual([]);
      expect(posts).toEqual([{ path: f.action, title: "A saved draft!" }]);
    } finally {
      await context.close();
    }
  });

  test(`AO-15 CONTROL ${name}: a dirty existing Cancel still prompts`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const f = forms.find((row) => row.name === name)!;
      await mount(context, f);
      const page = await context.newPage();
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        await dialog.dismiss();
      });
      await page.goto(origin + f.path);
      const title = page.locator('[name="title"]');
      await title.fill("Keep draft");
      await title.pressSequentially("!");
      await page.getByRole("link", { name: "Cancel", exact: true }).click();
      expect(dialogs).toEqual(["beforeunload"]);
      expect(await title.inputValue()).toBe("Keep draft!");
    } finally {
      await context.close();
    }
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`AO-16 ${name}: upper link and selected section are visible and bounded at ${viewport.width}px`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      try {
        const f = forms.find((row) => row.name === name)!;
        await mount(context, f);
        const page = await context.newPage();
        await page.goto(origin + f.path);
        const link = await upperLink(page, parentFor(f));
        const box = await link.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box!.y + box!.height).toBeLessThan(viewport.height);
        const current = page.locator('header a[aria-current]:not([aria-current="false"])');
        expect(await current.count()).toBe(1);
        await expect(current).toBeVisible();
        expect(await current.getAttribute("href")).toBe(parentFor(f));
        expect(await current.getAttribute("aria-current")).not.toBe("page");
        const signature = (node: Element) => {
          const s = getComputedStyle(node);
          return [
            s.color,
            s.backgroundColor,
            s.fontWeight,
            s.borderBottom,
            s.textDecorationLine,
            s.outline,
          ].join("|");
        };
        const plain = page.locator('header nav a[href="/"]');
        expect(
          await current.evaluate(signature),
          "the selected section must be visibly distinguishable, not semantics only",
        ).not.toBe(await plain.evaluate(signature));
      } finally {
        await context.close();
      }
    });
  }
}
