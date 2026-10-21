// Local fixtures only. No DB, login, remote source or opt-in/skip.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e calendar-multiday-acceptance.spec.ts --workers=1
// CALENDAR_MULTIDAY_SCREENSHOT_DIR captures baseline/implementation evidence.
import { expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  gathering,
  gatheringKey,
  gatheringTitle,
  intervalCases,
  renderCalendar,
  type CalendarTwin,
} from "../test/helpers/calendar-multiday-acceptance";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://calendar.example.test";
const css = ["styles.css", "theme.css", "schedule-theme.css"]
  .map((name) => readFileSync(join(root, "public", name), "utf8"))
  .join("\n");

async function mount(context: BrowserContext, twin: CalendarTwin, index: number) {
  const fixture = intervalCases[index]!;
  const row = gathering({
    startsAt: new Date(fixture.start),
    endsAt: new Date(fixture.end),
    timezone: fixture.zone,
  });
  const served: string[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (req.method() !== "GET") return route.abort("blockedbyclient");
    const asset = resolve(root, "public", url.pathname.slice(1));
    const contentType = url.pathname.endsWith(".js")
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : url.pathname.endsWith(".png")
            ? "image/png"
            : url.pathname.endsWith(".woff2")
              ? "font/woff2"
              : undefined;
    if (
      contentType &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      statSync(asset).isFile()
    )
      return route.fulfill({ contentType, body: readFileSync(asset) });
    if (url.pathname !== "/events") return route.fulfill({ status: 404, body: "No fixture" });
    served.push(url.pathname + url.search);
    // Native document navigations and island fetches both render the current
    // URL's view. Never serve a captured grid as the list destination.
    const html = await renderCalendar(twin, [row], {
      month: url.searchParams.get("month") ?? fixture.month,
      view: url.searchParams.get("view") === "calendar" ? "calendar" : "list",
      loginReturnTo: url.pathname + url.search,
    });
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=UTF-8",
      body: html.replace("</head>", `<style>${css}</style></head>`),
    });
  });
  return { fixture, served };
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      for (const index of [1, 7]) {
        test(`${twin} JS=${javaScriptEnabled} ${viewport.width}: ${intervalCases[index]!.name} continuation jumps`, async ({
          browser,
        }) => {
          // The viewer zone deliberately differs from both host fixtures.
          const context = await browser.newContext({
            javaScriptEnabled,
            viewport,
            timezoneId: "Pacific/Auckland",
            serviceWorkers: "block",
          });
          try {
            const { fixture, served } = await mount(context, twin, index);
            const page = await context.newPage();
            await page.goto(`${origin}/events?view=calendar&month=${fixture.month}`);
            await expect(page.getByTestId("events-calendar-grid")).toBeVisible();
            if (process.env.CALENDAR_MULTIDAY_SCREENSHOT_DIR && !javaScriptEnabled) {
              mkdirSync(process.env.CALENDAR_MULTIDAY_SCREENSHOT_DIR, { recursive: true });
              await page.screenshot({
                path: join(
                  process.env.CALENDAR_MULTIDAY_SCREENSHOT_DIR,
                  `${twin}-${viewport.width}-${index}.png`,
                ),
                fullPage: true,
                animations: "disabled",
              });
            }
            const days = await page
              .locator("td[data-date]")
              .evaluateAll((cells) =>
                cells
                  .filter((cell) => cell.querySelector("a[data-cal-jump]"))
                  .map((cell) => cell.getAttribute("data-date")),
              );
            expect(days).toEqual(fixture.days);
            const day = fixture.days[1]!;
            const continuation = page.locator(`td[data-date="${day}"] a[data-cal-jump]`);
            await expect(continuation).toHaveCount(1);
            await expect(continuation).toContainText("Continues");
            await expect(continuation).not.toContainText("23:30");
            await expect(continuation).toHaveAccessibleName(
              new RegExp(`Continues.*${gatheringTitle}`),
            );
            await expect(continuation).toHaveAttribute(
              "href",
              `/events?event=${gatheringKey}#event-${gatheringKey}`,
            );
            await continuation.focus();
            await page.keyboard.press("Enter");
            const card = page.locator(`#event-${gatheringKey}`);
            await expect(card).toBeVisible();
            await expect(page.getByTestId("event-card")).toHaveCount(1);
            await expect(card).toHaveCount(1);
            await expect(card.locator(`a[href="/e/${gatheringKey}"]`)).toBeVisible();
            expect(new URL(page.url()).hash).toBe(`#event-${gatheringKey}`);
            expect(
              served.some(
                (path) => new URL(path, origin).searchParams.get("event") === gatheringKey,
              ),
            ).toBe(true);
            const ids = await page
              .locator("[id]")
              .evaluateAll((nodes) => nodes.map((node) => node.id));
            expect(new Set(ids).size).toBe(ids.length);
          } finally {
            await context.close();
          }
        });
      }
    }

    test(`${twin} JS=${javaScriptEnabled}: original start still jumps to one canonical card`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
      try {
        await mount(context, twin, 1);
        const page = await context.newPage();
        await page.goto(`${origin}/events?view=calendar&month=2027-02`);
        const start = page.locator('td[data-date="2027-02-14"] a[data-cal-jump]');
        await expect(start).toHaveCount(1);
        await expect(start).toContainText("23:30");
        await start.click();
        await expect(page.locator(`#event-${gatheringKey}`)).toBeVisible();
        await expect(page.getByTestId("event-card")).toHaveCount(1);
        expect(new URL(page.url()).hash).toBe(`#event-${gatheringKey}`);
      } finally {
        await context.close();
      }
    });
  }
}
