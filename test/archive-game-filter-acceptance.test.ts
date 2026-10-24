// route-inventory: GET /events/past, GET /events
// Independent RED handoff: real Hono and executed Kit loader/SSR over disposable SQL.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import * as anonCache from "../src/events/anon-cache";
import {
  GAME,
  SPECIAL_GAME,
  TEXT,
  archiveGamePath,
  createArchiveGameFixture,
  gameFirstKeys,
  gameKey,
  gameLastKeys,
  gameRow,
} from "./helpers/archive-game-acceptance";
import {
  ARCHIVE_NOW,
  archiveTwins,
  compileArchiveKit,
  eventKeys,
  linksIn,
  requestArchive,
  requestCalendar,
} from "./helpers/past-archive-search-acceptance";

const decode = (s: string) =>
  s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
function gameOptions(html: string) {
  const select = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].find((m) =>
    /\bname="game"/.test(m[1]!),
  );
  expect(select, "Archive needs a native, named game select").toBeDefined();
  return [...select![2]!.matchAll(/<option\b((?:"[^"]*"|[^>])*)>([\s\S]*?)<\/option>/g)].map(
    (m) => ({
      value: decode(/\bvalue="([^"]*)"/.exec(m[1]!)?.[1] ?? m[2]!),
      selected: /\bselected(?:[\s=>]|$)/.test(m[1]!),
      label: decode(m[2]!.replace(/<!--[\s\S]*?-->/g, "").trim()),
    }),
  );
}
const totalPages = (html: string) => Number(/\bdata-total-pages="(\d+)"/.exec(html)?.[1]);

