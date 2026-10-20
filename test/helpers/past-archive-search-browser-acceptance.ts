// Registered under the existing Kit-enabled Chromium CI gate, without a new
// skip or opt-in. Functional SSR/island fixtures, not final visual evidence.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import { PAST_EVENTS_COPY, PAST_EVENTS_OUT_OF_RANGE_TESTID } from "../../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  ARCHIVE_QUERY,
  archiveReadFixture,
  archiveTwins,
  compileArchiveKit,
  firstMatchKeys,
  lastMatchKeys,
  requestArchive,
  type ArchiveTwin,
} from "./past-archive-search-acceptance";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
const queryPath = (q = ARCHIVE_QUERY, page = 1) =>
  `/events/past?${new URLSearchParams({ q, page: String(page) })}`;
const keysOnPage = (page: Page) =>
  page
    .locator("[data-event-key]")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-event-key")));
const rootOnPage = (page: Page) => page.locator('[data-island="past-events"]');

async function recoveryLink(page: Page, filtered: boolean) {
  for (const anchor of await page.locator("main a[href]").all()) {
    const href = await anchor.getAttribute("href");
    const url = new URL(href!, ARCHIVE_ORIGIN);
    const q = url.searchParams.get("q")?.replaceAll("\0", "").trim() ?? "";
    const number = Number(url.searchParams.get("page") ?? 1);
    if (
      url.pathname === "/events/past" &&
      (filtered ? q === ARCHIVE_QUERY && number >= 1 && number <= 2 : q === "" && number === 1)
    ) {
      expect((await anchor.textContent())?.trim().length).toBeGreaterThan(0);
      return anchor;
    }
  }
  throw new Error(filtered ? "Missing usable filtered recovery link" : "Missing clear-search link");
}

