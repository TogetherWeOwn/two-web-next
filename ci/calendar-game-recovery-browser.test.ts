// Standalone, unconditional real Chromium acceptance. No DB or external traffic.
// Run: npx vitest run --config ci/calendar-game-recovery-browser.vitest.ts
// Builder owns registration in browser CI and before/after visual/a11y evidence.
// Test Author owns this file: implement the behavior, never edit these assertions.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { EVENTS_CALENDAR_READ_DEADLINE_MS } from "../src/islands/contracts";
import {
  GAME_BUNDLES,
  GAME_ENTRY,
  GAME_ORIGIN,
  GAME_TWINS,
  gameRecoveryFixture,
  type GameTwin,
} from "../test/helpers/calendar-game-recovery";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url)).replace(/\/+$/, "");
const source = readFileSync(
  new URL("../assets/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const shipped = readFileSync(
  new URL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const NOW = new Date("2026-10-24T12:00:00Z");
const contexts: BrowserContext[] = [];
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
beforeEach(() => __resetAnonEventCacheForTests());
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});
afterAll(async () => {
  await browser?.close();
});

async function open(
  twin: GameTwin,
  bundle: (typeof GAME_BUNDLES)[number],
  entry = GAME_ENTRY,
  javaScriptEnabled = true,
) {
  const fixture = gameRecoveryFixture();
  const context = await browser.newContext({
    javaScriptEnabled,
    locale: "en-GB",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
  });
  contexts.push(context);
  const reads: { route: Route; path: string; method: string; answered: boolean }[] = [];
  const documents: string[] = [];
  const forbidden: string[] = [];
  const publicFulfilled: string[] = [];
  const publicAborted: string[] = [];
  let calendarLoads = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== GAME_ORIGIN) {
      forbidden.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/events") {
      const path = url.pathname + url.search;
      if (request.headers()["x-two-island"] === "events-calendar") {
        reads.push({ route, path, method: request.method(), answered: false });
        return;
      }
      documents.push(path);
      const response = await fixture.render(twin, path);
      return route.fulfill({
        status: response.status,
        body: await response.text(),
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/islands/events-calendar.js") {
      calendarLoads++;
      return route.fulfill({
        body: bundle === "source" ? source : shipped,
        contentType: "application/javascript",
      });
    }
    const path = resolve(publicDir, `.${url.pathname}`);
    if (!path.startsWith(publicDir + "/")) {
      publicAborted.push(url.pathname);
      return route.abort();
    }
    try {
      const contentType =
        (
          {
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".png": "image/png",
          } as Record<string, string>
        )[extname(path)] ?? "application/octet-stream";
      publicFulfilled.push(url.pathname);
      return route.fulfill({ body: readFileSync(path), contentType });
    } catch {
      publicAborted.push(url.pathname);
      return route.abort();
    }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (javaScriptEnabled) {
    await page.clock.install({ time: NOW });
    // Install runs before application code; pause ahead of the installation tick
    // so transport/scheduler latency cannot turn this into a backwards clock jump.
    await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  }
  await page.goto(GAME_ORIGIN + entry);
  await page.getByTestId("events-game-filter").waitFor();
  const input = page.getByTestId("events-search");
  const game = page.getByTestId("events-game-filter");
  const status = page.getByTestId("events-read-status");
  const retry = page.getByTestId("events-read-retry");
  const dismiss = page.getByTestId("events-read-clear");
  const content = page.locator('[data-cal-zone="content"]');
  const original = await content.innerHTML();
  const historyLength = await page.evaluate(() => history.length);
  const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
  const signin = await page
    .getByRole("navigation", { name: "Account" })
    .getByTestId("signin")
    .getAttribute("href");
  if (javaScriptEnabled) {
    await page.evaluate(() => {
      (window as unknown as { originalSearch: Element | null }).originalSearch =
        document.querySelector('[data-testid="events-search"]');
    });
  }
  async function count(want: number) {
    await expect.poll(() => reads.length).toBe(want);
  }
  async function submit(value: string, q?: string) {
    await game.selectOption(value);
    if (q !== undefined) await input.fill(q);
    await page.getByRole("button", { name: /^Search$/ }).focus();
    await page.keyboard.press("Enter");
  }
  async function reply(
    index: number,
    code = 503,
    options: { retryAfter?: string; malformed?: boolean; crossOrigin?: boolean } = {},
  ) {
    await expect.poll(() => reads.length).toBeGreaterThanOrEqual(index + 1);
    const read = reads[index]!;
    read.answered = true;
    let body = "Fixture read refused";
    if (code === 200) {
      body = await (await fixture.render(twin, read.path, true)).text();
      if (options.malformed)
        body = body.replace(/data-cal-zone="content"/g, 'data-wrong-zone="content"');
      if (options.crossOrigin)
        body = body.replace(
          /href="https:\/\/calendar\.example\.test\/events"/g,
          'href="https://outside.example/events"',
        );
    }
    await read.route.fulfill({
      status: code,
      body,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...(options.retryAfter ? { "retry-after": options.retryAfter } : {}),
      },
    });
  }
  async function failed() {
    await expect.poll(() => retry.isVisible()).toBe(true);
    expect(await status.getAttribute("role")).toBe("status");
    expect(await retry.getAttribute("type")).toBe("button");
    expect(await dismiss.getAttribute("type")).toBe("button");
    expect(await retry.getAttribute("tabindex")).not.toBe("-1");
    expect(await retry.innerText()).toMatch(/try again|retry/i);
    expect(await dismiss.innerText()).toMatch(/dismiss|return|keep/i);
  }
  async function retained() {
    expect(await content.innerHTML()).toBe(original);
    expect(page.url()).toBe(GAME_ORIGIN + entry);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(canonical);
    expect(
      await page
        .getByRole("navigation", { name: "Account" })
        .getByTestId("signin")
        .getAttribute("href"),
    ).toBe(signin);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { originalSearch: Element }).originalSearch ===
          document.querySelector('[data-testid="events-search"]'),
      ),
    ).toBe(true);
  }
  function clean() {
    expect(errors).toEqual([]);
    expect(forbidden).toEqual([]);
    expect(reads.every((read) => read.method === "GET")).toBe(true);
    if (javaScriptEnabled) {
      expect(calendarLoads).toBe(1);
      // Styled suite: a non-calendar public asset must fulfil, never abort.
      expect(publicFulfilled).toContain("/islands/copy-link.js");
      expect(publicFulfilled.some((p) => p.endsWith(".css"))).toBe(true);
      expect(publicAborted.filter((p) => p.endsWith(".css") || p.startsWith("/islands/"))).toEqual(
        [],
      );
    }
    expect(documents).toHaveLength(1);
  }
  return {
    page,
    fixture,
    reads,
    input,
    game,
    status,
    retry,
    dismiss,
    content,
    original,
    submit,
    reply,
    count,
    failed,
    retained,
    clean,
    documents,
  };
}