for (const twin of archiveTwins) {
  describe(`${twin} archive game acceptance (real SQL)`, () => {
    let source: Awaited<ReturnType<typeof createArchiveGameFixture>>;
    let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
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
      anonCache.__resetAnonEventCacheForTests();
      await source.seed();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    const get = (path: string) => requestArchive(twin, path, source.env, kit);

    it("filters game-only count and rows before the 20-row page boundary, with stable id ties", async () => {
      const first = await get(archiveGamePath());
      const second = await get(archiveGamePath(GAME, 2));
      expect([first.status, second.status]).toEqual([200, 200]);
      const one = await first.text();
      const two = await second.text();
      expect(eventKeys(one)).toEqual(gameFirstKeys);
      expect(eventKeys(two)).toEqual(gameLastKeys);
      expect([totalPages(one), totalPages(two)]).toEqual([2, 2]);
      const rowReads = source.statements.filter(
        ({ sql }) => /\bfrom "events"/.test(sql) && /\boffset\b/.test(sql),
      );
      expect(rowReads.length).toBeGreaterThan(0);
      for (const { sql, params } of rowReads) {
        const position = /\blimit \$(\d+)/i.exec(sql);
        expect(position, "Archive row reads stay SQL-bounded").not.toBeNull();
        expect(Number(params[Number(position![1]) - 1])).toBeLessThanOrEqual(21);
      }
    });

    it("intersects literal title/description search with game, rather than OR-ing facets", async () => {
      const html = await (await get(archiveGamePath(GAME, 2, TEXT))).text();
      expect(eventKeys(html)).toEqual(gameLastKeys);
      expect(totalPages(html)).toBe(2);
      // id 6 matches only its description; Chess shares the text but must not appear.
      expect(eventKeys(html)).toContain(gameKey(6));
    });

    it("carries page, text and game in structured archive-detail context, not an arbitrary return URL", async () => {
      const html = await (await get(archiveGamePath(GAME, 2, TEXT))).text();
      const detailLinks = linksIn(html).filter(({ url }) => url.pathname.startsWith("/e/"));
      expect(detailLinks.length).toBeGreaterThan(0);
      for (const { url } of detailLinks) {
        expect(url.searchParams.get("archivePage")).toBe("2");
        expect(url.searchParams.get("archiveQuery")).toBe(TEXT);
        expect(url.searchParams.get("archiveGame")).toBe(GAME);
        for (const arbitrary of ["returnTo", "return", "next"])
          expect(url.searchParams.has(arbitrary)).toBe(false);
      }
    });

    it.each(["  gO  ", "\tGO\n"])("normalizes outer whitespace and case for %j", async (game) => {
      const html = await (await get(archiveGamePath(game))).text();
      expect(eventKeys(html)).toEqual(gameFirstKeys);
      expect(
        gameOptions(html)
          .filter((o) => o.selected)
          .map((o) => o.value),
      ).toEqual([GAME]);
    });

    it("uses the same trim/case equivalence for stored game matches and distinct suggestions", async () => {
      await source.seed([
        gameRow(1, { game: "Go" }),
        gameRow(2, { game: "go" }),
        gameRow(3, { game: " Go " }),
        gameRow(4, { game: "Go club" }),
        gameRow(5, { game: null }),
      ]);
      const html = await (await get(archiveGamePath("GO"))).text();
      expect(eventKeys(html)).toEqual([gameKey(3), gameKey(2), gameKey(1)]);
      const equivalents = gameOptions(html).filter((o) => o.value.trim().toLowerCase() === "go");
      expect(equivalents).toHaveLength(1);
      expect(equivalents[0]!.selected).toBe(true);
    });

    it("finds explicit-past-only games even when their recorded end has not elapsed", async () => {
      const html = await (await get(archiveGamePath("Explicit past only"))).text();
      expect(eventKeys(html)).toEqual([gameKey(105)]);
      expect(totalPages(html)).toBe(1);
    });

    it("retains a syntactically valid unknown game as a zero-match facet, never All games", async () => {
      const response = await get(archiveGamePath("Never played"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const html = await response.text();
      expect(eventKeys(html)).toEqual([]);
      expect(totalPages(html)).toBe(0);
      expect(gameOptions(html).find((o) => o.selected)?.value).toBe("Never played");
      expect(html).toContain('data-testid="past-events-search-miss"');
    });

    it("uses starts_at before id when ordering a game-filtered page", async () => {
      await source.db.insert(events).values(
        gameRow(1, {
          startsAt: new Date("2029-01-01T20:00:00Z"),
          endsAt: new Date("2029-01-01T22:00:00Z"),
        }),
      );
      const html = await (await get(archiveGamePath())).text();
      expect(eventKeys(html).slice(0, 3)).toEqual([gameKey(1), gameKey(50), gameKey(48)]);
    });

    it("matches escaped Unicode game names exactly, never as a text/LIKE pattern or HTML", async () => {
      const response = await get(archiveGamePath(`  ${SPECIAL_GAME.toLowerCase()}  `));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(eventKeys(html)).toEqual([gameKey(104)]);
      expect(gameOptions(html).find((o) => o.selected)?.value).toBe(SPECIAL_GAME);
      expect(html).not.toContain("<club>");
    });

    it.each(["%", "_", "\\"])("keeps text %j literal while game is selected", async (literal) => {
      await source.seed([
        gameRow(1, { title: `Literal ${literal} meeting` }),
        gameRow(2, { title: "Literal X meeting" }),
        gameRow(3, { title: `Literal ${literal} meeting`, game: "Chess" }),
      ]);
      const html = await (await get(archiveGamePath(GAME, 1, literal))).text();
      expect(eventKeys(html)).toEqual([gameKey(1)]);
      expect(totalPages(html)).toBe(1);
    });

    it("suggests explicitly past games, excludes hidden/future-only games, and describes archive scope", async () => {
      const html = await (await get("/events/past")).text();
      const options = gameOptions(html).map((o) => o.value);
      expect(options).toContain("Explicit past only");
      expect(options).toContain(SPECIAL_GAME);
      for (const hidden of ["Draft only", "Cancelled only", "Future only"])
        expect(options).not.toContain(hidden);
      expect(html).toMatch(
        /(?:archive|past events)[\s\S]{0,250}(?:game|suggestion)|(?:game|suggestion)[\s\S]{0,250}(?:archive|past events)/i,
      );
      const distinct = source.statements.filter(({ sql }) => /select distinct\b/i.test(sql));
      expect(distinct).toHaveLength(1);
      expect(distinct[0]!.sql).toMatch(/\border by\b/i);
      const bound = /\blimit \$(\d+)/i.exec(distinct[0]!.sql);
      expect(bound).not.toBeNull();
      expect(Number(distinct[0]!.params[Number(bound![1]) - 1])).toBeLessThanOrEqual(101);
    });

    it("caps ordered suggestions without turning a selected unsuggested valid game into All games", async () => {
      await source.seed([
        ...Array.from({ length: 105 }, (_, i) =>
          gameRow(i + 1, { game: `A game ${String(i).padStart(3, "0")}` }),
        ),
        gameRow(200, { game: "Z selected outside suggestions" }),
      ]);
      const html = await (await get(archiveGamePath("Z selected outside suggestions"))).text();
      expect(eventKeys(html)).toEqual([gameKey(200)]);
      const options = gameOptions(html).filter((o) => o.value !== "");
      expect(options.length).toBeLessThanOrEqual(101);
      expect(options.find((o) => o.selected)?.value).toBe("Z selected outside suggestions");
      expect(html).toMatch(
        /(?:more|not all|limited|omitted|first \d+|up to \d+)[\s\S]{0,120}(?:games|suggestions)|(?:games|suggestions)[\s\S]{0,120}(?:more|not all|limited|omitted)/i,
      );
    });

    it("distinguishes a zero-match game from past-end and scopes page-one recovery to both filters", async () => {
      const miss = await (await get(archiveGamePath("Never played", 1, TEXT))).text();
      expect(eventKeys(miss)).toEqual([]);
      expect(totalPages(miss)).toBe(0);
      expect(miss).toContain('data-testid="past-events-search-miss"');
      expect(miss).not.toContain('data-testid="past-events-out-of-range"');
      const pastEnd = await (await get(archiveGamePath(GAME, 999, TEXT))).text();
      expect(eventKeys(pastEnd)).toEqual([]);
      expect(totalPages(pastEnd)).toBe(2);
      expect(pastEnd).toContain('data-testid="past-events-out-of-range"');
      const recovery = linksIn(pastEnd).find(
        ({ url }) =>
          url.pathname === "/events/past" &&
          Number(url.searchParams.get("page") ?? 1) === 1 &&
          url.searchParams.get("game") === GAME &&
          url.searchParams.get("q") === TEXT,
      );
      expect(
        recovery,
        "Past-end needs a usable page-one recovery retaining both filters",
      ).toBeDefined();
    });

    it("offers truthful independent clear-game and clear-text, or explicitly clear-all recovery", async () => {
      const html = await (await get(archiveGamePath("Never played", 1, TEXT))).text();
      const clears = linksIn(html).filter(
        ({ url, label }) =>
          url.pathname === "/events/past" && /clear|all games|remove|reset/i.test(label),
      );
      expect(clears.length).toBeGreaterThan(0);
      let clearsGame = false;
      let clearsText = false;
      for (const { url, label } of clears) {
        const removesGame = !url.searchParams.get("game");
        const removesText = !url.searchParams.get("q");
        clearsGame ||= removesGame;
        clearsText ||= removesText;
        if (removesGame && removesText)
          expect(label).toMatch(/all|filters|game.*(?:search|text)|(?:search|text).*game/i);
        else if (removesGame) expect(label).toMatch(/game/i);
        else if (removesText) expect(label).toMatch(/search|text/i);
        expect(Number(url.searchParams.get("page") ?? 1)).toBe(1);
      }
      expect([clearsGame, clearsText]).toEqual([true, true]);
    });

    it("carries the selected schedule game and q into the archive continuation", async () => {
      const response = await requestCalendar(
        twin,
        `/events?${new URLSearchParams({ game: GAME, q: TEXT, past: "1" })}`,
        source.env,
        kit,
      );
      expect(response.status).toBe(200);
      const continuation = linksIn(await response.text()).find(
        ({ url }) => url.pathname === "/events/past",
      );
      expect(continuation).toBeDefined();
      expect(continuation!.url.searchParams.get("game")).toBe(GAME);
      expect(continuation!.url.searchParams.get("q")).toBe(TEXT);
    });

    it("does not read a warm ordinary cache for game-only URLs or contaminate ordinary HTML", async () => {
      const ordinary = await (await get("/events/past")).text();
      source.statements.length = 0;
      const filtered = await get(archiveGamePath());
      expect(filtered.headers.get("cache-control")).toContain("private");
      expect(filtered.headers.get("cache-control")).toContain("no-store");
      expect(eventKeys(await filtered.text())).toEqual(gameFirstKeys);
      expect(source.statements.length).toBeGreaterThan(0);
      source.statements.length = 0;
      expect(await (await get("/events/past")).text()).toBe(ordinary);
      expect(source.statements).toHaveLength(0);
    });

    it("repeated game-only requests remain fresh rather than settling any shared filtered entry", async () => {
      await (await get(archiveGamePath())).text();
      await source.db
        .update(events)
        .set({ title: "Changed local fixture title" })
        .where(eq(events.id, 50));
      source.statements.length = 0;
      const response = await get(archiveGamePath());
      expect(response.headers.get("cache-control")).toContain("no-store");
      const html = await response.text();
      expect(eventKeys(html)).toEqual(gameFirstKeys);
      expect(html).toContain("Changed local fixture title");
      expect(source.statements.length).toBeGreaterThan(0);
    });

    it("does not populate ordinary anonymous keys from a cold game-only render", async () => {
      const filtered = await get(archiveGamePath());
      expect(filtered.headers.get("cache-control")).toContain("no-store");
      await filtered.text();
      source.statements.length = 0;
      const ordinary = await (await get("/events/past")).text();
      expect(eventKeys(ordinary)).not.toEqual(gameFirstKeys);
      expect(source.statements.length).toBeGreaterThan(0);
    });

    it.each([
      ["oversized game", `game=${"x".repeat(256)}`],
      ["oversized whitespace", `game=${"%20".repeat(256)}`],
      ["NUL game", "game=Go%00"],
      ["duplicate game", "game=Go&game=Chess"],
      ["duplicate text", "game=Go&q=Table&q=other"],
    ])("bounds %s before DB acquisition or warm-cache lookup", async (_label, query) => {
      await (await get("/events/past")).text();
      source.statements.length = 0;
      let acquisitions = 0;
      const env = { ...source.env };
      Object.defineProperty(env, "ADMIN_DB", {
        get() {
          acquisitions++;
          return source.db;
        },
      });
      const cacheRead = vi.spyOn(anonCache, "readAnonCache");
      const cacheWrite = vi.spyOn(anonCache, "writeAnonCache");
      const response = await requestArchive(twin, `/events/past?${query}`, env, kit);
      expect([400, 422]).toContain(response.status);
      expect(cacheRead).not.toHaveBeenCalled();
      expect(cacheWrite).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(acquisitions).toBe(0);
      expect(source.statements).toHaveLength(0);
    });

    it("CONTROL: no-game and normalized-blank URLs keep ordinary rows, canonical state and cache keys", async () => {
      const ordinary = await (await get("/events/past")).text();
      expect(eventKeys(ordinary)).toHaveLength(20);
      expect(totalPages(ordinary)).toBe(3);
      source.statements.length = 0;
      const blank = await get(archiveGamePath("   "));
      expect(blank.status).toBe(200);
      expect(eventKeys(await blank.text())).toEqual(eventKeys(ordinary));
      expect(blank.headers.get("cache-control")).toContain("public");
      expect(source.statements).toHaveLength(0);
      for (const { url, pager } of linksIn(ordinary))
        if (pager) expect(url.searchParams.has("game")).toBe(false);
    });

    it("CONTROL: text-only search still excludes game-only text matches and hidden rows", async () => {
      const html = await (await get("/events/past?q=Go")).text();
      expect(eventKeys(html)).toEqual([]);
      expect(totalPages(html)).toBe(0);
      const textOnly = await (await get(`/events/past?${new URLSearchParams({ q: TEXT })}`)).text();
      expect(totalPages(textOnly)).toBe(3);
      expect(eventKeys(textOnly)).not.toContain(gameKey(106));
      expect(eventKeys(textOnly)).not.toContain(gameKey(107));
    });
  });
}
