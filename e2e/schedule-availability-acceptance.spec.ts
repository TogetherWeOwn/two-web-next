// Local intercepted renderer/asset fixtures only; no database, server, auth or external fetch.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e schedule-availability-acceptance.spec.ts --workers=1
import { expect, test, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOOKABLE,
  CANCELLED,
  DISCORD_MANAGED,
  FULL,
  KEY,
  NOW,
  ORIGIN,
  PAUSED,
  PAST,
  TITLE,
  TWO_LEFT,
  UNLIMITED,
  discordEvent,
  event,
  model,
  render,
} from "../test/fixtures/schedule-availability";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const css = ["styles.css", "theme.css", "schedule-theme.css"]
  .map((name) => readFileSync(`${root}${name}`, "utf8"))
  .join("\n");
const key = (n: number) => `01K7MZ${String(n).padStart(20, "0")}`;

async function mount(context: BrowserContext, target: "Hono" | "Kit") {
  let paused = false;
  const served: { path: string; island: boolean }[] = [];
  const foreign: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      foreign.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (
      url.pathname === "/islands/events-calendar.js" ||
      url.pathname === "/islands/copy-link.js"
    ) {
      return route.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`${root}${url.pathname.slice(1)}`),
      });
    }
    if (url.pathname !== "/events") return route.fulfill({ status: 404, body: "No fixture" });
    served.push({
      path: url.pathname + url.search,
      island: request.headers()["x-two-island"] === "events-calendar",
    });
    const rows = [
      event({ rsvpOpen: !paused }),
      event({
        id: 2,
        eventKey: key(2),
        title: "Paused cooperative night",
        rsvpOpen: false,
        startsAt: new Date("2035-10-22T18:00:00Z"),
        endsAt: new Date("2035-10-22T20:00:00Z"),
      }),
      event({
        id: 3,
        eventKey: key(3),
        title: "Third cooperative night",
        goingOccupancy: 10,
        startsAt: new Date("2035-10-23T18:00:00Z"),
        endsAt: new Date("2035-10-23T20:00:00Z"),
      }),
      event({
        id: 4,
        eventKey: key(4),
        title: "Fourth cooperative night",
        capacity: null,
        startsAt: new Date("2035-10-24T18:00:00Z"),
        endsAt: new Date("2035-10-24T20:00:00Z"),
      }),
      {
        ...discordEvent(),
        startsAt: new Date("2035-10-25T19:00:00Z"),
        endsAt: new Date("2035-10-25T21:00:00Z"),
      },
      event({
        id: 5,
        eventKey: key(5),
        title: "Fifth cooperative night",
        status: "cancelled",
        startsAt: new Date("2035-10-26T18:00:00Z"),
        endsAt: new Date("2035-10-26T20:00:00Z"),
      }),
      event({
        id: 6,
        eventKey: key(6),
        title: "Earlier cooperative night",
        startsAt: new Date("2035-10-19T18:00:00Z"),
        endsAt: new Date("2035-10-19T20:00:00Z"),
      }),
    ];
    const data = model(rows, {
      view: url.searchParams.get("view") === "calendar" ? "calendar" : "list",
      month: url.searchParams.get("month") ?? "2035-10",
      game: url.searchParams.get("game") ?? "",
      q: url.searchParams.get("q") ?? "",
      page: Number(url.searchParams.get("page") ?? 1),
    });
    data.loginReturnTo = url.pathname + url.search;
    const html = await render(data, target);
    return route.fulfill({
      contentType: "text/html; charset=UTF-8",
      body: html.replace("</head>", `<style>${css}</style></head>`),
    });
  });
  return {
    served,
    foreign,
    pause: () => {
      paused = true;
    },
  };
}

