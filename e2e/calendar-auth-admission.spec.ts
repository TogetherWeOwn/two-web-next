/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CALENDAR_AUTH_ORIGIN as ORIGIN, calendarAuthFixture } from "../test/helpers/calendar-auth";

type Pending = {
  path: string;
  signal?: AbortSignal | null;
  resolve: (response: { ok: boolean; text: () => Promise<string> }) => void;
};
declare global {
  interface Window {
    calendarAuthRequests: Pending[];
  }
}

const HEADER = 'header a[data-testid="signin"]';
const HERO = ".schedule-heading a";
const CARDS = '[data-cal-zone="content"] a[data-testid="signin"]';
const ROOT = '[data-island="events-calendar"]';
const SEARCH = '[data-testid="events-search"]';
const INITIAL = "/events";
const TARGET = "/events?past=1";
const TARGET_NEXT = "next=%2Fevents%3Fpast%3D1";
const STALE_NEXT = "next=%2Fevents";

type Harness = Awaited<ReturnType<typeof mount>>;

// Same self-contained harness shape as the committed-destination matrix: the
// browser runs the real mounted app HTML and the shipped island, every request
// is intercepted, and fragment fetches are answered by the test so each
// poisoned transform exercises admission rather than the network.
async function mount(page: Page, entry = INITIAL, renderer: "hono" | "kit" = "hono") {
  const fixture = calendarAuthFixture(renderer);
  const native = async (path: string, fragment = false) => {
    const response = await fixture.request(path, fragment);
    expect(response.status).toBe(200);
    return response.text();
  };
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/events") {
      return route.fulfill({
        contentType: "text/html",
        body: await native(url.pathname + url.search),
      });
    }
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
              ".png": "image/png",
              ".webp": "image/webp",
              ".woff2": "font/woff2",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
    } catch {
      return route.fulfill({ status: 404, body: "Local fixture: asset absent" });
    }
  });
  await page.addInitScript(() => {
    window.calendarAuthRequests = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (new Headers(init?.headers).get("x-two-island") !== "events-calendar")
        return nativeFetch(input, init);
      return new Promise((resolve) => {
        window.calendarAuthRequests.push({
          path: String(input),
          signal: init?.signal,
          resolve: resolve as unknown as Pending["resolve"],
        });
      });
    };
  });
  await page.goto(ORIGIN + entry);
  await expect(page.locator(SEARCH)).toBeVisible();
  const respond = async (index: number, transform: (html: string) => string = (html) => html) => {
    const path = await page.evaluate((i) => window.calendarAuthRequests[i]!.path, index);
    const original = await native(path, true);
    const body = transform(original);
    expect(body, "poison transform must alter the native fragment").not.toBe(original);
    await page.evaluate(
      ({ index, body }) => {
        window.calendarAuthRequests[index]!.resolve({ ok: true, text: async () => body });
      },
      { index, body },
    );
    // A browser task boundary drains the complete binder promise chain.
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 0)));
    return path;
  };
  const requested = async (count: number) => {
    await page.waitForFunction((count) => window.calendarAuthRequests.length === count, count);
    return page.evaluate((i) => window.calendarAuthRequests[i]!.path, count - 1);
  };
  return { native, unexpected, respond, requested };
}

async function destinations(page: Page, html?: string) {
  return page.evaluate(
    ({ html, header, hero, cards }) => {
      const doc =
        html === undefined ? document : new DOMParser().parseFromString(html, "text/html");
      const hrefs = (selector: string) =>
        Array.from(doc.querySelectorAll<HTMLAnchorElement>(selector)).map((link) =>
          link.getAttribute("href"),
        );
      return {
        header: hrefs(header),
        hero: hrefs(hero),
        cards: hrefs(cards),
        canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      };
    },
    { html, header: HEADER, hero: HERO, cards: CARDS },
  );
}

async function expectNative(page: Page, h: Harness, path: string) {
  const want = await destinations(page, await h.native(path));
  expect(want.header).toHaveLength(1);
  expect(want.hero).toHaveLength(1);
  const actual = await destinations(page);
  // Compare entire hrefs, not just next: source parameters and endpoints survive.
  expect.soft(actual.header).toEqual(want.header);
  expect.soft(actual.hero).toEqual(want.hero);
  expect.soft(actual.cards).toEqual(want.cards);
  expect.soft(actual.canonical).toEqual(want.canonical);
  expect(h.unexpected).toEqual([]);
}

async function snapshot(page: Page) {
  return page.evaluate(
    ({ root, header, hero, cards }) => ({
      zones: Array.from(document.querySelectorAll(`${root} [data-cal-zone]`)).map(
        (z) => z.innerHTML,
      ),
      state: { ...document.querySelector<HTMLElement>(root)!.dataset },
      links: [header, hero, cards].map((s) =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>(s)).map((a) =>
          a.getAttribute("href"),
        ),
      ),
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href,
      address: location.href,
    }),
    { root: ROOT, header: HEADER, hero: HERO, cards: CARDS },
  );
}

async function navigate(page: Page, h: Harness, path: string, index = 0) {
  // Use a keyboard-activated native anchor from the real rendered screen.
  await page
    .locator(`${ROOT} a[href=${JSON.stringify(path)}]`)
    .first()
    .focus();
  await page.keyboard.press("Enter");
  expect(await h.requested(index + 1)).toBe(path);
}

for (const renderer of ["hono", "kit"] as const) {
  test.describe(`${renderer}: calendar auth admission refuses poisoned fragments`, () => {
    test("healthy fragment commits native destinations (control)", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      await navigate(page, h, TARGET);
      // Identity transform would trip the must-change guard, so answer directly.
      const path = await page.evaluate(() => window.calendarAuthRequests[0]!.path);
      const body = await h.native(path, true);
      await page.evaluate((text) => {
        window.calendarAuthRequests[0]!.resolve({ ok: true, text: async () => text });
      }, body);
      await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 0)));
      await expect(page).toHaveURL(ORIGIN + TARGET);
      await expectNative(page, h, TARGET);
      expect((await destinations(page)).cards.length).toBeGreaterThan(0);
    });

    test("auth hrefs returning to the previous view cannot commit", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, TARGET);
      await h.respond(0, (html) => html.replaceAll(TARGET_NEXT, STALE_NEXT));
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      expect(h.unexpected).toEqual([]);
    });

    test("a duplicated next cannot commit", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, TARGET);
      await h.respond(0, (html) =>
        html.replace('href="/auth/discord?next=', `href="/auth/discord?${STALE_NEXT}&next=`),
      );
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      expect(h.unexpected).toEqual([]);
    });

    test("a missing next cannot commit", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, TARGET);
      await h.respond(0, (html) =>
        html.replace(`href="/auth/discord?${TARGET_NEXT}"`, 'href="/auth/discord?source=calendar"'),
      );
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      expect(h.unexpected).toEqual([]);
    });

    test("a header href on the wrong rooted endpoint cannot commit", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, TARGET);
      await h.respond(0, (html) =>
        html.replace('href="/auth/discord?next=', 'href="/join/discord?next='),
      );
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      expect(h.unexpected).toEqual([]);
    });

    test("a missing header source anchor cannot commit or clear the live link", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, TARGET);
      await h.respond(0, (html) =>
        html.replace(
          `<a class="btn" href="/auth/discord?${TARGET_NEXT}" data-testid="signin">Sign in with Discord</a>`,
          "",
        ),
      );
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      expect(h.unexpected).toEqual([]);
    });
  });
}
