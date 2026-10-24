// Registered inside the existing Kit-enabled, require-executed Chromium gate.
// Real twins + disposable SQL + shipped islands. These are functional tests, not visual sign-off.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import { PAST_EVENTS_COPY } from "../../src/islands/contracts";
import {
  GAME,
  TEXT,
  archiveGamePath,
  createArchiveGameFixture,
  gameFirstKeys,
  gameKey,
  gameLastKeys,
} from "./archive-game-acceptance";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  archiveTwins,
  compileArchiveKit,
  requestArchive,
  type ArchiveTwin,
} from "./past-archive-search-acceptance";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
const keys = (page: Page) =>
  page
    .locator("[data-event-key]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-event-key")));
const root = (page: Page) => page.locator('[data-island="past-events"]');
const select = (page: Page) => page.getByRole("combobox", { name: /game/i });

export function registerArchiveGameBrowserAcceptance(getBrowser: () => Browser): void {
  describe("archive game real-browser acceptance", () => {
    let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
    let source: Awaited<ReturnType<typeof createArchiveGameFixture>>;
    let context: BrowserContext | undefined;
    beforeAll(async () => {
      source = await createArchiveGameFixture();
      kit = await compileArchiveKit();
    });
    afterAll(async () => {
      kit?.dispose();
      await source?.dispose();
    });
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(ARCHIVE_NOW);
      __resetAnonEventCacheForTests();
      await source.seed();
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
      const requests: { url: URL; resource: string }[] = [];
      let failNext = false;
      context = await getBrowser().newContext({
        javaScriptEnabled,
        serviceWorkers: "block",
        viewport: { width, height: width === 390 ? 844 : 800 },
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ARCHIVE_ORIGIN) return route.abort("blockedbyclient");
        if (url.pathname === "/events/past") {
          const resource = route.request().resourceType();
          requests.push({ url, resource });
          if (failNext && resource === "fetch") {
            failNext = false;
            return route.fulfill({ status: 503, body: "Fixture unavailable" });
          }
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
      await root(page).waitFor();
      return {
        page,
        requests,
        fail: () => {
          failNext = true;
        },
      };
    }

    for (const twin of archiveTwins)
      for (const width of [1280, 390]) {
        const label = `${twin} ${width}`;
        it(`${label}: enhanced paging, Back/Forward, reload and copied URL retain both filters`, async () => {
          const { page, requests } = await open(twin, width, true, archiveGamePath(GAME, 1, TEXT));
          expect(await keys(page)).toEqual(gameFirstKeys);
          expect(await select(page).count()).toBe(1);
          expect(await select(page).inputValue()).toBe(GAME);
          await page.evaluate("window.__archiveGameDocument = 'same'");
          await page.getByRole("link", { name: "Older", exact: true }).click();
          await expect.poll(() => keys(page)).toEqual(gameLastKeys);
          expect(await page.evaluate("window.__archiveGameDocument")).toBe("same");
          expect(new URL(page.url()).searchParams.get("game")).toBe(GAME);
          expect(new URL(page.url()).searchParams.get("q")).toBe(TEXT);
          const canonical = new URL(
            (await page.locator('link[rel="canonical"]').getAttribute("href"))!,
          );
          expect(canonical.searchParams.get("game")).toBe(GAME);
          expect(canonical.searchParams.get("q")).toBe(TEXT);
          await page.goBack();
          await expect.poll(() => keys(page)).toEqual(gameFirstKeys);
          expect(await select(page).inputValue()).toBe(GAME);
          await page.goForward();
          await expect.poll(() => keys(page)).toEqual(gameLastKeys);
          const copied = page.url();
          await page.reload();
          expect(await keys(page)).toEqual(gameLastKeys);
          expect(await select(page).inputValue()).toBe(GAME);
          const pasted = await context!.newPage();
          await pasted.goto(copied);
          expect(await keys(pasted)).toEqual(gameLastKeys);
          expect(await select(pasted).inputValue()).toBe(GAME);
          const fetches = requests.filter((r) => r.resource === "fetch");
          expect(fetches.length).toBeGreaterThan(0);
          expect(
            fetches.every(
              ({ url }) =>
                url.searchParams.get("game") === GAME && url.searchParams.get("q") === TEXT,
            ),
          ).toBe(true);
        });

        it(`${label}: game filtering preserves title/description text matches without inventing game-only highlights`, async () => {
          const { page } = await open(twin, width, false, archiveGamePath(GAME, 2, TEXT));
          // Intersects game with literal title/description search (mirrors the SQL
          // twin): page two holds the tail including description-only id 6; Chess
          // shares the text but must not appear. Plain-text assertions only:
          // <mark> explanations are unmerged #1703, not this facet.
          const filtered = await keys(page);
          expect(filtered).toEqual(gameLastKeys);
          expect(filtered).toContain(gameKey(6));
          const descriptionOnly = page.locator(`[data-event-key="${gameKey(6)}"]`);
          expect(await descriptionOnly.count()).toBe(1);
          const titleMatch = await page
            .locator(`[data-event-key="${gameKey(10)}"] h2 a`)
            .textContent();
          expect(titleMatch ?? "").toContain(TEXT);
          await page.goto(new URL(archiveGamePath(GAME, 2), ARCHIVE_ORIGIN).href);
          expect(await keys(page)).toEqual(gameLastKeys);
          expect(await page.locator("[data-archive-list] mark").count()).toBe(0);
        });

        it(`${label}: native GET works without JS and keyboard submission resets a changed facet to page one`, async () => {
          const { page, requests } = await open(twin, width, false, archiveGamePath(GAME, 2, TEXT));
          expect(await select(page).count()).toBe(1);
          expect(await keys(page)).toEqual(gameLastKeys);
          const form = page.locator("form").filter({ has: select(page) });
          expect((await form.getAttribute("method"))?.toLowerCase() ?? "get").toBe("get");
          await select(page).selectOption({ label: "Chess" });
          const submit = form.getByRole("button", { name: /search|filter|apply/i });
          expect(await submit.count()).toBe(1);
          await submit.focus();
          await Promise.all([
            page.waitForURL((url) => url.searchParams.get("game") === "Chess"),
            page.keyboard.press("Enter"),
          ]);
          expect(Number(new URL(page.url()).searchParams.get("page") ?? 1)).toBe(1);
          expect(new URL(page.url()).searchParams.get("q")).toBe(TEXT);
          expect(await keys(page)).toEqual(
            Array.from({ length: 20 }, (_, i) => gameKey(51 - i * 2)),
          );
          expect(requests.every((r) => r.resource === "document")).toBe(true);
        });

        it(`${label}: failed enhanced navigation keeps committed filters/cards/address and the same pager retries`, async () => {
          const { page, fail } = await open(twin, width, true, archiveGamePath(GAME, 1, TEXT));
          expect(await keys(page)).toEqual(gameFirstKeys);
          const committed = page.url();
          fail();
          await page.getByRole("link", { name: "Older", exact: true }).click();
          await expect
            .poll(() => page.locator("[data-archive-feedback]").textContent())
            .toContain(PAST_EVENTS_COPY.failed);
          expect(page.url()).toBe(committed);
          expect(await keys(page)).toEqual(gameFirstKeys);
          expect(await select(page).inputValue()).toBe(GAME);
          await page.getByRole("link", { name: "Older", exact: true }).click();
          await expect.poll(() => keys(page)).toEqual(gameLastKeys);
          expect(new URL(page.url()).searchParams.get("game")).toBe(GAME);
          expect(new URL(page.url()).searchParams.get("q")).toBe(TEXT);
        });

        it(`${label}: no-JS past-end recovery keeps game/text, while explicit clear recovery names its scope`, async () => {
          const { page } = await open(twin, width, false, archiveGamePath(GAME, 999, TEXT));
          expect(await root(page).getAttribute("data-total-pages")).toBe("2");
          expect(await keys(page)).toEqual([]);
          let recovery: ReturnType<Page["locator"]> | undefined;
          for (const anchor of await page.locator("main a[href]").all()) {
            const url = new URL((await anchor.getAttribute("href"))!, ARCHIVE_ORIGIN);
            if (
              url.pathname === "/events/past" &&
              Number(url.searchParams.get("page") ?? 1) === 1 &&
              url.searchParams.get("game") === GAME &&
              url.searchParams.get("q") === TEXT
            ) {
              recovery = anchor;
              break;
            }
          }
          expect(recovery, "Missing scoped page-one recovery").toBeDefined();
          await recovery!.click();
          expect(await keys(page)).toEqual(gameFirstKeys);
          expect(await select(page).inputValue()).toBe(GAME);
          const clear = page
            .getByRole("link", { name: /clear.*game|all games|clear all|clear.*filters/i })
            .first();
          expect(await clear.count()).toBe(1);
          const label = await clear.textContent();
          await clear.click();
          expect(new URL(page.url()).searchParams.get("game") ?? "").toBe("");
          if (
            /clear all|(?:all|clear).*filters|game.*(?:search|text)|(?:search|text).*game/i.test(
              label ?? "",
            )
          )
            expect(new URL(page.url()).searchParams.get("q") ?? "").toBe("");
          else expect(new URL(page.url()).searchParams.get("q")).toBe(TEXT);
        });
      }
  });
}
