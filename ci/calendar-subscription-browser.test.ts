// Local, intercepted fixtures only; not the Wrangler/DB browser-smoke suite.
// Run: npx vitest run --config ci/calendar-subscription-browser.vitest.ts
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FEED_URL,
  ORIGIN,
  SURFACES,
  subscriptionFixture,
  type Surface,
} from "../test/helpers/calendar-subscription-fixture";

type Mode = "resolve" | "reject" | "missing" | "missing-write" | "throw" | "pending";
type Probe = {
  mode: Mode;
  writes: string[];
  reads: number;
  unhandled: number;
  settle?: (ok: boolean) => void;
  settleAll?: (ok: boolean) => void;
};
let browser: Browser;
let fixture: Awaited<ReturnType<typeof subscriptionFixture>>;
const publicDir = fileURLToPath(new URL("../public/", import.meta.url).href);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture = await subscriptionFixture();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  fixture?.dispose();
  vi.useRealTimers();
});

async function open(
  surface: Surface,
  mode: Mode = "resolve",
  javaScriptEnabled = true,
  viewport = { width: 1280, height: 800 },
) {
  const context = await browser.newContext({
    javaScriptEnabled,
    viewport,
    locale: "en-GB",
    timezoneId: "UTC",
  });
  const errors: string[] = [];
  await context.addInitScript((initialMode) => {
    const settlements: Array<(ok: boolean) => void> = [];
    const probe: Probe = {
      mode: initialMode,
      writes: [],
      reads: 0,
      unhandled: 0,
      settleAll: (ok) => {
        for (const settle of settlements.splice(0)) settle(ok);
      },
    };
    (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe = probe;
    window.addEventListener("unhandledrejection", () => {
      probe.unhandled++;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => {
        if (probe.mode === "missing") return undefined;
        if (probe.mode === "missing-write") return {};
        return {
          readText() {
            probe.reads++;
            throw new Error("Clipboard reads are outside the contract");
          },
          writeText(value: string) {
            probe.writes.push(value);
            if (probe.mode === "throw") throw new DOMException("Denied", "NotAllowedError");
            if (probe.mode === "reject")
              return Promise.reject(new DOMException("Denied", "NotAllowedError"));
            if (probe.mode === "pending")
              return new Promise<void>((yes, no) => {
                probe.settle = (ok) =>
                  ok ? yes() : no(new DOMException("Denied", "NotAllowedError"));
                settlements.push(probe.settle);
              });
            return Promise.resolve();
          },
        };
      },
    });
    // A denied browser API must not turn an unconfirmed legacy fallback into
    // success. The real selectable URL is the fallback, not a permission grant.
    document.execCommand = () => false;
  }, mode);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (["/events", "/events/past"].includes(url.pathname)) {
      const response = await fixture.render(surface, `${ORIGIN}/`, url.search);
      return route.fulfill({
        status: response.status,
        body: await response.text(),
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    const path = resolve(publicDir, `.${url.pathname}`);
    if (!path.startsWith(publicDir)) return route.abort();
    try {
      const contentType =
        (
          {
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
          } as Record<string, string>
        )[extname(path)] ?? "application/octet-stream";
      return route.fulfill({ contentType, body: readFileSync(path) });
    } catch {
      return route.abort();
    }
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-10-01T12:00:00Z"));
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(
      `${ORIGIN}${surface.endsWith("archive") ? "/events/past" : "/events"}?q=fixture&page=2&token=fixture-marker`,
    );
    return { context, page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function revealHelp(page: Page) {
  // Native details remains usable without JS. Do not inject/open it via script.
  for (const details of await page.locator("details").all()) {
    if (!/subscrib|calendar|feed/i.test((await details.textContent()) ?? "")) continue;
    if ((await details.getAttribute("open")) === null) {
      const summary = details.locator("summary").first();
      await summary.focus();
      await page.keyboard.press("Enter");
    }
  }
}

function urlField(page: Page) {
  return page
    .locator(`input[value="${FEED_URL}"], textarea, code, pre, a, output`)
    .filter({ visible: true });
}

async function assertSelectable(page: Page) {
  const candidates = urlField(page);
  let selected = false;
  for (const candidate of await candidates.all()) {
    const value = await candidate.evaluate((node) =>
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value
        : node.textContent?.trim(),
    );
    if (value !== FEED_URL) continue;
    selected = true;
    const selection = await candidate.evaluate((node) => {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        node.focus();
        node.select();
        return node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0);
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString().trim();
    });
    expect(selection).toBe(FEED_URL);
  }
  expect(selected, "help must contain the actual selectable configured-origin URL").toBe(true);
}

async function copyButton(page: Page) {
  await revealHelp(page);
  // The schedule also offers a separate "Copy this schedule view" action for
  // the committed filtered view; this suite's contract is the feed control.
  const button = page.getByRole("button", { name: /copy feed/i });
  expect(await button.count(), "an accessible explicit copy action must exist").toBe(1);
  return button;
}

async function feedback(page: Page) {
  return (
    await page
      .locator('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]')
      .allTextContents()
  ).join(" ");
}
function copied(text: string) {
  return (
    /\bcopied\b/i.test(text) && !/not copied|could not|couldn't|unable|failed|denied/i.test(text)
  );
}
async function probe(page: Page) {
  return page.evaluate(() => (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe);
}
async function settleUi(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const state = await probe(page);
  expect(state.unhandled).toBe(0);
  expect(state.reads).toBe(0);
}
async function withPage(
  surface: Surface,
  mode: Mode,
  run: (page: Page, errors: string[]) => Promise<void>,
) {
  let context: BrowserContext | undefined;
  try {
    const opened = await open(surface, mode);
    context = opened.context;
    await run(opened.page, opened.errors);
  } finally {
    await context?.close();
  }
}

describe.each(SURFACES)("%s real-browser subscription acceptance", (surface) => {
  it("positive control: the actual SSR route and external assets load without script errors", async () => {
    await withPage(surface, "resolve", async (page, errors) => {
      expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      expect(await page.locator(`a[href="${FEED_URL}"]`).count()).toBeGreaterThan(0);
      await clean(page, errors);
    });
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    it(`no-JS help and selectable URL work at ${viewport.width}px without a webcal handler`, async () => {
      const { context, page } = await open(surface, "missing", false, viewport);
      try {
        await revealHelp(page);
        await assertSelectable(page);
        expect(await page.getByText(/one[ -]time|once|snapshot/i).count()).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }

  it("keyboard activation announces success only after writeText resolves", async () => {
    await withPage(surface, "pending", async (page, errors) => {
      const button = await copyButton(page);
      await assertSelectable(page);
      expect((await probe(page)).writes).toEqual([]);
      let reached = false;
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press("Tab");
        if (await button.evaluate((node) => node === document.activeElement)) {
          reached = true;
          break;
        }
      }
      expect(reached, "copy action must be in keyboard tab order").toBe(true);
      await page.keyboard.press("Enter");
      await settleUi(page);
      expect((await probe(page)).writes).toEqual([FEED_URL]);
      expect(copied(await feedback(page))).toBe(false);
      await page.evaluate(() =>
        (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe.settle?.(true),
      );
      await settleUi(page);
      expect(
        copied(await feedback(page)),
        "confirmed write must announce copied in a live region",
      ).toBe(true);
      await clean(page, errors);
    });
  });

  for (const mode of ["reject", "missing", "missing-write", "throw"] as const) {
    it(`${mode} keeps a selectable URL and useful non-success feedback, without rejection leaks`, async () => {
      await withPage(surface, mode, async (page, errors) => {
        const button = await copyButton(page);
        await button.focus();
        await page.keyboard.press("Space");
        await settleUi(page);
        expect(copied(await feedback(page))).toBe(false);
        expect(await feedback(page)).toMatch(/select|highlight|manually|yourself|Ctrl|Command/i);
        await assertSelectable(page);
        expect((await probe(page)).writes).toEqual(
          mode === "missing" || mode === "missing-write" ? [] : [FEED_URL],
        );
        await clean(page, errors);
      });
    });
  }

  it("rapid repeated keyboard activation cannot announce pending or denied writes as copied", async () => {
    await withPage(surface, "pending", async (page, errors) => {
      const button = await copyButton(page);
      await button.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await settleUi(page);
      const writes = (await probe(page)).writes;
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.length).toBeLessThanOrEqual(2);
      expect(writes.every((value) => value === FEED_URL)).toBe(true);
      expect(copied(await feedback(page))).toBe(false);
      await page.evaluate(() =>
        (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe.settleAll?.(false),
      );
      await settleUi(page);
      expect(copied(await feedback(page))).toBe(false);
      await assertSelectable(page);
      await clean(page, errors);
    });
  });

  it("repeated success → pending → denial → success never leaves a stale copied state", async () => {
    await withPage(surface, "resolve", async (page, errors) => {
      const button = await copyButton(page);
      await button.click();
      await settleUi(page);
      expect(copied(await feedback(page))).toBe(true);
      await page.evaluate(() => {
        (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe.mode = "pending";
      });
      await button.click();
      await settleUi(page);
      expect(copied(await feedback(page)), "starting a new attempt must clear old success").toBe(
        false,
      );
      await page.evaluate(() =>
        (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe.settle?.(false),
      );
      await settleUi(page);
      expect(copied(await feedback(page))).toBe(false);
      expect(await feedback(page)).toMatch(/select|highlight|manually|yourself/i);
      await assertSelectable(page);
      await page.evaluate(() => {
        (window as unknown as { subscriptionProbe: Probe }).subscriptionProbe.mode = "resolve";
      });
      await button.click();
      await settleUi(page);
      expect(copied(await feedback(page))).toBe(true);
      expect((await probe(page)).writes).toEqual([FEED_URL, FEED_URL, FEED_URL]);
      await clean(page, errors);
    });
  });
});
