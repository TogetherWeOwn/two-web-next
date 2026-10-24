// Real Hono/Kit renderer contracts and shipped islands in intercepted Chromium.
// Catches stale subscription help/copy targets after a successful fragment,
// premature scope changes on failures/races, and a broken native GET fallback.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  GAME_CALENDAR_ORIGIN as ORIGIN,
  HOSTILE_GAME,
  type CalendarRenderer,
  gameSubscriptionFixture,
} from "./helpers/calendar-game-subscription";

type Pending = {
  path: string;
  resolve: (response: { ok: boolean; text: () => Promise<string> }) => void;
};
// Keep the browser callback surface local: adding lib.dom here changes the
// Worker/crypto types of every other root test.
interface BrowserNode {
  textContent: string | null;
  parentElement: BrowserNode | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): BrowserNode | null;
}
interface BrowserLink extends BrowserNode {
  href: string;
}
interface BrowserInput extends BrowserNode {
  value: string;
}
declare const window: {
  gameFeedRequests: Pending[];
  gameFeedCopies: string[];
  fetch: typeof fetch;
};
declare const document: {
  querySelector<T = BrowserNode>(selector: string): T | null;
  querySelectorAll<T = BrowserNode>(selector: string): T[];
};
declare const navigator: { clipboard?: { writeText(text: string): Promise<void> } };
declare const location: { href: string };
const GAME = '[data-testid="events-game-filter"]';
const SEARCH = '[data-testid="events-search"]';
let browser: Browser;
let contexts: BrowserContext[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
});
afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
});
afterAll(async () => {
  await browser?.close();
});

async function mount(renderer: CalendarRenderer, entry = "/events", javaScriptEnabled = true) {
  const fixture = gameSubscriptionFixture(renderer);
  const context = await browser.newContext({ javaScriptEnabled });
  contexts.push(context);
  const page = await context.newPage();
  const unexpected: string[] = [];
  const native = async (path: string, fragment = false) => {
    const response = await fixture.request(path, fragment);
    expect(response.status).toBe(200);
    return response.text();
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/events")
      return route.fulfill({
        contentType: "text/html",
        body: await native(url.pathname + url.search),
      });
    const file = resolve("public", "." + url.pathname);
    if (!file.startsWith(resolve("public") + "/")) return route.abort();
    try {
      return route.fulfill({
        body: readFileSync(file),
        contentType:
          (
            {
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".woff2": "font/woff2",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
    } catch {
      return route.fulfill({ status: 404, body: "Fixture asset absent" });
    }
  });
  await page.addInitScript(() => {
    window.gameFeedRequests = [];
    window.gameFeedCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.gameFeedCopies.push(text);
        },
      },
    });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (new Headers(init?.headers).get("x-two-island") !== "events-calendar")
        return nativeFetch(input, init);
      // Ignore abort deliberately: stale completion must not be admitted.
      return new Promise((resolve) =>
        window.gameFeedRequests.push({
          path: String(input),
          resolve: resolve as Pending["resolve"],
        }),
      );
    };
  });
  await page.goto(ORIGIN + entry);
  await page.locator(GAME).waitFor();
  const requested = async (count: number) => {
    await page.waitForFunction((n) => window.gameFeedRequests.length === n, count);
    return page.evaluate((i) => window.gameFeedRequests[i]!.path, count - 1);
  };
  const respond = async (index: number, ok = true) => {
    const path = await page.evaluate((i) => window.gameFeedRequests[i]!.path, index);
    const body = ok ? await native(path, true) : "Unavailable";
    await page.evaluate(
      ({ index, ok, body }) =>
        window.gameFeedRequests[index]!.resolve({ ok, text: async () => body }),
      { index, ok, body },
    );
    await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0)));
  };
  return { page, requested, respond, unexpected };
}

async function targets(page: Page) {
  return page.evaluate(() => {
    const subscribe = document.querySelector<BrowserLink>('[data-testid="events-subscribe"]');
    const download = Array.from(document.querySelectorAll<BrowserLink>("a[href]")).find((a) => {
      const url = new URL(a.href, location.href);
      return url.protocol === "https:" && url.pathname === "/events.ics";
    });
    const field = document.querySelector<BrowserInput>("#calendar-feed-url");
    const copy = document.querySelector<BrowserNode>("[data-copy-feed]");
    return {
      subscribe: subscribe?.getAttribute("href"),
      download: download?.getAttribute("href"),
      copy: copy?.getAttribute("data-copy-link"),
      manual: field?.value,
      label: [
        subscribe?.textContent,
        subscribe?.getAttribute("aria-label"),
        subscribe?.getAttribute("title"),
        subscribe?.parentElement?.textContent,
        field?.closest("details")?.textContent,
      ].join(" "),
    };
  });
}

async function assertScope(page: Page, game: string | null) {
  const actual = await targets(page);
  for (const [name, href] of Object.entries({
    subscribe: actual.subscribe,
    download: actual.download,
    copy: actual.copy,
    manual: actual.manual,
  })) {
    expect(href, `${name} exists`).toBeTruthy();
    const url = new URL(href!, ORIGIN);
    expect(url.protocol, name).toBe(name === "subscribe" ? "webcal:" : "https:");
    expect(url.host, name).toBe("calendar.example.test");
    expect(url.pathname, name).toBe("/events.ics");
    expect(url.hash, name).toBe("");
    expect(url.searchParams.get("game"), `${name} follows the committed game`).toBe(game);
    expect(
      [...url.searchParams.keys()].filter((key) => key !== "game"),
      `${name} must not imply q/month/page feed filters`,
    ).toEqual([]);
  }
  if (game) expect(actual.label.toLowerCase()).toContain(game.toLowerCase());
  const all = page.locator(`${GAME} option[value=""]`);
  expect(await all.count()).toBe(1);
  expect(await all.textContent()).toMatch(/all/i);
}