for (const target of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    for (const width of [1280, 390]) {
      for (const view of ["list", "calendar"] as const) {
        test(`${target} JS=${javaScriptEnabled} ${width} ${view}: visible availability and accessible entry names`, async ({
          browser,
        }) => {
          const context = await browser.newContext({
            javaScriptEnabled,
            viewport: { width, height: width === 390 ? 844 : 800 },
            serviceWorkers: "block",
          });
          try {
            await mount(context, target);
            const page = await context.newPage();
            await page.clock.setFixedTime(NOW);
            await page.goto(`${ORIGIN}/events?view=${view}&month=2035-10`);
            const entry = (id: string) =>
              view === "list"
                ? page.locator(`#event-${id}`)
                : page.locator(`a[data-cal-jump][href*="event=${id}"]`);
            const open = entry(KEY);
            await expect(open).toBeVisible();
            await expect(open).toContainText(TWO_LEFT, { timeout: 1000 });
            await expect(entry(key(2))).toContainText(PAUSED);
            await expect(entry(key(2))).not.toContainText(BOOKABLE);
            await expect(entry(key(3))).toContainText(FULL);
            await expect(entry(key(4))).toContainText(UNLIMITED);
            await expect(entry("discord-123456789012345678")).toContainText(DISCORD_MANAGED);
            await expect(entry(key(5))).toContainText(CANCELLED);
            await expect(entry(key(5))).not.toContainText(BOOKABLE);
            await expect(entry(key(6))).toContainText(PAST);
            await expect(entry(key(6))).not.toContainText(BOOKABLE);
            if (view === "calendar") {
              await expect(open).toHaveAccessibleName(new RegExp(TITLE));
              await expect(open).toHaveAccessibleName(/18:00/);
              await expect(open).toHaveAccessibleName(TWO_LEFT);
              await expect(entry(key(2))).toHaveAccessibleName(PAUSED);
              await expect(entry(key(3))).toHaveAccessibleName(FULL);
              await expect(entry(key(4))).toHaveAccessibleName(UNLIMITED);
              await expect(entry("discord-123456789012345678")).toHaveAccessibleName(
                DISCORD_MANAGED,
              );
              const fit = await open.evaluate((link) => {
                const cell = link.closest("td")!;
                const a = link.getBoundingClientRect();
                const b = cell.getBoundingClientRect();
                return (
                  a.left >= b.left &&
                  a.right <= b.right + 1 &&
                  link.scrollWidth <= link.clientWidth + 1
                );
              });
              expect(fit, "availability wraps within its day cell").toBe(true);
            } else {
              await expect(open.getByRole("link", { name: TITLE, exact: true })).toBeVisible();
              await expect(open.locator("time").first()).toBeVisible();
            }
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            ).toBe(true);
          } finally {
            await context.close();
          }
        });
      }
    }

    test(`${target} JS=${javaScriptEnabled}: CONTROL keyboard grid jump, filters and guest destination survive`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled,
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      try {
        const fixture = await mount(context, target);
        const page = await context.newPage();
        await page.goto(`${ORIGIN}/events?view=calendar&month=2035-10&game=Deep+Rock+Galactic`);
        const link = page.locator(`a[data-cal-jump][href*="event=${KEY}"]`);
        await expect(link).toHaveAccessibleName(new RegExp(TITLE));
        await link.focus();
        await page.keyboard.press("Enter");
        const card = page.locator(`#event-${KEY}`);
        await expect(card).toBeVisible();
        const committed = new URL(page.url());
        expect(committed.hash).toBe(`#event-${KEY}`);
        expect(committed.searchParams.get("game")).toBe("Deep Rock Galactic");
        const signin = card.getByRole("link", { name: "Sign in with Discord", exact: true });
        const href = new URL((await signin.getAttribute("href"))!, ORIGIN);
        expect(href.pathname).toBe("/join/discord");
        expect(href.searchParams.get("next")).toBe(committed.pathname + committed.search);
        expect(fixture.served).toHaveLength(2);
        expect(fixture.served[1]!.island).toBe(javaScriptEnabled);
        expect(fixture.foreign).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test(`${target}: island installs the server snapshot, including newly paused state`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    try {
      const fixture = await mount(context, target);
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/events?game=Deep+Rock+Galactic`);
      const search = await page.getByTestId("events-search").elementHandle();
      fixture.pause();
      await page.getByTestId("events-view-calendar").focus();
      await page.keyboard.press("Enter");
      const entry = page.locator(`a[data-cal-jump][href*="event=${KEY}"]`);
      await expect(entry).toBeVisible();
      // Navigation and stable input prove this was an island swap, not a new document.
      expect(await search!.evaluate((node) => node.isConnected)).toBe(true);
      expect(fixture.served).toHaveLength(2);
      expect(fixture.served[1]!.island).toBe(true);
      expect(new URL(page.url()).searchParams.get("game")).toBe("Deep Rock Galactic");
      await expect(entry).toContainText(PAUSED, { timeout: 1000 });
      await expect(entry).toHaveAccessibleName(PAUSED);
      await expect(entry).not.toContainText(BOOKABLE);
    } finally {
      await context.close();
    }
  });
}
