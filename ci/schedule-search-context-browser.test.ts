// Standalone, unconditional Chromium acceptance. Builder owns browser-CI
// registration and UI evidence; corrections to this oracle return to its author.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  GAME_ORIGIN,
  GAME_TWINS,
  gameRecoveryFixture,
  gameRow,
  type GameTwin,
} from "../test/helpers/calendar-game-recovery";

const publicRoot = resolve("public");
const title = `${"A long community evening ".repeat(7)}NEEDLE and BLADE snacks`;
const description = `${"Unrelated introduction. ".repeat(40)}Bring your NEEDLE deck, BLADE cards and snacks. ${"Additional context. ".repeat(40)}`;
const rows = Array.from({ length: 21 }, (_, i) => ({
  ...gameRow(i + 1, "Chess"),
  eventKey: `schedule-context-${i + 1}`,
  title: `${title} ${i + 1}`,
  description,
}));

let browser: Browser;
let context: BrowserContext | undefined;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  await context?.close();
  context = undefined;
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => __resetAnonEventCacheForTests());

async function visibleCards(page: Page) {
  return page
    .locator('[data-testid="events-list"] [data-testid="event-card"]')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const heading = card.querySelector("h3")!;
        const excerpt = card.querySelector(".schedule-excerpt")!;
        return {
          key: card.getAttribute("data-event-key"),
          title: heading.textContent,
          titleMarks: Array.from(
            heading.querySelectorAll("mark") as ArrayLike<{ textContent: string | null }>,
            (mark) => mark.textContent,
          ),
          passage: excerpt?.textContent,
          passageMarks: Array.from(
            (excerpt?.querySelectorAll("mark") ?? []) as ArrayLike<{ textContent: string | null }>,
            (mark) => mark.textContent,
          ),
          html: card.outerHTML,
        };
      }),
    );
}

async function openJourney(twin: GameTwin, width = 390, javaScriptEnabled = true) {
  const fixture = gameRecoveryFixture({ upcomingRows: rows, pastRows: [] });
  const requests: { path: string; fragment: boolean }[] = [];
  let fail = false;
  context = await browser.newContext({
    javaScriptEnabled,
    viewport: { width, height: width === 390 ? 844 : 800 },
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== GAME_ORIGIN) return route.abort("blockedbyclient");
    if (url.pathname === "/events") {
      const fragment = request.headers()["x-two-island"] === "events-calendar";
      requests.push({ path: url.pathname + url.search, fragment });
      if (fail && fragment) {
        fail = false;
        return route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" });
      }
      const response = await fixture.render(twin, url.pathname + url.search, fragment, url.origin);
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    }
    const file = resolve(publicRoot, `.${url.pathname}`);
    if (!file.startsWith(`${publicRoot}/`) || !existsSync(file))
      return route.fulfill({ status: 404, body: "" });
    const contentType = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".svg")
          ? "image/svg+xml"
          : "application/octet-stream";
    return route.fulfill({ contentType, body: readFileSync(file) });
  });
  const page = await context.newPage();
  await page.goto(`${GAME_ORIGIN}/events?q=needle&game=Chess`);
  await page.locator('[data-testid="events-list"]').waitFor();
  return {
    page,
    requests,
    failNext: () => {
      fail = true;
    },
  };
}

async function assertNeedle(page: Page) {
  const cards = await visibleCards(page);
  expect(cards).toHaveLength(20);
  expect.soft(cards[0]?.title).toBe(`${title} 1`);
  expect.soft(cards[0]?.titleMarks).toEqual(["NEEDLE"]);
  expect.soft(cards[0]?.passageMarks).toEqual(["NEEDLE"]);
  expect.soft(cards[0]?.passage).toContain("Bring your NEEDLE deck, BLADE cards and snacks.");
  expect(new URL(page.url()).searchParams.get("q")).toBe("needle");
  expect(new URL(page.url()).searchParams.get("game")).toBe("Chess");
}

