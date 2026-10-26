// Calendar accessibility browser acceptance: real-Chromium accessibility tree.
// Opt-in: CALENDAR_A11Y_BROWSER_TESTS=true npx vitest run
// test/calendar-accessibility-browser-acceptance.test.ts
// Ephemeral loopback fixtures serve the real Hono route (pg-proxy, no real DB)
// with Discord-transient fixtures and the shipped island binder. No database,
// staging or network. Base: 0f8fdd17f21abe7d0f7c015001b9415b180efe99 — date
// cells carry no full-date words and loading announces nothing, so cases 1, 2
// and 5 FAIL first; the event-link, keyboard-widget and no-JS controls PASS on
// the same base.
//
// CI registration (builder-owned: this file only, no workflow edit here):
// add a step to the `a11y` job in .github/workflows/ci.yml mirroring the
// calendar search-unicode step:
//   - name: Calendar accessibility dates and loading (real Chromium)
//     env:
//       CALENDAR_A11Y_BROWSER_TESTS: "true"
//     run: |
//       npx vitest run test/calendar-accessibility-browser-acceptance.test.ts \
//         --reporter=default --reporter=json \
//         --outputFile.json=artifacts/a11y/calendar-accessibility.json
//       node ci/a11y-require-executed.mjs \
//         artifacts/a11y/calendar-accessibility.json \
//         "calendar accessible dates and owned loading in Chromium" 6
// plus the README browser-regressions table row for this suite.
//
// Speech-verification limit: these cases assert accessibility-tree and DOM
// states (accessible names, live-region text, busy/content visibility) that a
// screen reader consumes. They do not simulate speech output and cannot prove
// what any specific screen reader announces.
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { URL as NodeURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { registerEventRoutes } from "../src/events/routes";
import {
  CALENDAR_DAY_TESTID,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_LOADING_COPY,
  calendarDayLongLabel,
  type DiscordTransient,
} from "../src/islands/contracts";

// Keep the browser callback surface local: adding lib.dom here changes the
// Worker/crypto types of every other root test.
interface BrowserNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
}
declare const document: {
  querySelector(selector: string): BrowserNode | null;
  querySelectorAll(selector: string): BrowserNode[];
};

const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => null,
  async () => null,
);

function transient(id: string, startsAt: Date, title: string): DiscordTransient {
  return {
    discordId: id,
    status: "scheduled",
    title,
    description: null,
    location: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3600_000),
  };
}