for (const twin of GAME_TWINS)
  for (const bundle of GAME_BUNDLES) {
    describe(`${twin} ${bundle} real game recovery`, () => {
      it("A1.1 game-only failure distinguishes attempted Go from retained Chess", async () => {
        const h = await open(twin, bundle);
        await h.submit("Go");
        await h.reply(0);
        await h.failed();
        await h.retained();
        const text = await h.status.innerText();
        expect(text).toMatch(/couldn.t load|not loaded|failed|could not load/i);
        expect.soft(text, "attempted game must be named").toContain("Go");
        expect.soft(text, "last-good game must be named separately").toContain("Chess");
        expect(text).toMatch(/still|kept|showing|retain/i);
        h.clean();
      });

      it("A1.1 combined q+game failure names both attempted and retained scopes", async () => {
        const h = await open(twin, bundle, GAME_ENTRY + "&q=fixture");
        await h.submit("Go", "absent words");
        await h.reply(0);
        await h.failed();
        await h.retained();
        const text = await h.status.innerText();
        for (const scope of ["Go", "Chess", "absent words", "fixture"])
          expect(text).toContain(scope);
        h.clean();
      });

      it("A1.2 Dismiss restores committed q AND game, without GET, history or DOM work", async () => {
        const h = await open(twin, bundle, GAME_ENTRY + "&q=fixture");
        await h.submit("Go", "absent words");
        await h.reply(0);
        await h.failed();
        await h.dismiss.focus();
        await h.page.keyboard.press("Enter");
        await expect.poll(() => h.dismiss.isVisible()).toBe(false);
        expect(await h.input.inputValue()).toBe("fixture");
        expect.soft(await h.game.inputValue()).toBe("Chess");
        await h.page.clock.runFor(1000);
        expect(h.reads).toHaveLength(1);
        await h.retained();
        h.clean();
      });

      it("A1.3 CONTROL newer unsent q/select edits revoke an older pending failure", async () => {
        const h = await open(twin, bundle, GAME_ENTRY + "&q=fixture");
        await h.submit("Go", "absent words");
        await h.count(1);
        await h.game.selectOption("");
        await h.input.fill("newer draft");
        await h.reply(0);
        await h.page.clock.runFor(1);
        expect(await h.input.inputValue()).toBe("newer draft");
        expect(await h.game.inputValue()).toBe("");
        expect(await h.input.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await h.retry.isVisible()).toBe(false);
        expect(await h.dismiss.isVisible()).toBe(false);
        expect(h.reads).toHaveLength(1);
        await h.retained();
        h.clean();
      });

      it("A1.3 newer edits after failure survive any still-available Dismiss", async () => {
        const h = await open(twin, bundle, GAME_ENTRY + "&q=fixture");
        await h.submit("Go", "absent words");
        await h.reply(0);
        await h.failed();
        await h.game.selectOption("");
        await h.input.fill("newer draft");
        // Either revoke recovery on edit or preserve the edited controls on Dismiss.
        // An obsolete action is not required to remain visible.
        if (await h.dismiss.isVisible()) await h.dismiss.click();
        expect(await h.input.inputValue()).toBe("newer draft");
        expect(await h.game.inputValue()).toBe("");
        expect(h.reads).toHaveLength(1);
        await h.retained();
        h.clean();
      });

      it("A1.3 CONTROL an older successful retry cannot overwrite newer unsent game/query edits", async () => {
        const h = await open(twin, bundle);
        await h.submit("Go");
        await h.reply(0);
        await h.failed();
        await h.retry.click();
        await h.count(2);
        await h.game.selectOption("");
        await h.input.fill("newest draft");
        await h.reply(1, 200);
        await expect.poll(() => h.page.getByTestId("events-loading").isVisible()).toBe(false);
        expect(await h.input.inputValue()).toBe("newest draft");
        expect(await h.game.inputValue()).toBe("");
        expect(await h.input.evaluate((node) => node === document.activeElement)).toBe(true);
        // Unsent edits own controls, not a newly submitted history entry. A retry
        // may commit its admitted snapshot, but never overwrite those drafts.
        const committed = new URL(h.page.url()).searchParams.get("game");
        expect(["Chess", "Go"]).toContain(committed);
        expect(await h.content.innerText()).toMatch(new RegExp(`${committed} fixture night`, "i"));
        expect(h.reads).toHaveLength(2);
        h.clean();
      });

      it("A1.4 CONTROL superseded late failure cannot replace a newer successful game intent", async () => {
        const h = await open(twin, bundle);
        await h.submit("Go");
        await h.count(1);
        await h.submit("");
        await h.count(2);
        await h.reply(1, 200);
        await expect.poll(() => new URL(h.page.url()).searchParams.get("game")).toBe(null);
        expect(await h.content.innerText()).toMatch(/Go fixture night/i);
        await h.reply(0);
        await h.page.clock.runFor(1);
        expect(await h.retry.isVisible()).toBe(false);
        expect(await h.game.inputValue()).toBe("");
        h.clean();
      });

      it("A1.5 CONTROL 429 cooldown is manual, bounded, GET-only and retries exact q+game", async () => {
        const h = await open(twin, bundle, GAME_ENTRY + "&q=fixture");
        await h.submit("Go", "fixture");
        await h.reply(0, 429, { retryAfter: "2" });
        await h.failed();
        expect(await h.retry.isDisabled()).toBe(true);
        await h.page.clock.runFor(1999);
        expect(h.reads).toHaveLength(1);
        expect(await h.retry.isDisabled()).toBe(true);
        await h.page.clock.runFor(1);
        expect(await h.retry.isDisabled()).toBe(false);
        expect(h.reads).toHaveLength(1);
        await h.retry.focus();
        await h.page.keyboard.press("Enter");
        await h.count(2);
        expect(h.reads[1]!.path).toBe(h.reads[0]!.path);
        const target = new URL(h.reads[1]!.path, GAME_ORIGIN);
        expect(target.searchParams.get("game")).toBe("Go");
        expect(target.searchParams.get("q")).toBe("fixture");
        await h.reply(1, 200);
        await expect.poll(() => new URL(h.page.url()).searchParams.get("game")).toBe("Go");
        expect(await h.content.innerText()).toMatch(/Go fixture night/i);
        expect(await h.content.innerText()).not.toMatch(/Chess fixture night/i);
        expect(await h.game.inputValue()).toBe("Go");
        expect(await h.retry.isVisible()).toBe(false);
        await h.page.clock.runFor(60_000);
        expect(h.reads).toHaveLength(2);
        h.clean();
      });

      it("A1.6 CONTROL header deadline retains last-good Chess without automatic retry", async () => {
        const h = await open(twin, bundle);
        await h.submit("Go");
        await h.count(1);
        await h.page.clock.runFor(EVENTS_CALENDAR_READ_DEADLINE_MS - 1);
        expect(await h.retry.isVisible()).toBe(false);
        await h.page.clock.runFor(1);
        await h.failed();
        await h.retained();
        await h.page.clock.runFor(60_000);
        expect(h.reads).toHaveLength(1);
        h.clean();
      });

      it.each(["malformed", "crossOrigin"] as const)(
        "A1.6 CONTROL %s fragment cannot partially commit game/content/auth/history",
        async (invalid) => {
          const h = await open(twin, bundle);
          await h.submit("Go");
          await h.reply(0, 200, { [invalid]: true });
          await h.failed();
          await h.retained();
          h.clean();
        },
      );

      it("A1.6 CONTROL successful game turn then Back/Forward reconcile selected scope", async () => {
        const h = await open(twin, bundle);
        await h.submit("Go");
        await h.reply(0, 200);
        await expect.poll(() => new URL(h.page.url()).searchParams.get("game")).toBe("Go");
        await h.page.evaluate(() => history.back());
        await h.count(2);
        await h.reply(1, 200);
        await expect.poll(() => h.game.inputValue()).toBe("Chess");
        expect(await h.content.innerText()).toMatch(/Chess fixture night/i);
        await h.page.evaluate(() => history.forward());
        await h.count(3);
        await h.reply(2, 200);
        await expect.poll(() => h.game.inputValue()).toBe("Go");
        expect(await h.content.innerText()).toMatch(/Go fixture night/i);
        h.clean();
      });

      it("A1.1 unknown game recovery names effective All games, never an invented scope", async () => {
        const h = await open(twin, bundle, "/events?game=Unrecognized");
        expect(await h.game.inputValue()).toBe("");
        expect(await h.content.innerText()).toMatch(/Chess fixture night/i);
        expect(await h.content.innerText()).toMatch(/Go fixture night/i);
        await h.submit("Go");
        await h.reply(0);
        await h.failed();
        expect(await h.status.innerText()).toMatch(/all games/i);
        expect(await h.status.innerText()).not.toMatch(/for [“"']?Unrecognized/);
        h.clean();
      });

      it("A1.3 pending navigation with newer game-only draft suppresses recovery and keeps the draft", async () => {
        const h = await open(twin, bundle);
        await h.page.getByTestId("events-view-calendar").click();
        await h.count(1);
        await h.game.selectOption("Go");
        await h.reply(0);
        await expect.poll(() => h.page.getByTestId("events-loading").isVisible()).toBe(false);
        expect(await h.retry.isVisible()).toBe(false);
        expect(await h.dismiss.isVisible()).toBe(false);
        expect(await h.game.inputValue()).toBe("Go");
        expect(h.reads).toHaveLength(1);
        await h.retained();
        h.clean();
      });

      it("A1.1 navigation from unknown game names effective All games, never the raw URL scope", async () => {
        const h = await open(twin, bundle, "/events?game=Unrecognized");
        expect(await h.game.inputValue()).toBe("");
        await h.page.getByTestId("events-view-calendar").click();
        await h.reply(0);
        await h.failed();
        await h.retained();
        const text = await h.status.innerText();
        expect(text).toMatch(/all games/i);
        expect(text).not.toMatch(/Unrecognized/);
        h.clean();
      });

      it("A1.10 CONTROL no-JS native GET select is labeled and submits the real game", async () => {
        const h = await open(twin, bundle, GAME_ENTRY, false);
        expect(await h.page.getByLabel("Filter by game").count()).toBe(1);
        expect(await h.game.inputValue()).toBe("Chess");
        await h.game.selectOption("Go");
        await h.page.getByRole("button", { name: /^Search$/ }).focus();
        await h.page.keyboard.press("Enter");
        await h.page.waitForURL(/game=Go/);
        expect(await h.game.inputValue()).toBe("Go");
        expect(await h.content.innerText()).toMatch(/Go fixture night/i);
        expect(h.reads).toHaveLength(0);
        expect(h.documents).toHaveLength(2);
      });
    });
  }