for (const twin of GAME_TWINS) {
  describe(`${twin} schedule committed match context in Chromium`, () => {
    for (const width of [1280, 390]) {
      it(`${width}: keyboard paging, disclosure, history and Clear keep committed context`, async () => {
        const { page, requests } = await openJourney(twin, width);
        await assertNeedle(page);
        await page.evaluate("window.__scheduleSameDocument = true");
        const summary = page.locator('[data-testid="events-list"] details summary').first();
        await summary.focus();
        await summary.press("Enter");
        expect(
          await page.locator('[data-testid="events-list"] details').first().getAttribute("open"),
        ).not.toBeNull();
        expect(
          await page.locator('[data-testid="events-list"] details p').first().textContent(),
        ).toBe(description);
        const next = page.locator('[data-testid="events-pager-next"]');
        await next.focus();
        await next.press("Enter");
        await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2");
        const secondPage = await visibleCards(page);
        expect(secondPage).toHaveLength(1);
        expect(secondPage[0]?.key).toBe("schedule-context-21");
        expect.soft(secondPage[0]?.titleMarks).toEqual(["NEEDLE"]);
        expect.soft(secondPage[0]?.passageMarks).toEqual(["NEEDLE"]);
        expect(await page.evaluate("window.__scheduleSameDocument")).toBe(true);
        expect(requests.filter((request) => request.fragment)).toHaveLength(1);
        await page.goBack();
        await expect.poll(async () => (await visibleCards(page)).length).toBe(20);
        await assertNeedle(page);
        await page.goForward();
        await expect.poll(async () => (await visibleCards(page)).length).toBe(1);
        expect.soft((await visibleCards(page))[0]?.passageMarks).toEqual(["NEEDLE"]);
        await page.reload();
        expect.soft((await visibleCards(page))[0]?.passageMarks).toEqual(["NEEDLE"]);
        await page.locator('[data-testid="events-search-clear"]').click();
        await expect.poll(() => new URL(page.url()).searchParams.has("q")).toBe(false);
        expect(new URL(page.url()).searchParams.get("game")).toBe("Chess");
        const ordinary = await visibleCards(page);
        expect(ordinary).toHaveLength(1);
        expect(ordinary[0]?.key).toBe("schedule-context-21");
        expect(
          ordinary.every((card) => card.titleMarks.length === 0 && card.passageMarks.length === 0),
        ).toBe(true);
        expect(ordinary[0]?.passage).toBe(`${[...description].slice(0, 240).join("")}…`);
        expect(await page.locator('[data-testid="events-search"]').inputValue()).toBe("");
      });
    }

    it("no JavaScript: native search and disclosure explain matches without an island", async () => {
      const { page, requests } = await openJourney(twin, 390, false);
      await assertNeedle(page);
      const input = page.locator('[data-testid="events-search"]');
      await input.fill("  blade  ");
      await input.press("Enter");
      await expect.poll(async () => (await visibleCards(page))[0]?.title).toBe(`${title} 1`);
      await page.waitForURL((url) => (url.searchParams.get("q") ?? "").includes("blade"));
      const cards = await visibleCards(page);
      expect.soft(cards[0]?.titleMarks).toEqual(["BLADE"]);
      expect.soft(cards[0]?.passageMarks).toEqual(["BLADE"]);
      const summary = page.locator('[data-testid="events-list"] details summary').first();
      await summary.focus();
      await summary.press("Enter");
      expect(
        await page.locator('[data-testid="events-list"] details p').first().textContent(),
      ).toBe(description);
      expect(
        await page.locator('[data-testid="events-list"] details').first().getAttribute("open"),
      ).not.toBeNull();
      expect(requests.every((request) => !request.fragment)).toBe(true);
      expect(new URL(page.url()).searchParams.get("game")).toBe("Chess");
    });

    it("failed fragments never put draft highlights over committed cards; retry commits them together", async () => {
      const { page, failNext, requests } = await openJourney(twin);
      const before = await visibleCards(page);
      const committed = page.url();
      const input = page.locator('[data-testid="events-search"]');
      failNext();
      await input.fill("blade");
      await input.press("Enter");
      await expect
        .poll(() => page.locator('[data-testid="events-read-status"]').textContent())
        .not.toBe("");
      expect(page.url()).toBe(committed);
      expect(await visibleCards(page)).toEqual(before);
      expect.soft(before[0]?.titleMarks).toEqual(["NEEDLE"]);
      expect.soft(before[0]?.passageMarks).toEqual(["NEEDLE"]);
      expect(await input.inputValue()).toBe("blade");
      expect(requests.filter((request) => request.fragment)).toHaveLength(1);
      await page.locator('[data-testid="events-read-retry"]').click();
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("blade");
      const after = await visibleCards(page);
      expect.soft(after[0]?.titleMarks).toEqual(["BLADE"]);
      expect.soft(after[0]?.passageMarks).toEqual(["BLADE"]);
      expect(requests.filter((request) => request.fragment)).toHaveLength(2);
      await page.goBack();
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("needle");
      await expect.poll(() => input.inputValue()).toBe("needle");
      expect.soft((await visibleCards(page))[0]?.titleMarks).toEqual(["NEEDLE"]);
      expect.soft((await visibleCards(page))[0]?.passageMarks).toEqual(["NEEDLE"]);
      await page.goForward();
      await expect.poll(() => input.inputValue()).toBe("blade");
      expect(new URL(page.url()).searchParams.get("q")).toBe("blade");
      expect.soft((await visibleCards(page))[0]?.titleMarks).toEqual(["BLADE"]);
      expect.soft((await visibleCards(page))[0]?.passageMarks).toEqual(["BLADE"]);
    });

    it("a superseded response body cannot install stale highlights after the newer query commits", async () => {
      const { page, requests } = await openJourney(twin);
      // Delay only the network body boundary. Ignore abort for this one fetch
      // so the real shipped binder must reject a late successful response.
      await page.evaluate(`(() => {
        const native = window.fetch.bind(window);
        let held = false;
        window.fetch = async (url, init) => {
          const target = new URL(typeof url === 'string' ? url : url.url, location.href);
          const delay = !held && target.searchParams.get('q') === 'blade';
          if (delay) held = true;
          const response = await native(url, delay ? { ...init, signal: undefined } : init);
          if (delay) {
            const body = await response.text();
            Object.defineProperty(response, 'text', { value: () => new Promise(resolve => {
              window.__scheduleBodyHeld = true;
              window.__releaseScheduleBody = () => { resolve(body); window.__scheduleBodyReleased = true; };
            }) });
          }
          return response;
        };
      })()`);
      const input = page.locator('[data-testid="events-search"]');
      await input.fill("blade");
      await input.press("Enter");
      await page.waitForFunction("window.__scheduleBodyHeld === true");
      expect.soft((await visibleCards(page))[0]?.titleMarks).toEqual(["NEEDLE"]);
      await input.fill("snacks");
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("snacks");
      const committed = await visibleCards(page);
      expect.soft(committed[0]?.titleMarks).toEqual(["snacks"]);
      expect.soft(committed[0]?.passageMarks).toEqual(["snacks"]);
      await page.evaluate("window.__releaseScheduleBody()");
      // Drain the released text promise and the binder's continuation, without
      // sleeping or changing timers in application code.
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      expect(await visibleCards(page)).toEqual(committed);
      expect(new URL(page.url()).searchParams.get("q")).toBe("snacks");
      expect(await input.inputValue()).toBe("snacks");
      expect(requests.filter((request) => request.fragment)).toHaveLength(2);
    });
  });
}
