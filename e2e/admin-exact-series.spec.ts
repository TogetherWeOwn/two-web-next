// Acceptance-owned Chromium journeys. Real GET routes/SSR and shipped islands;
// local static assets plus a README-guarded disposable PostgreSQL fixture only.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileSeriesKit,
  createSeriesFixture,
  key,
  reviewName,
  root,
  scopeUrl,
} from "../test/helpers/admin-exact-series.mjs";

let kit: Awaited<ReturnType<typeof compileSeriesKit>>;
let fixture: Awaited<ReturnType<typeof createSeriesFixture>>;
const origin = "https://next.example.test";
test.beforeAll(async () => {
  kit = await compileSeriesKit();
  fixture = await createSeriesFixture();
});
test.afterAll(async () => {
  await fixture?.dispose();
  kit?.dispose();
});

async function mount(context: BrowserContext, twin: string, draft = false) {
  const writes: string[] = [];
  const foreign: string[] = [];
  // The real root layout imports app.css. Leaf SSR retains its own head, and
  // this fixture supplies that build-generated root stylesheet (as Kit does).
  const manifest =
    twin === "Kit"
      ? JSON.parse(
          readFileSync(join(root, "web/.svelte-kit/output/client/.vite/manifest.json"), "utf8"),
        )
      : {};
  const rootCss: string[] = Object.values(manifest).flatMap((entry) => {
    const item = entry as { name?: string; css?: string[] };
    return item.name === "nodes/0" ? (item.css ?? []) : [];
  });
  if (twin === "Kit" && rootCss.length === 0)
    throw new Error("Build Kit before running the browser fixture");
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      foreign.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (request.method() !== "GET") {
      writes.push(request.method() + " " + url.pathname);
      return route.fulfill({ status: 405, body: "Read-only fixture" });
    }
    if (url.pathname.startsWith("/_app/immutable/assets/") && url.pathname.endsWith(".css")) {
      const builtRoot = join(root, "web/.svelte-kit/output/client/");
      const cssPath = resolve(builtRoot, url.pathname.slice(1));
      if (cssPath.startsWith(builtRoot) && existsSync(cssPath))
        return route.fulfill({ contentType: "text/css", body: readFileSync(cssPath) });
      return route.fulfill({ status: 404, body: "Missing built stylesheet" });
    }
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      /\.(?:js|css|woff2|png|svg)$/.test(asset)
    ) {
      const contentType = asset.endsWith(".js")
        ? "text/javascript"
        : asset.endsWith(".css")
          ? "text/css"
          : asset.endsWith(".svg")
            ? "image/svg+xml"
            : asset.endsWith(".woff2")
              ? "font/woff2"
              : "image/png";
      return route.fulfill({ contentType, body: readFileSync(asset) });
    }
    if (url.pathname.startsWith("/admin/events")) {
      const result =
        draft && url.pathname === `/admin/events/${key(101)}`
          ? await fixture.rejectedDraft(101)
          : await fixture.request(twin, kit, url.pathname + url.search);
      const html =
        twin === "Kit" && !draft
          ? result.html.replace(
              "</head>",
              rootCss.map((css) => `<link rel="stylesheet" href="/${css}">`).join("") + "</head>",
            )
          : result.html;
      return route.fulfill({
        status: result.status,
        contentType: "text/html; charset=utf-8",
        body: html,
      });
    }
    return route.fulfill({ status: 404, body: "No external fixture" });
  });
  return { writes, foreign };
}
async function tabTo(page: Page, href: string) {
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate(
        (expected) => document.activeElement?.getAttribute("href") === expected,
        href,
      )
    )
      return;
  }
  throw new Error(`Tab could not reach ${href}`);
}
async function guardsDeparture(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

for (const twin of ["Hono", "Kit"]) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const label = `${twin} ${viewport.width}`;
    for (const javaScriptEnabled of [false, true]) {
      test(`${label}: keyboard editor-to-inventory and native filter/paging, JS=${javaScriptEnabled}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport, javaScriptEnabled });
        try {
          const observed = await mount(context, twin);
          const page = await context.newPage();
          await page.goto(origin + `/admin/events/${key(101)}`);
          await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Renamed occurrence");
          const action = page.getByRole("link", { name: reviewName, exact: true });
          expect(await action.count(), "saved child needs the accessible series action").toBe(1);
          const href = (await action.getAttribute("href"))!;
          await tabTo(page, href);
          await page.keyboard.press("Enter");
          await expect(page.getByRole("heading", { level: 1 })).toContainText(/series/i);
          const rows = page.getByTestId("events-table").locator("tbody tr");
          await expect(rows).toHaveCount(25);
          await expect(page.getByTestId(`event-status-${key(100)}`)).toHaveText("draft");
          await expect(page.getByTestId(`event-status-${key(103)}`)).toHaveText("cancelled");
          await page.getByRole("link", { name: "Next", exact: true }).click();
          await expect(rows).toHaveCount(5);
          expect(new URL(page.url()).searchParams.has("series_event")).toBe(true);
          await page.getByLabel("Status", { exact: true }).selectOption("draft");
          await page.getByRole("button", { name: "Filter", exact: true }).click();
          await expect(rows).toHaveCount(9);
          expect(new URL(page.url()).searchParams.has("series_event")).toBe(true);
          expect(new URL(page.url()).searchParams.has("page")).toBe(false);
          await page.getByLabel("Status", { exact: true }).selectOption("");
          await page.getByRole("button", { name: "Filter", exact: true }).click();
          await expect(rows).toHaveCount(25);
          await expect(page.getByTestId(`event-status-${key(200)}`)).toHaveCount(0);
          const escape = page.getByRole("link", { name: "All events", exact: true });
          expect(await escape.count()).toBe(1);
          await escape.click();
          expect(new URL(page.url()).searchParams.has("series_event")).toBe(false);
          expect(observed.writes).toEqual([]);
          expect(observed.foreign).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
    test(`${label}: dirty editor keeps the saved scope, cancellation retains unsaved values`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      try {
        const observed = await mount(context, twin);
        const page = await context.newPage();
        const editor = origin + `/admin/events/${key(101)}`;
        await page.goto(editor);
        expect(await guardsDeparture(page)).toBe(false);
        await page.getByLabel("Title", { exact: true }).fill("UNSAVED same-title decoy");
        expect(await guardsDeparture(page)).toBe(true);
        const action = page.getByRole("link", { name: reviewName, exact: true });
        expect(await action.count()).toBe(1);
        const href = (await action.getAttribute("href"))!;
        expect([key(100), key(101)]).toContain(
          new URL(href, origin).searchParams.get("series_event"),
        );
        let departures = 0;
        page.once("dialog", async (dialog) => {
          departures++;
          await dialog.dismiss();
        });
        await action.click();
        expect(departures).toBe(1);
        expect(page.url()).toBe(editor);
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
          "UNSAVED same-title decoy",
        );
        expect(await guardsDeparture(page)).toBe(true);
        expect(observed.writes).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test(`${label}: rejected native draft remains dirty; review action names saved occurrences`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      try {
        await mount(context, twin, true);
        const page = await context.newPage();
        await page.goto(origin + `/admin/events/${key(101)}`);
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue("UNSAVED other series");
        expect(await guardsDeparture(page)).toBe(true);
        const action = page.getByRole("link", { name: reviewName, exact: true });
        expect(await action.count()).toBe(1);
        expect([key(100), key(101)]).toContain(
          new URL((await action.getAttribute("href"))!, origin).searchParams.get("series_event"),
        );
        await expect(page.locator("main")).toContainText(
          /\bsaved (?:occurrences|series|version|events|data|state)\b/i,
        );
      } finally {
        await context.close();
      }
    });
    test(`${label}: CONTROL standalone has no misleading review action and ordinary dirty guard works`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      try {
        const observed = await mount(context, twin);
        const page = await context.newPage();
        await page.goto(origin + `/admin/events/${key(300)}`);
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
          "Saved <night> & friends",
        );
        await expect(page.getByRole("link", { name: reviewName, exact: true })).toHaveCount(0);
        expect(await guardsDeparture(page)).toBe(false);
        await page.getByLabel("Title", { exact: true }).fill("Unsaved standalone");
        expect(await guardsDeparture(page)).toBe(true);
        expect(observed.writes).toEqual([]);
        expect(observed.foreign).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test(`${label}: CONTROL native classification filters and page links work by keyboard without JS`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport, javaScriptEnabled: false });
      try {
        const observed = await mount(context, twin);
        const page = await context.newPage();
        await page.goto(origin + "/admin/events");
        const next = page.getByRole("link", { name: "Next", exact: true });
        // Enter the tab sequence at the end of the 25-row table; test native
        // paging, not an arbitrary cap on the preceding row-action tab stops.
        await page.getByTestId("events-table").locator("tbody a").last().focus();
        await tabTo(page, (await next.getAttribute("href"))!);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\bpage=2(?:&|$)/);
        expect(new URL(page.url()).searchParams.get("page")).toBe("2");
        await page.getByLabel("Series", { exact: true }).selectOption("parent");
        await page.getByRole("button", { name: "Filter", exact: true }).focus();
        await page.keyboard.press("Enter");
        const rows = page.getByTestId("events-table").locator("tbody tr");
        await expect(rows).toHaveCount(2);
        await expect(page.getByTestId(`event-status-${key(100)}`)).toHaveText("draft");
        await expect(page.getByTestId(`event-status-${key(200)}`)).toHaveText("published");
        expect(new URL(page.url()).searchParams.has("page")).toBe(false);
        expect(observed.writes).toEqual([]);
        expect(observed.foreign).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test(`${label}: fixture screenshot evidence and explicit scoped recovery, no JS`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({ viewport, javaScriptEnabled: false });
      try {
        await mount(context, twin);
        const page = await context.newPage();
        // Screenshots use real rendered routes even on the missing-behavior
        // baseline. These are evidence attachments, never accepted baselines.
        for (const [state, path] of [
          ["saved-parent", `/admin/events/${key(100)}`],
          ["saved-child", `/admin/events/${key(101)}`],
          ["standalone", `/admin/events/${key(300)}`],
          ["inventory", scopeUrl()],
          ["second-page", scopeUrl(100, "page=2")],
          ["filtered-empty", scopeUrl(100, "q=not-present")],
          ["invalid-scope", "/admin/events?series_event=invalid"],
        ]) {
          await page.goto(origin + path);
          const shot = await page.screenshot({ fullPage: true, animations: "disabled" });
          await testInfo.attach(`${process.env.EXACT_SERIES_PHASE ?? "before"}-${state}`, {
            body: shot,
            contentType: "image/png",
          });
        }
        expect(
          await page
            .getByTestId("events-table")
            .locator("tbody tr [data-testid^='event-status-']")
            .count(),
        ).toBe(0);
        expect(await page.getByRole("link", { name: "All events", exact: true }).count()).toBe(1);
      } finally {
        await context.close();
      }
    });
  }
}
