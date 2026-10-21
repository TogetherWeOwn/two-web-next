// Calendar search Unicode boundaries: the native `maxlength=255`
// counts UTF-16 units while the server admits 255 code points, so 128
// supplementary characters (256 units) are server-valid but natively
// truncated. The fix is markup-only: omit `maxlength` so complete admitted
// queries reach the server, which keeps its 422 for over-limit input.
// Hermetic fixtures only: mocked reads, no DB/Discord/browser by default.
// Chromium proof is opt-in (CALENDAR_SEARCH_BROWSER_TESTS=true) and uses real
// typing/paste — VM value assignment alone cannot catch native truncation.
import { Hono } from "hono";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { URL as NodeURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { registerEventRoutes } from "../src/events/routes";
import {
  listCalendarPast,
  listUpcoming,
  listUpcomingForMonth,
  type PublicEvent,
} from "../src/events/reads";
import {
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_TESTID,
  EVENTS_SEARCH_TOO_LONG_COPY,
  normalizeEventSearch,
} from "../src/islands/contracts-calendar";
import { MAX_QUERY_LENGTH, matchQuery, normalizeQuery } from "../src/events/search-log";

vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listUpcoming: vi.fn(),
  listUpcomingForMonth: vi.fn(),
  listCalendarPast: vi.fn(),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => null,
  async () => null,
);
const env = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/example",
  ADMIN_DB: {} as Db,
  DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
} as unknown as Env;

function eventRow(id: number, startsAt: Date): PublicEvent {
  return {
    id,
    icsSequence: 1n,
    syncRevision: 1,
    syncedRevision: 0,
    eventKey: `event-${id}`,
    title: "Game night",
    game: null,
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    goingCount: 0,
    goingOccupancy: 0,
  };
}

function searchInputTag(html: string): string {
  const byTestid = html.match(
    new RegExp(`<input\\b[^>]*data-testid="${EVENTS_SEARCH_TESTID}"[^>]*>`),
  )?.[0];
  if (byTestid) return byTestid;
  return html.match(/<input\b[^>]*name="q"[^>]*>/)![0];
}

async function eventsHtml(path = "/events"): Promise<string> {
  const response = await app.request(path, undefined, env);
  expect(response.status).toBe(200);
  return response.text();
}

async function searchStatus(query: string): Promise<{ status: number; body: string }> {
  const response = await app.request(`/events?q=${encodeURIComponent(query)}`, undefined, env);
  const body = await response.text();
  return { status: response.status, body };
}

const text = (pattern: string[], count: number): string =>
  Array.from({ length: count }, (_, i) => pattern[i % pattern.length]!).join("");

const alphabets = [
  { name: "ASCII", pattern: ["x"] },
  { name: "BMP", pattern: ["界"] },
  { name: "astral", pattern: ["😀"] },
  { name: "mixed", pattern: ["界", "😀", "x"] },
];

beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.mocked(listUpcoming).mockResolvedValue({
    rows: [eventRow(1, new Date("2030-01-12T20:00:00Z"))],
    hasMore: false,
    totalPages: 1,
    total: 1,
  });
  vi.mocked(listUpcomingForMonth).mockResolvedValue([]);
  vi.mocked(listCalendarPast).mockResolvedValue([eventRow(2, new Date("2020-01-12T20:00:00Z"))]);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("calendar search Unicode boundaries", () => {
  it("renders the search input without a UTF-16 maxlength", async () => {
    const html = await eventsHtml();
    const input = searchInputTag(html);
    expect(input).toBeDefined();
    // Native maxlength counts UTF-16 units and would truncate server-valid
    // queries (128 supplementary characters are 256 units); code-point
    // limits belong to the server validators, as in the profile fix.
    expect(input).not.toMatch(/\bmaxlength\s*=/i);
    expect(input).toContain('type="search"');
    expect(input).toContain('name="q"');
    expect(input).toContain(`data-testid="${EVENTS_SEARCH_TESTID}"`);
    expect(html).toContain('<form method="get" action="/events" role="search"');
  });

  it("hands the island the 255 limit and its named copy", async () => {
    const html = await eventsHtml();
    expect(html).toContain(`data-search-max-length="${EVENTS_SEARCH_MAX_LENGTH}"`);
    expect(html).toContain(`data-search-too-long="${EVENTS_SEARCH_TOO_LONG_COPY}"`);
  });

  it("keeps the 255 code-point budget without grapheme counting", () => {
    expect(EVENTS_SEARCH_MAX_LENGTH).toBe(255);
    expect(MAX_QUERY_LENGTH).toBe(255);
    // Combining marks and ZWJ sequences count as code points, not graphemes:
    // no silent rewrite of an admitted query into a shorter grapheme count.
    for (const admitted of ["é".repeat(255), "👩‍💻".repeat(85)]) {
      expect([...admitted].length).toBeLessThanOrEqual(255);
      expect(normalizeEventSearch(admitted)).toBe(admitted.toLowerCase());
      expect(normalizeQuery(admitted)).toBe(admitted.toLowerCase());
      expect(matchQuery(admitted)).toBe(admitted);
    }
    expect([...normalizeEventSearch("a".repeat(300))!]).toHaveLength(255);
    expect([...normalizeEventSearch("😀".repeat(300))!]).toHaveLength(255);
  });

  it.each(alphabets)("admits exactly 255 $name code points (200)", async ({ pattern }) => {
    const query = text(pattern, 255);
    expect([...query]).toHaveLength(255);
    const { status } = await searchStatus(query);
    expect(status).toBe(200);
  });

  it("admits the reported 128 supplementary characters (256 UTF-16 units, 200)", async () => {
    const query = "😀".repeat(128);
    expect([...query]).toHaveLength(128);
    expect(query.length).toBe(256);
    const { status } = await searchStatus(query);
    expect(status).toBe(200);
  });

  it.each(alphabets)(
    "retains the existing 422 refusal for 256 $name code points",
    async ({ pattern }) => {
      const query = text(pattern, 256);
      expect([...query]).toHaveLength(256);
      const response = await app.request(`/events?q=${encodeURIComponent(query)}`, undefined, env);
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain(`role="alert">${EVENTS_SEARCH_TOO_LONG_COPY}<`);
      expect(body).not.toContain(query.slice(0, 10));
    },
  );
});

