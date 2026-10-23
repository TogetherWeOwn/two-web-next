// route-inventory: GET /events/past
// Acceptance-author owned. Builder: consume unchanged; return corrections to the author.
// Breaks caught: missing/leading-only excerpts, wrong folded offsets, HTML/regex
// interpretation, JS post-filtering SQL rows, and excerpt loss during fragment turns.
// All requests are local fixtures. These are functional DOM proofs, not screenshots
// or PostgreSQL-collation evidence. Registered in the existing Chromium CI gate.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import type { PublicEvent } from "../../src/events/reads";
import { PAST_EVENTS_COPY, PAST_EVENTS_SEARCH_MISS_TESTID } from "../../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  archiveEnv,
  archiveReadFixture,
  archiveRow,
  archiveTwins,
  compileArchiveKit,
  requestArchive,
  type ArchiveTwin,
} from "./past-archive-search-acceptance";

export function registerPastSearchContextAcceptance(getBrowser: () => Browser): void {
  describe("past search context acceptance", () => {
    // A roomy acceptance ceiling, including ellipses; not an exact layout/algorithm pin.
    // It accommodates the admitted 255-code-point query without dumping a description.
    const PASSAGE_CEILING = 320;
    const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
    const pathFor = (q: string, page = 1) =>
      `/events/past?${new URLSearchParams({ q, page: String(page) })}`;
    const root = (page: Page) => page.locator('[data-island="past-events"]');
    let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
    let context: BrowserContext | undefined;

    beforeAll(async () => {
      kit = await compileArchiveKit();
    });
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

    // Structural browser read type: this project uses Workers, not lib.dom, globals.
    type ReadNode = {
      textContent: string | null;
      outerHTML: string;
      getAttribute: (name: string) => string | null;
      querySelector: (selector: string) => ReadNode | null;
      querySelectorAll: (selector: string) => ArrayLike<ReadNode>;
    };

    // Snapshot only the card's semantic DOM, not the query echoed elsewhere on the page.
    async function cards(page: Page) {
      return page.locator('[data-testid="event-card"]').evaluateAll((nodes) =>
        nodes.map((node) => {
          const card = node as unknown as ReadNode;
          return {
            key: card.getAttribute("data-event-key"),
            html: card.outerHTML,
            title: card.querySelector("h2 a")?.textContent ?? "",
            href: card.querySelector("h2 a")?.getAttribute("href"),
            titleMarks: Array.from(card.querySelectorAll("h2 a mark"), (mark) => mark.textContent),
            excerpts: Array.from(card.querySelectorAll(".schedule-info > p"))
              .filter((p) => !p.querySelector("time"))
              .map((p) => ({
                text: p.textContent ?? "",
                marks: Array.from(p.querySelectorAll("mark"), (mark) => mark.textContent),
              })),
            injected: card.querySelectorAll("script, img, svg, iframe, [onerror], [onload]").length,
          };
        }),
      );
    }

    async function documentFor(twin: ArchiveTwin, rows: PublicEvent[], q: string) {
      const source = archiveReadFixture();
      source.replaceRows(rows);
      const response = await requestArchive(twin, pathFor(q), source.env, kit);
      expect(response.status).toBe(200);
      context = await getBrowser().newContext({
        javaScriptEnabled: false,
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.setContent(await response.text());
      return { page, source, response };
    }

    function boundedPassage(text: string) {
      expect([...text].length).toBeLessThanOrEqual(PASSAGE_CEILING);
      expect(text).not.toContain("�");
      // With /u, this range catches lone surrogates, not valid supplementary characters.
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    }

    const literalCases = [
      { id: "percent", q: "%", description: "A 50% bonus, not a wildcard." },
      { id: "underscore", q: "_", description: "Bring your raid_kit, not raidXkit." },
      { id: "backslash", q: "\\", description: "The literal path is raid\\kit." },
      { id: "regex", q: "[.*+?^${}()|]", description: "Read [.*+?^${}()|] literally." },
      {
        id: "markup",
        q: '<img src=x onerror="alert(1)">',
        description: 'Read <img src=x onerror="alert(1)"> as text.',
      },
      {
        id: "entity",
        q: "&lt;script&gt;",
        description: "Read &lt;script&gt; literally, not decoded twice.",
      },
      { id: "supplementary", q: "🛰", description: "Meet by 🛰 before launch 🚀." },
      { id: "case", q: "orbital", description: "Before ORBITAL after." },
      { id: "folded-offset", q: "orbital", description: "İ 👩🏽‍🚀 before ORBITAL after." },
    ];

    describe.each(archiveTwins)("%s archive match context", (twin) => {
      it.each([null, ""])(
        "PSC-001 highlights the complete title with description=%j and keeps its native detail link",
        async (description) => {
          const title = `${"A complete title — ".repeat(10)}ORBITAL finale`;
          const row = archiveRow(1, { title, description });
          const { page } = await documentFor(twin, [row], "orbital");
          const [card] = await cards(page);
          expect(card?.title).toBe(title);
          expect(card?.href).toBe("/e/archive-match-1");
          expect(card?.injected).toBe(0);
          expect(card?.excerpts).toEqual([]);
          expect(card?.titleMarks).toEqual(["ORBITAL"]);
        },
      );

      it("PSC-013 escapes hostile title text while marking its literal matching span", async () => {
        const q = '<svg onload="alert(1)">';
        const title = `Read ${q} literally & safely`;
        const { page } = await documentFor(twin, [archiveRow(1, { title, description: null })], q);
        const [card] = await cards(page);
        expect(card?.title).toBe(title);
        expect(card?.href).toBe("/e/archive-match-1");
        expect(card?.injected).toBe(0);
        expect(card?.titleMarks).toEqual([q]);
      });

      it("PSC-002 explains a description-only match with semantic text, not the query echo", async () => {
        const { page } = await documentFor(
          twin,
          [
            archiveRow(1, {
              title: "A different-looking title",
              description: "Before ORBITAL after.",
            }),
          ],
          "orbital",
        );
        const [card] = await cards(page);
        expect(card?.title).toBe("A different-looking title");
        expect(card?.href).toBe("/e/archive-match-1");
        expect(card?.titleMarks).toEqual([]);
        expect(card?.excerpts).toEqual([{ text: "Before ORBITAL after.", marks: ["ORBITAL"] }]);
      });

      it("PSC-003 centers a bounded passage on a late match instead of showing the leading text", async () => {
        const description = `${"Opening background 🚀. ".repeat(100)}Teammates ORBITAL regroup here. ${"Later background. ".repeat(100)}`;
        const { page } = await documentFor(
          twin,
          [archiveRow(1, { title: "Unrelated title", description })],
          "orbital",
        );
        const [card] = await cards(page);
        expect(card?.excerpts).toHaveLength(1);
        const excerpt = card!.excerpts[0]!;
        boundedPassage(excerpt.text);
        expect(excerpt.text).toContain("Teammates ORBITAL regroup here.");
        expect(excerpt.text).not.toContain("Opening background");
        expect(excerpt.marks).toEqual(["ORBITAL"]);
      });

      it.each([0, 1, 159, 239, 240, 255, 319, 320, 321, 1200])(
        "PSC-004 excerpt edges remain bounded and Unicode-safe with %i supplementary prefix points",
        async (prefix) => {
          const description = `${"🚀".repeat(prefix)} before 🛰 after ${"🌌".repeat(400)}`;
          const { page } = await documentFor(
            twin,
            [archiveRow(1, { title: "Launch notes", description })],
            "🛰",
          );
          const [card] = await cards(page);
          expect(card?.excerpts).toHaveLength(1);
          const excerpt = card!.excerpts[0]!;
          boundedPassage(excerpt.text);
          expect(excerpt.text).toContain("before 🛰 after");
          expect(excerpt.marks).toEqual(["🛰"]);
        },
      );

      it.each(literalCases)(
        "PSC-005 $id is literal and the original matching text is marked",
        async ({ q, description, id }) => {
          const { page } = await documentFor(
            twin,
            [archiveRow(1, { title: "Notes", description })],
            q,
          );
          const [card] = await cards(page);
          expect(card?.injected).toBe(0);
          expect(card?.excerpts).toHaveLength(1);
          const excerpt = card!.excerpts[0]!;
          boundedPassage(excerpt.text);
          expect(excerpt.text).toBe(description);
          expect(excerpt.marks).toEqual([id === "case" || id === "folded-offset" ? "ORBITAL" : q]);
        },
      );

      it("PSC-006 marks locatable occurrences in both the full title and the passage", async () => {
        const { page } = await documentFor(
          twin,
          [
            archiveRow(1, {
              title: "ORBITAL plans",
              description: "orbital friends meet the ORBITAL team.",
            }),
          ],
          "orbital",
        );
        const [card] = await cards(page);
        expect(card?.title).toBe("ORBITAL plans");
        expect(card?.titleMarks).toEqual(["ORBITAL"]);
        expect(card?.excerpts).toEqual([
          { text: "orbital friends meet the ORBITAL team.", marks: ["orbital", "ORBITAL"] },
        ]);
      });

      it("PSC-014 windows around the first of two distant matches and excludes the later occurrence", async () => {
        // Dropping the out-of-window span guard leaks the second match; anchoring
        // on the last span loses the first passage even if the result stays bounded.
        const description = `First crew ORBITAL launch. ${"🚀".repeat(400)} Last crew orbital landing.`;
        const { page } = await documentFor(
          twin,
          [archiveRow(1, { title: "Launch notes", description })],
          "orbital",
        );
        const [card] = await cards(page);
        expect(card?.titleMarks).toEqual([]);
        expect(card?.excerpts).toHaveLength(1);
        const excerpt = card!.excerpts[0]!;
        boundedPassage(excerpt.text);
        expect(excerpt.text).toMatch(/^First crew ORBITAL launch\. 🚀+…$/u);
        expect(excerpt.marks).toEqual(["ORBITAL"]);
        expect(excerpt.text).not.toContain("Last crew");
        expect(excerpt.text).not.toContain("orbital");
      });

      it("PSC-007 admits a maximum-length supplementary query and never clips its matching span", async () => {
        const q = "🛰".repeat(255);
        const { page } = await documentFor(
          twin,
          [
            archiveRow(1, {
              title: "Long search notes",
              description: `${"Before ".repeat(100)}${q}${" after".repeat(100)}`,
            }),
          ],
          q,
        );
        const [card] = await cards(page);
        expect(card?.excerpts).toHaveLength(1);
        const excerpt = card!.excerpts[0]!;
        boundedPassage(excerpt.text);
        expect(excerpt.marks).toEqual([q]);
      });

      it("PSC-008 retains a SQL-selected row with an unlocatable span as an unhighlighted excerpt", async () => {
        const row = archiveRow(1, {
          title: "Stored title",
          description: `The stored passage remains useful. ${"Further context. ".repeat(100)}`,
        });
        // Model a SQL collation match that JS cannot locate faithfully. Do not use the
        // helper's JS substring predicate here: SQL's returned row is the authority.
        const columns = Object.keys(
          getTableColumns(events),
        ) as (keyof typeof events.$inferSelect)[];
        const db = drizzle(async (sql) => {
          if (sql.includes('from "rsvps"')) return { rows: [] };
          if (sql.startsWith("select count(*)")) return { rows: [[1]] };
          return {
            rows: [
              columns.map((key) =>
                row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
              ),
            ],
          };
        }) as unknown as Db;
        const response = await requestArchive(
          twin,
          pathFor("sql-locale-only"),
          archiveEnv(db),
          kit,
        );
        expect(response.status).toBe(200);
        context = await getBrowser().newContext({ javaScriptEnabled: false });
        await context.route("**/*", (route) => route.abort("blockedbyclient"));
        const page = await context.newPage();
        await page.setContent(await response.text());
        const [card] = await cards(page);
        expect(card?.title).toBe("Stored title");
        expect(card?.titleMarks).toEqual([]);
        expect(card?.excerpts).toHaveLength(1);
        boundedPassage(card!.excerpts[0]!.text);
        expect(card!.excerpts[0]!.text).toContain("The stored passage remains useful.");
        expect(card!.excerpts[0]!.marks).toEqual([]);
        expect(
          await page.locator(`[data-testid="${PAST_EVENTS_SEARCH_MISS_TESTID}"]`).count(),
        ).toBe(0);
      });

      it("PSC-009 CONTROL keeps ordinary cards compact and adds no search-only client script", async () => {
        const row = archiveRow(1, {
          title: "ORBITAL",
          description: "Description disclosure sentinel ORBITAL.",
        });
        const { page, source } = await documentFor(twin, [row], "");
        const [ordinary] = await cards(page);
        expect(ordinary?.excerpts).toEqual([]);
        expect(ordinary?.titleMarks).toEqual([]);
        expect(ordinary?.html).not.toContain("Description disclosure sentinel");
        const scripts = await page
          .locator("script[src]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
        const blank = await requestArchive(twin, pathFor("  \0  "), source.env, kit);
        await page.setContent(await blank.text());
        expect((await cards(page))[0]?.html).toBe(ordinary?.html);
        const filtered = await requestArchive(twin, pathFor("orbital"), source.env, kit);
        await page.setContent(await filtered.text());
        expect(
          await page
            .locator("script[src]")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src"))),
        ).toEqual(scripts);
      });

      it("PSC-010 CONTROL preserves four-read filtered responses, shared ordinary cache and no audit writes", async () => {
        const source = archiveReadFixture();
        source.replaceRows([archiveRow(1, { title: "ORBITAL", description: "ORBITAL context" })]);
        const ordinary = await requestArchive(twin, "/events/past", source.env, kit);
        const ordinaryHtml = await ordinary.text();
        expect(source.statements).toHaveLength(4);
        source.statements.length = 0;
        expect(await (await requestArchive(twin, "/events/past", source.env, kit)).text()).toBe(
          ordinaryHtml,
        );
        expect(source.statements).toHaveLength(0);
        for (let attempt = 0; attempt < 2; attempt++) {
          const filtered = await requestArchive(twin, pathFor("orbital"), source.env, kit);
          expect(filtered.status).toBe(200);
          expect(filtered.headers.get("cache-control")).toBe("private, no-store");
          expect(filtered.headers.get("x-two-past-cacheable")).toBeNull();
          expect(source.statements).toHaveLength(4);
          expect(source.statements.every(({ sql }) => sql.startsWith("select "))).toBe(true);
          source.statements.length = 0;
        }
        const refused = await requestArchive(twin, pathFor("🛰".repeat(256)), source.env, kit);
        expect(refused.status).toBe(422);
        expect(source.statements).toHaveLength(0);
      });
    });

    async function openJourney(twin: ArchiveTwin, width: number, javaScriptEnabled: boolean) {
      const source = archiveReadFixture();
      source.replaceRows(
        Array.from({ length: 21 }, (_, i) =>
          archiveRow(i + 1, {
            title: `Different title ${i + 1}`,
            description: `${"Background 🚀. ".repeat(80)}Teammates ORBITAL regroup ${i + 1}. ${"Tail. ".repeat(80)}`,
          }),
        ).reverse(),
      );
      const requests: { url: string; resource: string }[] = [];
      let refuseNextTurn = false;
      context = await getBrowser().newContext({
        javaScriptEnabled,
        viewport: { width, height: width === 390 ? 844 : 800 },
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ARCHIVE_ORIGIN) return route.abort("blockedbyclient");
        if (url.pathname === "/events/past") {
          requests.push({ url: url.href, resource: route.request().resourceType() });
          if (refuseNextTurn && route.request().resourceType() === "fetch") {
            refuseNextTurn = false;
            return route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" });
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
      await page.goto(new URL(pathFor("orbital"), ARCHIVE_ORIGIN).href);
      await root(page).waitFor();
      return {
        page,
        source,
        requests,
        failNext: () => {
          refuseNextTurn = true;
        },
      };
    }

    async function assertPageTwoContext(page: Page) {
      const result = await cards(page);
      expect.soft(result).toHaveLength(1);
      expect.soft(result[0]?.key).toBe("archive-match-1");
      expect.soft(result[0]?.excerpts).toHaveLength(1);
      expect.soft(result[0]?.excerpts[0]?.text).toContain("Teammates ORBITAL regroup 1.");
      expect.soft(result[0]?.excerpts[0]?.marks).toEqual(["ORBITAL"]);
      expect.soft(result[0]?.href).toBe("/e/archive-match-1");
      expect.soft(new URL(page.url()).searchParams.get("q")).toBe("orbital");
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect.soft(new URL(canonical!).searchParams.get("q")).toBe("orbital");
      expect.soft(new URL(canonical!).searchParams.get("page")).toBe("2");
    }

    for (const twin of archiveTwins)
      for (const width of [1280, 390]) {
        for (const javaScriptEnabled of [true, false]) {
          it(`PSC-011 ${twin} ${width} JS=${javaScriptEnabled}: keyboard page-two, history/reload and Clear preserve context`, async () => {
            const { page, requests } = await openJourney(twin, width, javaScriptEnabled);
            expect(await cards(page)).toHaveLength(20);
            if (javaScriptEnabled)
              await page.evaluate("window.__contextAcceptance = 'same document'");
            const older = page.locator("[data-archive-pager] a").filter({ hasText: "Older" });
            await older.focus();
            await older.press("Enter");
            await expect.poll(() => root(page).getAttribute("data-page")).toBe("2");
            await assertPageTwoContext(page);
            if (javaScriptEnabled) {
              expect(await page.evaluate("window.__contextAcceptance")).toBe("same document");
              expect(requests.filter((request) => request.resource === "fetch")).toHaveLength(1);
            } else expect(requests.every((request) => request.resource === "document")).toBe(true);
            const copied = page.url();
            await page.goBack();
            await expect.poll(async () => (await cards(page)).length).toBe(20);
            await page.goForward();
            await expect.poll(() => root(page).getAttribute("data-page")).toBe("2");
            await assertPageTwoContext(page);
            await page.reload();
            expect(page.url()).toBe(copied);
            await assertPageTwoContext(page);
            await page
              .locator("[data-archive-state] a")
              .filter({ hasText: "Clear search" })
              .click();
            expect(new URL(page.url()).searchParams.has("q")).toBe(false);
            const ordinary = await cards(page);
            expect(ordinary).toHaveLength(20);
            expect(
              ordinary.every((card) => card.excerpts.length === 0 && card.titleMarks.length === 0),
            ).toBe(true);
          });
        }

        it(`PSC-012 ${twin} ${width}: refused fragment retains the last good passage and retry commits page two`, async () => {
          const { page, requests, failNext } = await openJourney(twin, width, true);
          const before = await cards(page);
          expect.soft(before[0]?.excerpts[0]?.marks).toEqual(["ORBITAL"]);
          const committed = page.url();
          failNext();
          await page.locator("[data-archive-pager] a").filter({ hasText: "Older" }).click();
          await expect
            .poll(() => page.locator("[data-archive-feedback]").textContent())
            .toBe(PAST_EVENTS_COPY.failed);
          expect(page.url()).toBe(committed);
          expect(await cards(page)).toEqual(before);
          expect(requests.filter((request) => request.resource === "fetch")).toHaveLength(1);
          await page.locator("[data-archive-pager] a").filter({ hasText: "Older" }).click();
          await expect.poll(() => root(page).getAttribute("data-page")).toBe("2");
          await assertPageTwoContext(page);
          expect(requests.filter((request) => request.resource === "fetch")).toHaveLength(2);
        });
      }
  });
}