// CALENDAR_A11Y_BROWSER_TESTS=true npx vitest run test/calendar-accessibility-browser-acceptance.test.ts
describe.skipIf(process.env.CALENDAR_A11Y_BROWSER_TESTS !== "true")(
  "calendar accessible dates and owned loading in Chromium",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((c) => c.close()));
      await browser?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((e) => (e ? reject(e) : resolve()));
            }),
        ),
      );
    });

    // Every month carries one in-month transient so the schedule is non-empty
    // and the grid renders; spillover cells stay event-free date markers.
    async function openMonth(
      month: string,
      rows: DiscordTransient[],
      options: { javaScript?: boolean } = {},
    ): Promise<{ page: Page; base: string }> {
      const db = drizzle(async () => ({ rows: [] }));
      const islandSource = readFileSync(
        new NodeURL("../public/islands/events-calendar.js", import.meta.url),
        "utf8",
      );
      let base = "";
      const server = createServer(async (request, reply) => {
        try {
          const url = new URL(request.url!, base);
          if (url.pathname === "/islands/events-calendar.js") {
            reply.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
            reply.end(islandSource);
            return;
          }
          if (url.pathname !== "/events") {
            reply.writeHead(404);
            reply.end("");
            return;
          }
          __resetAnonEventCacheForTests();
          const headers: Record<string, string> = {};
          const islandHeader = request.headers["x-two-island"];
          if (typeof islandHeader === "string") headers["x-two-island"] = islandHeader;
          const requestEnv = {
            APP_URL: base,
            DISCORD_INVITE_URL: "https://discord.gg/example",
            ADMIN_DB: db as unknown as Db,
            DISCORD_EVENTS: { upcoming: async () => rows, lastReadFailed: () => false },
          } as unknown as Env;
          const response = await app.request(url.pathname + url.search, { headers }, requestEnv);
          reply.writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "text/html; charset=utf-8",
          });
          reply.end(await response.text());
        } catch (error) {
          reply.writeHead(500);
          reply.end(String(error));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const context = await browser.newContext({ javaScriptEnabled: options.javaScript !== false });
      contexts.push(context);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${base}/events?view=calendar&month=${month}`);
      await page.locator('[data-testid="events-calendar-grid"]').waitFor();
      return { page, base };
    }

    it("exposes December spillover full dates in the accessibility tree", async () => {
      const { page } = await openMonth("2030-12", [
        transient("dec-1", new Date("2030-12-15T19:00:00Z"), "Winter game night"),
      ]);
      // January spillover cell: full-date words present in the cell subtree.
      const cell = page.locator(`td[data-testid="${CALENDAR_DAY_TESTID}"][data-date="2031-01-01"]`);
      await cell.waitFor();
      expect(await cell.getAttribute("data-outside")).toBe("true");
      expect(await cell.getAttribute("aria-label")).toBeNull();
      const text = (await cell.textContent()) ?? "";
      expect(text).toContain("January");
      expect(text).toContain("2031");
      expect(text).toContain(calendarDayLongLabel("2031-01-01"));
      // The cell role stays exposed with its date words as (part of) its name.
      const named = page.getByRole("cell", { name: calendarDayLongLabel("2031-01-01") });
      expect(await named.count()).toBeGreaterThanOrEqual(1);
    });

    it("exposes January spillover and leap-day full dates in the accessibility tree", async () => {
      const { page } = await openMonth("2032-02", [
        transient("leap-1", new Date("2032-02-29T19:00:00Z"), "Leap night"),
      ]);
      // February 2032 starts on a Sunday: six lead cells, ending 31 January.
      const decCell = page.locator(
        `td[data-testid="${CALENDAR_DAY_TESTID}"][data-date="2032-01-31"]`,
      );
      await decCell.waitFor();
      const decText = (await decCell.textContent()) ?? "";
      expect(decText).toContain("January");
      expect(decText).toContain(calendarDayLongLabel("2032-01-31"));
      const leapCell = page.locator(
        `td[data-testid="${CALENDAR_DAY_TESTID}"][data-date="2032-02-29"]`,
      );
      await leapCell.waitFor();
      expect((await leapCell.textContent()) ?? "").toContain(calendarDayLongLabel("2032-02-29"));
      expect(
        await page.getByRole("cell", { name: calendarDayLongLabel("2032-02-29") }).count(),
      ).toBeGreaterThanOrEqual(1);
    });

    it("keeps compact day numbers with no parent suppression or second widget", async () => {
      const { page } = await openMonth("2030-12", [
        transient("dec-2", new Date("2030-12-15T19:00:00Z"), "Winter game night"),
      ]);
      // No gridbox contract and no focusable cells.
      expect(await page.locator('[role="grid"], [role="treegrid"]').count()).toBe(0);
      expect(await page.locator(`td[data-testid="${CALENDAR_DAY_TESTID}"][tabindex]`).count()).toBe(
        0,
      );
      expect(
        await page.locator(`td[data-testid="${CALENDAR_DAY_TESTID}"][aria-label]`).count(),
      ).toBe(0);
      // Compact visible numbers survive beside the full-date words.
      const first = page.locator(`td[data-testid="${CALENDAR_DAY_TESTID}"]`).first();
      const number = (await first.locator(":scope > span").first().textContent()) ?? "";
      expect(number.trim()).toMatch(/^\d{1,2}$/);
    });

    it("keeps nested event links named in the accessibility tree", async () => {
      const { page } = await openMonth("2030-12", [
        transient("dec-3", new Date("2030-12-15T19:00:00Z"), "Winter raid night"),
      ]);
      const link = page.getByRole("link", { name: /Winter raid night/ });
      expect(await link.count()).toBeGreaterThanOrEqual(1);
      await link.first().waitFor();
      const href = await link.first().getAttribute("href");
      expect(href).toContain("/events?event=discord-dec-3");
    });

    it("announces a member-started month step through a live host, then clears it", async () => {
      const { page, base } = await openMonth("2030-10", [
        transient("oct-1", new Date("2030-10-15T19:00:00Z"), "Autumn game night"),
      ]);
      // Hold the fragment so the pending loading state is observable.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        (url) => url.pathname === "/events" && url.searchParams.get("view") === "calendar",
        async (route) => {
          await gate;
          await route.continue();
        },
      );
      await page.getByRole("link", { name: "Next month" }).click();
      // Pending: busy on, skeleton visible, content hidden, live host carries loading.
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('[data-island="events-calendar"]')?.getAttribute("aria-busy") ===
            "true",
        );
        expect(await page.locator('[data-testid="events-loading"]').isHidden()).toBe(false);
        const liveTexts = await page.evaluate(() =>
          [
            ...document.querySelectorAll('[data-testid$="-status"]'),
            document.querySelector("[data-cal-feedback]"),
          ].map((n) => n?.textContent ?? ""),
        );
        expect(liveTexts.some((t) => /loading/i.test(t))).toBe(true);
        expect(await page.locator('[data-testid="events-read-status"]').textContent()).toBe("");
      } finally {
        release();
      }
      await page.waitForFunction(
        () =>
          document.querySelector('[data-island="events-calendar"]')?.getAttribute("aria-busy") ===
          null,
      );
      const after = await page.evaluate(() =>
        [
          ...document.querySelectorAll('[data-testid$="-status"]'),
          document.querySelector("[data-cal-feedback]"),
        ].map((n) => n?.textContent ?? ""),
      );
      expect(after.some((t) => /loading/i.test(t))).toBe(false);
      expect(await page.locator('[data-testid="events-calendar-grid"]').count()).toBe(1);
      expect(EVENTS_CALENDAR_FETCH_FAILED.length).toBeGreaterThan(0);
      expect(EVENTS_LOADING_COPY.length).toBeGreaterThan(0);
      expect(new URL(page.url()).origin).toBe(new URL(base).origin);
    });

    it("keeps no-JS month navigation working without the island", async () => {
      const { page, base } = await openMonth(
        "2030-10",
        [transient("oct-2", new Date("2030-10-15T19:00:00Z"), "Autumn game night")],
        { javaScript: false },
      );
      await page.getByRole("link", { name: "Next month" }).click();
      await page.waitForURL(/month=2030-11/);
      expect(page.url()).toBe(`${base}/events?view=calendar&month=2030-11`);
      expect(await page.locator('[data-testid="events-calendar-grid"]').count()).toBe(1);
    });
  },
);