async function copyWithKeyboard(page: Page) {
  const summary = page.locator("details.subscription-help > summary");
  if (!(await summary.evaluate((node) => node.parentElement!.hasAttribute("open")))) {
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  await page.locator("[data-copy-feed]").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.gameFeedCopies.length > 0);
  const copied = await page.evaluate(() => window.gameFeedCopies.at(-1));
  expect(copied).toBe((await targets(page)).manual);
  return copied!;
}

for (const renderer of ["hono", "kit"] as const) {
  describe(`${renderer}: game subscription is the committed schedule, not a search draft`, () => {
    it("CONTROL: all-events schedule keeps unscoped links despite a free-text search", async () => {
      const h = await mount(renderer, "/events?q=Raid");
      await assertScope(h.page, null);
      expect(h.unexpected).toEqual([]);
    });

    for (const javaScriptEnabled of [false, true]) {
      it(`renders the reserved/Unicode game safely with JS=${javaScriptEnabled}`, async () => {
        const h = await mount(
          renderer,
          `/events?${new URLSearchParams({ game: HOSTILE_GAME, q: "Raid", page: "2" })}`,
          javaScriptEnabled,
        );
        expect(await h.page.locator(GAME).inputValue()).toBe(HOSTILE_GAME);
        await assertScope(h.page, HOSTILE_GAME);
        expect(await h.page.locator("tag").count()).toBe(0);
        if (javaScriptEnabled) {
          const copied = await copyWithKeyboard(h.page);
          expect(new URL(copied).searchParams.get("game")).toBe(HOSTILE_GAME);
        }
        expect(h.unexpected).toEqual([]);
      });
    }

    it("no-JS keyboard GET submit carries the game, and All games removes feed scope", async () => {
      const h = await mount(renderer, "/events", false);
      await h.page.locator(GAME).focus();
      await h.page.keyboard.press("Home");
      await h.page.keyboard.press("ArrowDown");
      await h.page.keyboard.press("Enter");
      expect(await h.page.locator(GAME).inputValue()).toBe("Factorio");
      await h.page.getByRole("button", { name: "Search", exact: true }).focus();
      await Promise.all([
        h.page.waitForURL((url) => url.searchParams.get("game") === "Factorio"),
        h.page.keyboard.press("Enter"),
      ]);
      await assertScope(h.page, "Factorio");
      await h.page.locator(GAME).focus();
      await h.page.keyboard.press("Home");
      await h.page.keyboard.press("Enter");
      await h.page.getByRole("button", { name: "Search", exact: true }).focus();
      await Promise.all([
        h.page.waitForURL((url) => !url.searchParams.get("game")),
        h.page.keyboard.press("Enter"),
      ]);
      await assertScope(h.page, null);
      expect(h.unexpected).toEqual([]);
    });

    it("successful fragments update Subscribe/download/manual URL and the live copy action together", async () => {
      const h = await mount(renderer);
      await h.page.locator(GAME).selectOption("Factorio");
      await h.page.locator(SEARCH).press("Enter");
      const path = await h.requested(1);
      expect(new URL(path, ORIGIN).searchParams.get("game")).toBe("Factorio");
      await assertScope(h.page, null);
      await h.respond(0);
      await assertScope(h.page, "Factorio");
      expect(new URL(await copyWithKeyboard(h.page)).searchParams.get("game")).toBe("Factorio");
      // Clearing via the same persistent native select restores all targets.
      await h.page.locator(GAME).selectOption("");
      await h.page.locator(SEARCH).press("Enter");
      await h.requested(2);
      await h.respond(1);
      await assertScope(h.page, null);
      expect(new URL(await copyWithKeyboard(h.page)).searchParams.get("game")).toBeNull();
      expect(h.unexpected).toEqual([]);
    });

    it("CONTROL: a failed fragment leaves the previous links/help/copy action intact", async () => {
      const h = await mount(renderer, "/events?game=Factorio");
      const before = await targets(h.page);
      await h.page.locator(GAME).selectOption("Helldivers 2");
      await h.page.locator(SEARCH).press("Enter");
      await h.requested(1);
      expect(await targets(h.page)).toEqual(before);
      await h.respond(0, false);
      expect(await targets(h.page)).toEqual(before);
      expect(await copyWithKeyboard(h.page)).toBe(before.manual);
      expect(h.unexpected).toEqual([]);
    });

    for (const order of ["old-first", "new-first"]) {
      it(`superseded scope never publishes stale help or clipboard bytes (${order})`, async () => {
        const h = await mount(renderer);
        const before = await targets(h.page);
        await h.page.locator(GAME).selectOption("Factorio");
        await h.page.locator(SEARCH).press("Enter");
        await h.requested(1);
        await h.page.locator(GAME).selectOption("Helldivers 2");
        await h.page.locator(SEARCH).press("Enter");
        await h.requested(2);
        if (order === "old-first") {
          await h.respond(0);
          expect(await targets(h.page)).toEqual(before);
          await h.respond(1);
        } else {
          await h.respond(1);
          const committed = await targets(h.page);
          await h.respond(0);
          expect(await targets(h.page)).toEqual(committed);
        }
        await assertScope(h.page, "Helldivers 2");
        expect(new URL(await copyWithKeyboard(h.page)).searchParams.get("game")).toBe(
          "Helldivers 2",
        );
        expect(h.unexpected).toEqual([]);
      });
    }
  });
}
