// route-inventory: GET /events/past
// route-inventory: GET /events
// Independent RED handoff: real Hono and executed Kit loader/SSR over disposable SQL.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import * as anonCache from "../src/events/anon-cache";
import { loadPastArchivePage } from "../src/kit-past-events";
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

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
};
// Single-pass entity decode. Each `&...;` match is replaced once from left
// to right, so an emitted `&` is never re-scanned (no double-unescape).
const decode = (s: string): string =>
  s.replace(/&(amp|quot|lt|gt);/g, (m, e: string) => ENTITIES[e] ?? m);
// Strip SSR comments without a lazy-dot regex: each iteration removes one
// `<!--...-->` span via indexOf, so the loop terminates with no complete
// comment left. An unterminated opener is kept, matching the old regex.
function stripComments(s: string): string {
  let out = "";
  let rest = s;
  let start = rest.indexOf("<!--");
  while (start !== -1) {
    const end = rest.indexOf("-->", start + 4);
    if (end === -1) return out + rest;
    out += rest.slice(0, start);
    rest = rest.slice(end + 3);
    start = rest.indexOf("<!--");
  }
  return out + rest;
}
const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
// Linear scan for `<option ...>...</option>` pairs. The tag end skips
// double-quoted spans, so a literal `>` inside a quoted attribute value
// (Svelte SSR emits those) does not end the tag. Equivalent to the old
// /<option\b((?:"[^"]*"|[^>])*)>([\s\S]*?)<\/option>/g matchAll on
// well-formed option markup, without nested quantifiers over `"`.
function optionPairs(inner: string): Array<{ attrs: string; body: string }> {
  const pairs: Array<{ attrs: string; body: string }> = [];
  let from = 0;
  while (from < inner.length) {
    const tag = inner.indexOf("<option", from);
    if (tag === -1) return pairs;
    const boundary = inner[tag + 7];
    if (boundary !== undefined && isWordChar(boundary)) {
      from = tag + 1; // `<options...` is not an option tag; keep scanning.
      continue;
    }
    let cursor = tag + 7;
    let tagEnd = -1;
    while (cursor < inner.length) {
      const char = inner[cursor];
      if (char === '"') {
        const close = inner.indexOf('"', cursor + 1);
        if (close === -1) {
          cursor += 1;
          continue;
        }
        cursor = close + 1;
        continue;
      }
      if (char === ">") {
        tagEnd = cursor;
        break;
      }
      cursor += 1;
    }
    if (tagEnd === -1) return pairs;
    const close = inner.indexOf("</option>", tagEnd + 1);
    if (close === -1) {
      from = tag + 1;
      continue;
    }
    pairs.push({ attrs: inner.slice(tag + 7, tagEnd), body: inner.slice(tagEnd + 1, close) });
    from = close + 9;
  }
  return pairs;
}
function gameOptions(html: string) {
  const select = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].find((m) =>
    /\bname="game"/.test(m[1]!),
  );
  expect(select, "Archive needs a native, named game select").toBeDefined();
  return optionPairs(select![2]!).map(({ attrs, body }) => ({
    value: decode(/\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? body),
    selected: /\bselected(?:[\s=>]|$)/.test(attrs),
    label: decode(stripComments(body).trim()),
  }));
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

    // Offered-name regression: JS and PostgreSQL fold these names
    // differently (U+0130 loses its combining dot in PG `lower`, and PG
    // never applies the contextual final-sigma rule JS applies), so a
    // JS-folded parameter can never equal the PG-folded stored value.
    // Selecting the exact offered option must still find its own row.
    it.each([
      ["İstanbul", 201],
      ["ΟΣ", 202],
    ] as const)(
      "finds the exact row and count for offered Unicode game %j whose JS/PG case folds differ",
      async (stored, n) => {
        await source.seed([
          gameRow(201, { game: "İstanbul" }),
          gameRow(202, { game: "ΟΣ" }),
          gameRow(203, { game: GAME }),
        ]);
        const offered = gameOptions(await (await get("/events/past")).text()).find(
          (o) => o.value === stored,
        );
        expect(offered, "the stored Unicode game is offered in the native select").toBeDefined();
        const response = await get(archiveGamePath(offered!.value));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(eventKeys(html)).toEqual([gameKey(n)]);
        expect(totalPages(html)).toBe(1);
        expect(gameOptions(html).find((o) => o.selected)?.value).toBe(stored);
      },
    );

    // Accepted stored CRLF: request normalization turns CRLF into LF (and a
    // real browser's attribute parsing does the same to the offered option
    // value), so every submitted representation must find the stored row.
    it("finds a stored CRLF game from its offered option and from both newline forms", async () => {
      const stored = "alpha\r\nbeta";
      await source.seed([
        gameRow(211, { game: stored }),
        gameRow(212, { game: "alpha beta" }),
        gameRow(213, { game: GAME }),
      ]);
      const offered = gameOptions(await (await get("/events/past")).text()).find(
        (o) => o.value.replace(/\r\n?/g, "\n") === "alpha\nbeta",
      );
      expect(offered, "the stored CRLF game is offered in the native select").toBeDefined();
      for (const submitted of [offered!.value, stored, "alpha\nbeta"]) {
        const response = await get(archiveGamePath(submitted));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(eventKeys(html)).toEqual([gameKey(211)]);
        expect(totalPages(html)).toBe(1);
        const selected = gameOptions(html).find((o) => o.selected);
        expect(selected?.value.replace(/\r\n?/g, "\n")).toBe("alpha\nbeta");
      }
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
      // Exactly the branded 400 on both twins: accepting 422 here would let
      // a status-swap mutant pass while breaking the twin-agreed contract.
      expect(response.status).toBe(400);
      expect(cacheRead).not.toHaveBeenCalled();
      expect(cacheWrite).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(acquisitions).toBe(0);
      expect(source.statements).toHaveLength(0);
    });

    it("keeps oversized text at exactly 422, separately from the invalid-game 400", async () => {
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
      const response = await requestArchive(
        twin,
        `/events/past?game=${GAME}&q=${"x".repeat(256)}`,
        env,
        kit,
      );
      expect(response.status).toBe(422);
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

// Direct helper admission: the Kit dispatch forwards refused input to the
// loader, so loadPastArchivePage's own game admission is the last fail-closed
// gate. Deleting it must go red here even though no route is involved.
describe("loadPastArchivePage direct admission (fail closed)", () => {
  const refused: Array<{
    label: string;
    status: number;
    args: {
      queryParam?: string | null;
      gameParam?: string | null;
      gameValues?: readonly string[] | null;
      qValues?: readonly string[] | null;
    };
  }> = [
    {
      label: "overlong game",
      status: 400,
      args: { gameParam: "x".repeat(256), gameValues: ["x".repeat(256)] },
    },
    { label: "NUL game", status: 400, args: { gameParam: "Go\0", gameValues: ["Go\0"] } },
    {
      label: "duplicate game",
      status: 400,
      args: { gameParam: "Go", gameValues: ["Go", "Chess"] },
    },
    {
      label: "duplicate q with a game",
      status: 400,
      args: {
        gameParam: "Go",
        gameValues: ["Go"],
        queryParam: "Table",
        qValues: ["Table", "other"],
      },
    },
    {
      label: "duplicate q without a game",
      status: 400,
      args: { queryParam: "Table", qValues: ["Table", "other"] },
    },
    {
      label: "oversized text stays 422",
      status: 422,
      args: { gameParam: "Go", gameValues: ["Go"], queryParam: "x".repeat(256) },
    },
  ];

  it.each(refused)(
    "refuses $label with private/no-store and zero DB, suggestion or row reads",
    async ({ status, args }) => {
      const headers: Record<string, string> = {};
      const dbForFn = vi.fn(async () => ({}) as never);
      const listArchiveGamesFn = vi.fn(async () => ({ games: [GAME], omitted: false }));
      const listPastFn = vi.fn(async () => ({ rows: [], hasMore: false, totalPages: 0 }));
      await expect(
        loadPastArchivePage({
          env: { APP_URL: "https://example.test" } as never,
          pageParam: "1",
          ...args,
          setHeaders: (next) => Object.assign(headers, next),
          dbForFn,
          listPastFn,
          listArchiveGamesFn,
        }),
      ).rejects.toMatchObject({ status });
      expect(headers["cache-control"]).toBe("private, no-store");
      expect(dbForFn).not.toHaveBeenCalled();
      expect(listArchiveGamesFn).not.toHaveBeenCalled();
      expect(listPastFn).not.toHaveBeenCalled();
    },
  );

  it("CONTROL: a valid single game reaches each read once and filters by the canonical stored game", async () => {
    const headers: Record<string, string> = {};
    const dbForFn = vi.fn(async () => ({}) as never);
    const listArchiveGamesFn = vi.fn(async () => ({ games: ["Chess", GAME], omitted: false }));
    const listPastFn = vi.fn(async (..._args: unknown[]) => ({
      rows: [] as never[],
      hasMore: false,
      totalPages: 0,
    }));
    const result = await loadPastArchivePage({
      env: { APP_URL: "https://example.test" } as never,
      pageParam: "1",
      queryParam: TEXT,
      qValues: [TEXT],
      gameParam: "go",
      gameValues: ["go"],
      setHeaders: (next) => Object.assign(headers, next),
      dbForFn,
      listPastFn,
      listArchiveGamesFn,
    });
    expect(result.game).toBe(GAME);
    expect(dbForFn).toHaveBeenCalledOnce();
    expect(listArchiveGamesFn).toHaveBeenCalledOnce();
    expect(listPastFn).toHaveBeenCalledOnce();
    expect(listPastFn.mock.calls[0]![4]).toBe(GAME);
    expect(headers["cache-control"]).toBe("private, no-store");
  });
});
