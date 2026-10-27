// Fixture-only acceptance, collected by browser-smoke's **/*.spec.ts glob.
// Local: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e calendar-card-scan-acceptance.spec.ts --workers=1
// No opt-in/skip, database, remote page, product helper or replacement island.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTION_LIMIT,
  EVENT_KEY,
  FULL_DESCRIPTION,
  scanEvent,
} from "../test/calendar-card-scan.fixtures";
import { renderCalendar, type CalendarTwin } from "../test/helpers/calendar-multiday-acceptance";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://calendar.example.test";
const nextKey = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

async function mount(context: BrowserContext, twin: CalendarTwin, description = FULL_DESCRIPTION) {
  const documents: string[] = [];
  const fragments: string[] = [];
  const row = scanEvent({ description });
  const next = scanEvent({
    id: 2,
    eventKey: nextKey,
    title: "Next short event",
    description: "Bring a friend.",
    startsAt: new Date("2030-06-03T18:00:00Z"),
    endsAt: new Date("2030-06-03T19:00:00Z"),
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") return route.abort();
    const asset = resolve(root, "public", url.pathname.slice(1));
    const contentType = url.pathname.endsWith(".js")
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".woff2")
          ? "font/woff2"
          : url.pathname.endsWith(".svg")
            ? "image/svg+xml"
            : undefined;
    if (
      contentType &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      statSync(asset).isFile()
    )
      return route.fulfill({ contentType, body: readFileSync(asset) });
    if (url.pathname !== "/events") return route.fulfill({ status: 404, body: "No fixture" });
    const destination = url.pathname + url.search;
    if (request.headers()["x-two-island"] === "events-calendar") fragments.push(destination);
    else documents.push(destination);
    return route.fulfill({
      contentType: "text/html; charset=UTF-8",
      body: await renderCalendar(twin, [row, next], {
        month: url.searchParams.get("month") ?? "2030-06",
        view: url.searchParams.get("view") === "calendar" ? "calendar" : "list",
        loginReturnTo: destination,
      }),
    });
  });
  return { documents, fragments };
}