// Opt in where Chromium is installed; SSR + route fixtures above are the CI gate.
// CALENDAR_SEARCH_BROWSER_TESTS=true npx vitest run test/calendar-search-unicode-boundaries.test.ts
// Ephemeral loopback fixtures serve the real SSR markup with mocked reads.
// No database, staging identity or external service is used.
describe.skipIf(process.env.CALENDAR_SEARCH_BROWSER_TESTS !== "true")(
  "native calendar search input (real Chromium typing/paste)",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    });

    async function openCalendar(
      options: { javaScript?: boolean } = {},
    ): Promise<{ page: Page; submissions: string[] }> {
      const islandSource = readFileSync(
        new NodeURL("../public/islands/events-calendar.js", import.meta.url),
        "utf8",
      );
      const submissions: string[] = [];
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
          const q = url.searchParams.get("q") ?? "";
          if (request.method === "GET" && url.search !== "") {
            submissions.push(q);
          }
          // Render the real route per request URL/query with the ephemeral origin,
          // preserving mocked reads. The island validates that the fetched
          // fragment's canonical is same-origin /events and that every auth
          // destination's sole next equals the committed address; serving one
          // pre-rendered /events document (APP_URL https://next.example.test,
          // next=/events) for a query would be refused as an invalid page.
          // Admitted queries render 200 with the committed query in their auth
          // destinations; over-limit queries render the route's real 422 notice.
          const headers: Record<string, string> = {};
          const islandHeader = request.headers["x-two-island"];
          if (typeof islandHeader === "string") headers["x-two-island"] = islandHeader;
          const cookieHeader = request.headers.cookie;
          if (typeof cookieHeader === "string") headers.cookie = cookieHeader;
          const response = await app.request(
            url.pathname + url.search,
            { headers },
            { ...env, APP_URL: base },
          );
          const body = await response.text();
          const outHeaders: Record<string, string> = {
            "content-type": response.headers.get("content-type") ?? "text/html; charset=utf-8",
          };
          const cacheControl = response.headers.get("cache-control");
          if (cacheControl) outHeaders["cache-control"] = cacheControl;
          const vary = response.headers.get("vary");
          if (vary) outHeaders.vary = vary;
          reply.writeHead(response.status, outHeaders);
          reply.end(body);
        } catch (error) {
          reply.writeHead(500);
          reply.end(String(error));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // The rendered markup itself must carry no maxlength; otherwise real
      // typing/paste below is truncated before any submission exists.
      // Check the same ephemeral-origin bytes the browser will receive.
      const initial = await app.request("/events", undefined, { ...env, APP_URL: base });
      expect(initial.status).toBe(200);
      expect(searchInputTag(await initial.text())).not.toMatch(/\bmaxlength\s*=/i);
      const context = await browser.newContext({
        javaScriptEnabled: options.javaScript === true,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      contexts.push(context);
      // Contain all page traffic to its ephemeral fixture.
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${base}/events`);
      await page.locator(`[data-testid="${EVENTS_SEARCH_TESTID}"]`).waitFor();
      return { page, submissions };
    }

    async function typeReal(page: Page, value: string): Promise<void> {
      const input = page.locator(`[data-testid="${EVENTS_SEARCH_TESTID}"]`);
      await input.fill("");
      await input.focus();
      // Real user-edit input respects native maxlength, unlike assigning .value.
      await input.pressSequentially(value);
      expect(await input.inputValue()).toBe(value);
    }

    async function pasteReal(page: Page, value: string): Promise<void> {
      const input = page.locator(`[data-testid="${EVENTS_SEARCH_TESTID}"]`);
      await input.fill("");
      await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(value)})`);
      await input.focus();
      await input.press("Control+V");
      expect(await input.inputValue()).toBe(value);
    }

    async function submitNative(page: Page, submissions: string[]): Promise<void> {
      await page.locator('[role="search"] button[type="submit"]').click();
      await page.waitForURL(/\/events\?/);
      expect(submissions).toHaveLength(1);
    }

    for (const method of ["typing", "paste"] as const) {
      const enter = async (page: Page, value: string) =>
        method === "typing" ? typeReal(page, value) : pasteReal(page, value);
      it.each(alphabets)(
        `${method} admits complete 255 $name code points natively`,
        async ({ pattern }) => {
          const { page, submissions } = await openCalendar();
          const value = text(pattern, 255);
          expect([...value]).toHaveLength(255);
          await enter(page, value);
          await submitNative(page, submissions);
          expect(submissions[0]).toBe(value);
        },
      );

      it(`${method} admits 128 supplementary characters without UTF-16 truncation`, async () => {
        const { page, submissions } = await openCalendar();
        const value = "😀".repeat(128);
        expect(value.length).toBe(256);
        await enter(page, value);
        await submitNative(page, submissions);
        expect(submissions[0]).toBe(value);
      });

      it.each(alphabets)(
        `${method} sends complete 256 $name code points for the server 422 (no silent truncation)`,
        async ({ pattern }) => {
          const { page, submissions } = await openCalendar();
          const value = text(pattern, 256);
          await enter(page, value);
          // No-JS submission reaches the server intact; the server refuses it.
          await page.locator('[role="search"] button[type="submit"]').click();
          await page.waitForURL(/\/events\?/);
          expect(submissions).toHaveLength(1);
          expect(submissions[0]).toBe(value);
          expect(await page.locator("body").textContent()).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
        },
      );
    }

    const feedbackText = (page: Page) => page.locator("[data-cal-feedback]").textContent();

    it("with JS, pasting 256 characters names the limit and sends no request", async () => {
      const { page, submissions } = await openCalendar({ javaScript: true });
      const value = "x".repeat(256);
      await pasteReal(page, value);
      await expect.poll(() => feedbackText(page)).toBe(EVENTS_SEARCH_TOO_LONG_COPY);
      expect(submissions).toHaveLength(0);
      expect(await page.locator(`[data-testid="${EVENTS_SEARCH_TESTID}"]`).inputValue()).toBe(
        value,
      );
    });

    it("with JS, typing 256 characters names the limit and sends no request", async () => {
      const { page, submissions } = await openCalendar({ javaScript: true });
      await typeReal(page, "x".repeat(256));
      await expect.poll(() => feedbackText(page)).toBe(EVENTS_SEARCH_TOO_LONG_COPY);
      expect(submissions).toHaveLength(0);
    });

    it("with JS, pasting 255 characters still searches", async () => {
      const { page, submissions } = await openCalendar({ javaScript: true });
      const value = "x".repeat(255);
      await pasteReal(page, value);
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toBe(value);
      // Wait for the committed response, not just request arrival: the island
      // push-commits the search URL only after the fragment validates and swaps.
      // A refused fragment leaves the entry URL and installs load-error feedback,
      // so reading feedback before the response would pass vacuously.
      await page.waitForURL(/\/events\?.*q=/);
      await expect.poll(() => feedbackText(page)).toBe("");
    });
  },
);
