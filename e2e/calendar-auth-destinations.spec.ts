/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  CALENDAR_AUTH_ORIGIN as ORIGIN,
  CALENDAR_AUTH_QUERY as QUERY,
  calendarAuthFixture,
} from "../test/helpers/calendar-auth";

type Pending = {
  path: string;
  signal?: AbortSignal | null;
  resolve: (response: { ok: boolean; text: () => Promise<string> }) => void;
};
declare global {
  interface Window {
    calendarAuthRequests: Pending[];
    calendarAuthInput: HTMLInputElement;
  }
}

const HEADER = 'header a[data-testid="signin"]';
const HERO = ".schedule-heading a";
const CARDS = '[data-cal-zone="content"] a[data-testid="signin"]';
const ROOT = '[data-island="events-calendar"]';
const SEARCH = '[data-testid="events-search"]';
const INITIAL = "/events";

type Harness = Awaited<ReturnType<typeof mount>>;

// The browser runs the real mounted app's HTML and shipped island. Only reads
// are local fixtures. Fragment fetches deliberately ignore abort so an obsolete
// body can finish after its successor, exercising admission rather than the network.
async function mount(page: Page, entry = INITIAL, renderer: "hono" | "kit" = "hono") {
  const fixture = calendarAuthFixture(renderer);
  const native = async (path: string, fragment = false) => {
    const response = await fixture.request(path, fragment);
    expect(response.status).toBe(200);
    return response.text();
  };
  const authClicks: string[] = [];
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
    if (["/auth/discord", "/join", "/join/discord"].includes(url.pathname)) {
      authClicks.push(url.pathname + url.search);
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Local auth destination sentinel</h1>",
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
  await page.evaluate((selector) => {
    window.calendarAuthInput = document.querySelector<HTMLInputElement>(selector)!;
  }, SEARCH);
  const respond = async (index: number, transform: (html: string) => string = (html) => html) => {
    const path = await page.evaluate((i) => window.calendarAuthRequests[i]!.path, index);
    const body = transform(await native(path, true));
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
  return { native, authClicks, unexpected, respond, requested };
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
  // Independent literal endpoint/return-path assertions keep the native oracle
  // honest: ordinary sign-in, join landing and card join entry are not interchangeable.
  for (const [kind, endpoint] of [
    ["header", "/auth/discord"],
    ["hero", "/join"],
    ["cards", "/join/discord"],
  ] as const) {
    for (const href of want[kind]) {
      const url = new URL(href!, ORIGIN);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe(endpoint);
      expect(url.searchParams.get("next")).toBe(path.split("#")[0]);
    }
  }
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
  test.describe(`${renderer}: calendar authentication follows the committed document`, () => {
    test("native guest links retain three distinct entry points (healthy control)", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      await expectNative(page, h, INITIAL);
      expect((await destinations(page)).cards.length).toBeGreaterThan(0);
    });

    test("search commits reserved and Unicode text, not a later unsent draft", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      await page.locator(SEARCH).fill(QUERY);
      await page.locator(SEARCH).press("Enter");
      const path = await h.requested(1);
      expect(new URL(path, ORIGIN).searchParams.get("q")).toBe(QUERY);
      await h.respond(0);
      await expect(page).toHaveURL(ORIGIN + path);
      await expectNative(page, h, path);
      expect((await destinations(page)).cards.length).toBeGreaterThan(0);
      await page.locator(SEARCH).fill("unsent draft");
      await expectNative(page, h, path);
      expect(
        await page.evaluate(
          () =>
            document.activeElement === window.calendarAuthInput &&
            document.querySelector('[data-testid="events-search"]') === window.calendarAuthInput,
        ),
      ).toBe(true);
    });

    for (const { name, entry, target } of [
      {
        name: "month",
        entry: "/events?view=calendar&month=2029-12",
        target: "/events?view=calendar&month=2030-01",
      },
      { name: "page", entry: INITIAL, target: "/events?page=2" },
      { name: "past drawer", entry: INITIAL, target: "/events?past=1" },
      { name: "list view", entry: "/events?view=calendar&month=2030-01", target: INITIAL },
    ]) {
      test(`${name} commits all destinations with its displayed zones`, async ({ page }) => {
        const h = await mount(page, entry, renderer);
        await navigate(page, h, target);
        await h.respond(0);
        await expect(page).toHaveURL(ORIGIN + target);
        await expectNative(page, h, target);
        if (name !== "month") expect((await destinations(page)).cards.length).toBeGreaterThan(0);
        expect(
          await page.evaluate(
            () =>
              document.querySelector('[data-testid="events-search"]') === window.calendarAuthInput,
          ),
        ).toBe(true);
      });
    }

    test("Back and Forward restore the links without creating history entries", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      const target = "/events?past=1";
      await navigate(page, h, target);
      await h.respond(0);
      const historyLength = await page.evaluate(() => history.length);
      await page.evaluate(() => history.back());
      await h.requested(2);
      await h.respond(1);
      await expectNative(page, h, INITIAL);
      await page.evaluate(() => history.forward());
      await h.requested(3);
      await h.respond(2);
      await expectNative(page, h, target);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    });

    test("a failed fragment leaves links and zones unchanged and supports keyboard retry", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, "/events?past=1");
      await page.evaluate(() =>
        window.calendarAuthRequests[0]!.resolve({ ok: false, text: async () => "unavailable" }),
      );
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      await page.locator(SEARCH).focus();
      await page.keyboard.press("Enter");
      await h.requested(2);
      await h.respond(1);
      await expectNative(page, h, INITIAL);
      await expect(page.locator(SEARCH)).toBeFocused();
    });

    for (const order of ["old first", "new first"]) {
      test(`superseded fragments cannot publish destinations (${order})`, async ({ page }) => {
        const h = await mount(page, INITIAL, renderer);
        await navigate(page, h, "/events?page=2");
        await page.locator(SEARCH).fill(QUERY);
        await page.locator(SEARCH).press("Enter");
        const target = await h.requested(2);
        expect(await page.evaluate(() => window.calendarAuthRequests[0]!.signal!.aborted)).toBe(
          true,
        );
        if (order === "old first") {
          const before = await destinations(page);
          await h.respond(0);
          expect(await destinations(page)).toEqual(before);
          await h.respond(1);
        } else {
          await h.respond(1);
          const committed = await snapshot(page);
          await h.respond(0);
          expect(await snapshot(page)).toEqual(committed);
        }
        await expectNative(page, h, target);
      });
    }

    test("new typing invalidates an active search before its debounce fires", async ({ page }) => {
      const h = await mount(page, INITIAL, renderer);
      await page.locator(SEARCH).fill("Raid");
      await page.locator(SEARCH).press("Enter");
      await h.requested(1);
      const before = await snapshot(page);
      await page.locator(SEARCH).fill("new unsent draft");
      await h.respond(0);
      expect(await snapshot(page)).toEqual(before);
      await expectNative(page, h, INITIAL);
      await expect(page.locator(SEARCH)).toHaveValue("new unsent draft");
    });

    for (const bad of [
      "https://evil.example/events",
      "//evil.example/events",
      "/\\evil.example/events",
    ]) {
      test(`a non-local canonical cannot taint committed destinations: ${bad}`, async ({
        page,
      }) => {
        const h = await mount(page, INITIAL, renderer);
        const before = await snapshot(page);
        await navigate(page, h, "/events?past=1");
        await h.respond(0, (html) =>
          html.replace(/(<link\b[^>]*rel="canonical"[^>]*href=")[^"]*/, `$1${bad}`),
        );
        const after = await snapshot(page);
        if (after.address === before.address) expect(after).toEqual(before);
        else await expectNative(page, h, "/events?past=1");
      });
    }

    test("an unimportable final zone cannot partially install outer destinations", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await page.evaluate(() => {
        const original = document.importNode.bind(document);
        document.importNode = (node, deep) => {
          if (node.parentElement?.getAttribute("data-cal-zone") === "content")
            throw new Error("Fixture final-zone import refused");
          return original(node, deep);
        };
      });
      await navigate(page, h, "/events?past=1");
      await h.respond(0);
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
      await expectNative(page, h, INITIAL);
    });

    test("a newer draft survives a page commit but is not installed as the auth return", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      await navigate(page, h, "/events?page=2");
      await page.locator(SEARCH).fill("draft while page is loading");
      await h.respond(0);
      await expectNative(page, h, "/events?page=2");
      await expect(page.locator(SEARCH)).toHaveValue("draft while page is loading");
      await expect(page.locator(SEARCH)).toBeFocused();
    });

    test("duplicate zone admission refuses all outer and inner destination changes", async ({
      page,
    }) => {
      const h = await mount(page, INITIAL, renderer);
      const before = await snapshot(page);
      await navigate(page, h, "/events?past=1");
      await h.respond(0, (html) => html.replace('data-cal-zone="content"', 'data-cal-zone="head"'));
      await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
      expect(await snapshot(page)).toEqual(before);
    });

    for (const endpoint of ["/auth/discord", "/join", "/join/discord"]) {
      test(`untrusted ${endpoint} replacement cannot create an open redirect or partial commit`, async ({
        page,
      }) => {
        const h = await mount(page, INITIAL, renderer);
        const before = await snapshot(page);
        await navigate(page, h, "/events?past=1");
        await h.respond(0, (html) =>
          html.replaceAll(`href="${endpoint}?`, `href="https://evil.example${endpoint}?`),
        );
        const after = await snapshot(page);
        // Either reject the complete fragment, or derive the complete safe native
        // set independently. Never copy an unsafe field or publish only some links.
        if (after.address === before.address) expect(after).toEqual(before);
        else await expectNative(page, h, "/events?past=1");
        const links = await destinations(page);
        for (const href of [...links.header, ...links.hero, ...links.cards]) {
          const url = new URL(href!, ORIGIN);
          expect(url.origin).toBe(ORIGIN);
          expect(new URL(url.searchParams.get("next")!, ORIGIN).origin).toBe(ORIGIN);
        }
      });
    }

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      test(`captures native and committed CTA states at ${viewport.width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize(viewport);
        const h = await mount(page, INITIAL, renderer);
        await page.screenshot({
          path: info.outputPath(`${renderer}-${viewport.width}-native.png`),
        });
        await page.getByTestId("events-past-toggle").click();
        await h.requested(1);
        await h.respond(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: info.outputPath(`${renderer}-${viewport.width}-committed.png`),
        });
        await expectNative(page, h, "/events?past=1");
      });
    }

    for (const selector of [HEADER, HERO]) {
      test(`clicks the actual outer CTA after a commit without contacting Discord: ${selector}`, async ({
        page,
      }) => {
        const h = await mount(page, INITIAL, renderer);
        // Click the actual outer anchor; intercept its local entry before OAuth.
        await page.getByTestId("events-past-toggle").click();
        const path = await h.requested(1);
        const nativeLinks = await destinations(page, await h.native(path));
        const want = selector === HEADER ? nativeLinks.header[0]! : nativeLinks.hero[0]!;
        await h.respond(0);
        await expect(page).toHaveURL(ORIGIN + path);
        await page.locator(selector).click();
        await expect(
          page.getByRole("heading", { name: "Local auth destination sentinel" }),
        ).toBeVisible();
        expect(h.authClicks).toEqual([want]);
        expect(h.unexpected).toEqual([]);
      });
    }
  });
}