async function capture(page: Page, name: string) {
  const directory = process.env.CARD_SCAN_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function assertDisclosure(
  page: Page,
  card: Locator,
  description: string,
  evidenceName: string,
) {
  const details = card.locator("details");
  // Fail promptly on base for the actual missing behavior, not a selector timeout.
  expect(await details.count(), "long card needs a native description disclosure").toBe(1);
  const summary = details.locator("summary");
  await expect(summary).toBeVisible();
  expect(await details.getAttribute("open")).toBeNull();
  const collapsed = await card.innerText();
  expect(collapsed).toContain(description.slice(0, 80));
  expect(collapsed).not.toContain("SCAN-END");
  // A bounded excerpt, not the entire description hidden only from AT.
  const prose = [...collapsed.slice(collapsed.indexOf("SCAN-BEGIN"))];
  const original = [...description];
  let prefixLength = 0;
  while (prefixLength < original.length && prose[prefixLength] === original[prefixLength])
    prefixLength++;
  expect(prefixLength).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  const closedTree = await card.ariaSnapshot();
  expect(closedTree).not.toContain("SCAN-END");
  expect((closedTree.match(/SCAN-BEGIN/g) ?? []).length).toBeLessThanOrEqual(1);
  expect(await details.locator("h3, time, .schedule-actions").count()).toBe(0);
  expect(await details.innerText()).not.toContain("Community lounge");

  // Reach summary through ordinary Tab order rather than toggling .open in JS.
  await card.locator("h3 a").focus();
  let reached = false;
  for (let tab = 0; tab < 10; tab++) {
    await page.keyboard.press("Tab");
    reached = await summary.evaluate((node) => node === document.activeElement);
    if (reached) break;
  }
  expect(reached, "description disclosure must be reachable from the event title").toBe(true);
  const nextCard = page.locator(`#event-${nextKey}`);
  const closedTop = (await nextCard.boundingBox())!.y;
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(details).toContainText("SCAN-END");
  const expandedTree = await card.ariaSnapshot();
  expect(expandedTree.match(/SCAN-BEGIN/g)).toHaveLength(1);
  expect(expandedTree.match(/SCAN-END/g)).toHaveLength(1);
  expect(await details.textContent()).toContain(description);
  await capture(page, `${evidenceName}-expanded`);
  expect((await nextCard.boundingBox())!.y).toBeGreaterThan(closedTop);
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open");
  // No persistence/rebinding helper is needed to close the native element.
  expect((await nextCard.boundingBox())!.y).toBeCloseTo(closedTop, 0);
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width}: no-JS keyboard disclosure keeps the next event scannable`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport,
        timezoneId: "Pacific/Auckland",
        serviceWorkers: "block",
      });
      try {
        const requests = await mount(context, twin);
        const page = await context.newPage();
        await page.goto(`${origin}/events?view=list&month=2030-06`);
        const card = page.locator(`#event-${EVENT_KEY}`);
        await expect(card).toBeVisible();
        await capture(page, `${twin}-${viewport.width}-native-before-toggle`);
        await assertDisclosure(page, card, FULL_DESCRIPTION, `${twin}-${viewport.width}-native`);
        await capture(page, `${twin}-${viewport.width}-native-collapsed`);
        expect(requests.documents).toHaveLength(1);
        expect(requests.fragments).toHaveLength(0);
        expect(await card.getByTestId("event-going-count").innerText()).toBe("3 of 8 going");
        await expect(card.getByTestId("signin")).toBeVisible();
        expect(await page.locator(`#event-${nextKey} details`).count()).toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    test(`${twin} ${viewport.width}: continuation swaps in a keyboard-ready disclosure without rebinding`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport,
        timezoneId: "Pacific/Auckland",
        serviceWorkers: "block",
      });
      try {
        const requests = await mount(context, twin);
        const page = await context.newPage();
        await page.goto(`${origin}/events?view=calendar&month=2030-06`);
        const continuation = page.locator('td[data-date="2030-06-02"] a[data-cal-jump]');
        await expect(continuation).toHaveCount(1);
        await expect(continuation).toContainText("Continues");
        await expect(continuation).toHaveAttribute(
          "href",
          `/events?event=${EVENT_KEY}#event-${EVENT_KEY}`,
        );
        await continuation.focus();
        await page.keyboard.press("Enter");
        const card = page.locator(`#event-${EVENT_KEY}`);
        await expect(card).toBeVisible();
        await expect(page.locator('[data-island="events-calendar"]')).toHaveAttribute(
          "data-view",
          "list",
        );
        expect(new URL(page.url()).hash).toBe(`#event-${EVENT_KEY}`);
        // A full-page fallback cannot masquerade as a successful enhanced swap.
        expect(requests.documents).toHaveLength(1);
        expect(requests.fragments).toEqual([`/events?event=${EVENT_KEY}`]);
        await expect(card).toHaveCount(1);
        await expect(card.getByTestId("event-going-count")).toHaveText("3 of 8 going");
        const ids = await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
        expect(new Set(ids).size).toBe(ids.length);
        await capture(page, `${twin}-${viewport.width}-swapped-before-toggle`);
        await assertDisclosure(page, card, FULL_DESCRIPTION, `${twin}-${viewport.width}-swapped`);
        expect(requests.fragments).toHaveLength(1);
        const end = card.locator('time[datetime="2030-06-02T08:30:00.000Z"]');
        await expect(end).toHaveCount(1);
        await expect(end).toContainText("01:30");
        await expect(card).toContainText(/(?:2\s+Jun|Jun\w*\s+2\b|2030-06-02)/);
        await expect(card.getByTestId("signin")).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }

  test(`${twin}: Unicode excerpt does not create replacement characters or duplicate accessible prose`, async ({
    browser,
  }) => {
    const description = "SCAN-BEGIN " + "🧭".repeat(250) + " SCAN-END";
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await mount(context, twin, description);
      const page = await context.newPage();
      await page.goto(`${origin}/events?view=list&month=2030-06`);
      const card = page.locator(`#event-${EVENT_KEY}`);
      expect(await card.locator("details").count()).toBe(1);
      const closed = await card.innerText();
      expect(closed).not.toContain("�");
      expect(closed).toContain("🧭");
      expect(closed).not.toContain("SCAN-END");
      expect((closed.match(/🧭/gu) ?? []).length).toBeLessThanOrEqual(
        DESCRIPTION_LIMIT - "SCAN-BEGIN ".length,
      );
      const summary = card.locator("summary");
      await summary.focus();
      await page.keyboard.press("Enter");
      expect(await card.locator("details").textContent()).toContain(description);
      const tree = await card.ariaSnapshot();
      expect(tree.match(/SCAN-BEGIN/g)).toHaveLength(1);
      expect(tree.match(/SCAN-END/g)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
}