export function registerPastArchiveBrowserAcceptance(getBrowser: () => Browser): void {
  describe("filtered archive traversal on local fixtures", () => {
    let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
    let context: BrowserContext | undefined;
    beforeAll(async () => {
      kit = await compileArchiveKit();
    }, 60_000);
    afterAll(() => kit?.dispose());
    beforeEach(() => {
      __resetAnonEventCacheForTests();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(ARCHIVE_NOW);
    });
    afterEach(async () => {
      await context?.close();
      context = undefined;
      vi.useRealTimers();
    });

    async function open(
      twin: ArchiveTwin,
      width: number,
      javaScriptEnabled: boolean,
      path: string,
    ) {
      const source = archiveReadFixture();
      const requests: { url: string; resource: string }[] = [];
      context = await getBrowser().newContext({
        javaScriptEnabled,
        viewport: { width, height: width === 390 ? 844 : 800 },
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        // Fulfill every resource from local bytes/real route fixtures or abort.
        // No fallback to an external connection, including redirects.
        if (url.origin !== ARCHIVE_ORIGIN) return route.abort("blockedbyclient");
        if (url.pathname === "/events/past") {
          requests.push({ url: url.href, resource: route.request().resourceType() });
          const response = await requestArchive(twin, url.href, source.env, kit, {
            headers: route.request().headers(),
          });
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
      await page.goto(new URL(path, ARCHIVE_ORIGIN).href);
      await rootOnPage(page).waitFor();
      return { page, requests };
    }

    for (const twin of archiveTwins)
      for (const width of [1280, 390]) {
        const label = `${twin} ${width}`;
        it(`${label}: ordinary archive enhancement remains same-document with bounded rows`, async () => {
          const { page, requests } = await open(twin, width, true, "/events/past");
          expect(await keysOnPage(page)).toHaveLength(20);
          await page.evaluate("window.__archiveAcceptance = 'same document'");
          await page.locator("[data-archive-pager] a").filter({ hasText: "Older" }).click();
          await expect.poll(() => rootOnPage(page).getAttribute("data-page")).toBe("2");
          expect(await keysOnPage(page)).toHaveLength(20);
          expect(await page.evaluate("window.__archiveAcceptance")).toBe("same document");
          expect(requests.some((request) => request.resource === "fetch")).toBe(true);
          await page.goBack();
          await expect.poll(() => rootOnPage(page).getAttribute("data-page")).toBe("1");
        });

        it(`${label}: enhanced paging, Back/Forward and copied/reloaded URLs retain q`, async () => {
          const { page, requests } = await open(twin, width, true, queryPath());
          expect(await keysOnPage(page)).toEqual(firstMatchKeys);
          await page.evaluate("window.__archiveAcceptance = 'same document'");
          await page.locator("[data-archive-pager] a").filter({ hasText: "Older" }).click();
          await expect.poll(() => rootOnPage(page).getAttribute("data-page")).toBe("2");
          expect(await keysOnPage(page)).toEqual(lastMatchKeys);
          expect(new URL(page.url()).searchParams.get("q")).toBe(ARCHIVE_QUERY);
          expect(await page.evaluate("window.__archiveAcceptance")).toBe("same document");
          const fetched = requests.filter((request) => request.resource === "fetch");
          expect(fetched.length).toBeGreaterThan(0);
          expect(
            fetched.every(
              (request) => new URL(request.url).searchParams.get("q") === ARCHIVE_QUERY,
            ),
          ).toBe(true);
          const copied = page.url();
          await page.goBack();
          await expect.poll(() => keysOnPage(page)).toEqual(firstMatchKeys);
          await page.goForward();
          await expect.poll(() => keysOnPage(page)).toEqual(lastMatchKeys);
          await page.reload();
          expect(page.url()).toBe(copied);
          expect(await keysOnPage(page)).toEqual(lastMatchKeys);
          const pasted = await context!.newPage();
          await pasted.goto(copied);
          expect(await keysOnPage(pasted)).toEqual(lastMatchKeys);
        });

        it(`${label}: native no-JS paging reaches every match and intentional clear restores the archive`, async () => {
          const { page, requests } = await open(twin, width, false, queryPath());
          expect(await keysOnPage(page)).toEqual(firstMatchKeys);
          await page.locator("[data-archive-pager] a").filter({ hasText: "Older" }).click();
          expect(await keysOnPage(page)).toEqual(lastMatchKeys);
          expect(new URL(page.url()).searchParams.get("q")).toBe(ARCHIVE_QUERY);
          await page.locator("[data-archive-pager] a").filter({ hasText: "Newer" }).click();
          expect(await keysOnPage(page)).toEqual(firstMatchKeys);
          await (await recoveryLink(page, false)).click();
          expect(
            (new URL(page.url()).searchParams.get("q") ?? "").replaceAll("\0", "").trim(),
          ).toBe("");
          expect(await keysOnPage(page)).toHaveLength(20);
          expect(await rootOnPage(page).getAttribute("data-total-pages")).toBe("3");
          expect(requests.every((request) => request.resource === "document")).toBe(true);
        });

        it(`${label}: no matches has a clear-search recovery, not the never-run archive message`, async () => {
          const { page } = await open(twin, width, false, queryPath("no such meeting"));
          expect(await keysOnPage(page)).toEqual([]);
          expect(await page.locator("body").textContent()).not.toContain(PAST_EVENTS_COPY.empty);
          expect(
            await page.locator(`[data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"]`).count(),
          ).toBe(0);
          await (await recoveryLink(page, false)).click();
          expect(await keysOnPage(page)).toHaveLength(20);
        });

        it(`${label}: out-of-range recovery keeps q and returns to a real matching page`, async () => {
          const { page } = await open(twin, width, false, queryPath(ARCHIVE_QUERY, 999));
          expect(await keysOnPage(page)).toEqual([]);
          expect(await rootOnPage(page).getAttribute("data-total-pages")).toBe("2");
          expect(
            await page.locator(`[data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"]`).count(),
          ).toBe(1);
          await (await recoveryLink(page, true)).click();
          expect(new URL(page.url()).searchParams.get("q")).toBe(ARCHIVE_QUERY);
          expect(await keysOnPage(page)).toEqual(
            new URL(page.url()).searchParams.get("page") === "2" ? lastMatchKeys : firstMatchKeys,
          );
        });
      }
  });
}
