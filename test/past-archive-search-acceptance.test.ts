// route-inventory: GET /events
// route-inventory: GET /events/past
// Independent acceptance: extending the bounded preview, not changing its old cap.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import { PAST_EVENTS_COPY, PAST_EVENTS_OUT_OF_RANGE_TESTID } from "../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_QUERY,
  archiveReadFixture,
  archiveRow,
  archiveRows,
  archiveTwins,
  compileArchiveKit,
  eventKeys,
  firstMatchKeys,
  lastMatchKeys,
  linksIn,
  requestArchive,
  requestCalendar,
} from "./helpers/past-archive-search-acceptance";

vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
}, 60_000);
afterAll(() => kit?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const searchPath = (q = ARCHIVE_QUERY, page = 1) =>
  `/events/past?${new URLSearchParams({ q, page: String(page) })}`;
const queryMeaning = (q: string | null) => q?.replaceAll("\0", "").trim().toLowerCase();
const isClear = (link: ReturnType<typeof linksIn>[number]) =>
  link.url.pathname === "/events/past" &&
  !link.url.searchParams.get("q") &&
  Number(link.url.searchParams.get("page") ?? 1) === 1 &&
  link.label.length > 0;
function privateSearch(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cache-control")).not.toContain("public");
  expect(response.headers.get("x-two-past-cacheable")).toBeNull();
}

describe("archive link label extraction", () => {
  it.each([
    [' <span title="next > page">Next <strong>page</strong></span> ', "Next page"],
    ["<span title='previous > page'>Previous page</span>", "Previous page"],
    ["<!-- fixture > marker -->Clear <span>search</span>", "Clear search"],
    ["  &lt;Raid&gt; &amp; tea  ", "&lt;Raid&gt; &amp; tea"],
  ])("reads assertion text from fixture fragment %j", (fragment, label) => {
    const links = linksIn(
      `<a data-archive-page href="/events/past?q=Raid&amp;page=2">${fragment}</a>`,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe(label);
    expect(links[0]!.url.searchParams.get("q")).toBe("Raid");
    expect(links[0]!.url.searchParams.get("page")).toBe("2");
    expect(links[0]!.pager).toBe(true);
  });

  it.each(["<span", '<span title="unfinished>', "<!-- unfinished >"])(
    "rejects incomplete fixture markup %j rather than inventing a link label",
    (fragment) => {
      expect(() => linksIn(`<a href="/events/past">${fragment}</a>`)).toThrow(
        "Incomplete archive link label fixture",
      );
    },
  );
});

describe.each(archiveTwins)("%s archive search acceptance", (twin) => {
  it("preserves the ordinary 20-row archive and reuses its anonymous cache", async () => {
    const source = archiveReadFixture();
    const first = await requestArchive(twin, "/events/past", source.env, kit);
    const body = await first.text();
    expect(first.status).toBe(200);
    expect(eventKeys(body)).toHaveLength(20);
    expect(body).toContain('data-total-pages="3"');
    expect(body).not.toContain('data-island="rsvp-button"');
    expect(first.headers.get("cache-control")).toContain("public");
    source.statements.length = 0;
    expect(await (await requestArchive(twin, "/events/past", source.env, kit)).text()).toBe(body);
    expect(source.statements).toEqual([]);
  });

  it("filters before paging and counting: 25 matches, 20 + 5, no duplicates or unrelated rows", async () => {
    const source = archiveReadFixture();
    const first = await requestArchive(twin, searchPath(), source.env, kit);
    const second = await requestArchive(twin, searchPath(ARCHIVE_QUERY, 2), source.env, kit);
    const bodies = await Promise.all([first.text(), second.text()]);
    expect(eventKeys(bodies[0]!)).toEqual(firstMatchKeys);
    expect(eventKeys(bodies[1]!)).toEqual(lastMatchKeys);
    expect(new Set(bodies.flatMap(eventKeys)).size).toBe(25);
    for (const body of bodies) {
      expect(body).toContain('data-total-pages="2"');
      expect(body).not.toContain('data-island="rsvp-button"');
    }
    privateSearch(first);
    privateSearch(second);
  });

  it("carries the literal query in both native pager directions without unrelated URL state", async () => {
    const source = archiveReadFixture();
    for (const page of [1, 2]) {
      const body = await (
        await requestArchive(
          twin,
          `${searchPath(ARCHIVE_QUERY, page)}&month=2030-01&view=calendar`,
          source.env,
          kit,
        )
      ).text();
      const pager = linksIn(body).filter((link) => link.pager);
      expect(pager).toHaveLength(1);
      expect(pager[0]!.url.pathname).toBe("/events/past");
      expect(queryMeaning(pager[0]!.url.searchParams.get("q"))).toBe("raid  night");
      expect(Number(pager[0]!.url.searchParams.get("page") ?? 1)).toBe(page === 1 ? 2 : 1);
      expect(pager[0]!.url.searchParams.has("month")).toBe(false);
      expect(pager[0]!.url.searchParams.has("view")).toBe(false);
    }
  });

  it.each([
    ["  raID  NIGHT  ", firstMatchKeys],
    ["Raid\0  night", firstMatchKeys],
    ["Raid night", []],
    ["no such meeting", []],
  ])("uses existing trim/NUL/case/literal-whitespace matching for %j", async (q, expected) => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(response.status).toBe(200);
    expect(eventKeys(await response.text())).toEqual(expected);
    privateSearch(response);
  });

  it.each(["", "  ", "\0", " \0 "])("keeps normalized blank %j an ordinary archive", async (q) => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(response.status).toBe(200);
    expect(eventKeys(await response.text())).toHaveLength(20);
    expect(response.headers.get("cache-control")).toContain("public");
  });

  it("round-trips percent, underscore, backslash and ampersand as literals, not LIKE wildcards", async () => {
    const source = archiveReadFixture();
    const q = "100%_\\ & tea";
    source.replaceRows([
      archiveRow(200, { eventKey: "literal", title: q }),
      archiveRow(199, { eventKey: "wildcard-decoy", title: "100XX & tea" }),
      ...archiveRows(),
    ]);
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(eventKeys(await response.text())).toEqual(["literal"]);
    privateSearch(response);
  });

  it.each([
    ["255 ASCII", "x".repeat(255)],
    ["255 astral", "😀".repeat(255)],
    ["128 astral", "😀".repeat(128)],
  ])("admits %s code points without truncation", async (_label, q) => {
    const source = archiveReadFixture();
    source.replaceRows([
      archiveRow(200, { eventKey: "boundary-target", title: q }),
      archiveRow(199, { eventKey: "truncation-decoy", title: [...q].slice(0, -1).join("") }),
    ]);
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(response.status).toBe(200);
    expect(eventKeys(await response.text())).toEqual(["boundary-target"]);
    privateSearch(response);
  });

  it.each([
    ["ASCII", "x".repeat(256)],
    ["astral", "😀".repeat(256)],
    ["whitespace", " ".repeat(256)],
    ["NUL", "\0".repeat(256)],
  ])(
    "rejects 256 raw %s code points before reads, even if normalization would shorten q",
    async (_label, q) => {
      const source = archiveReadFixture();
      const response = await requestArchive(twin, searchPath(q), source.env, kit);
      expect(response.status).toBe(422);
      privateSearch(response);
      expect(source.statements).toEqual([]);
      const body = await response.text();
      if (q[0] === "x" || q.startsWith("😀")) expect(body).not.toContain(q);
    },
  );

  it("checks raw length before a warm ordinary-cache hit can hide an oversized blank query", async () => {
    const source = archiveReadFixture();
    const ordinary = await requestArchive(twin, "/events/past", source.env, kit);
    expect(eventKeys(await ordinary.text())).toHaveLength(20);
    source.statements.length = 0;
    for (const q of [" ".repeat(256), "\0".repeat(256)]) {
      const response = await requestArchive(twin, searchPath(q), source.env, kit);
      expect(response.status).toBe(422);
      privateSearch(response);
      expect(source.statements).toEqual([]);
    }
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["not a number", "invalid"],
    ["overflow", "9".repeat(400)],
  ])("normalizes invalid page (%s) without losing the filter", async (_label, page) => {
    const source = archiveReadFixture();
    const body = await (
      await requestArchive(
        twin,
        `/events/past?${new URLSearchParams({ q: ARCHIVE_QUERY, page })}`,
        source.env,
        kit,
      )
    ).text();
    expect(eventKeys(body)).toEqual(firstMatchKeys);
    expect(body).toContain('data-page="1"');
    expect(source.statements.every(({ sql }) => !sql.includes(" offset "))).toBe(true);
  });

  it("separates no matches from out-of-range and supplies usable recovery for each", async () => {
    const source = archiveReadFixture();
    const empty = await (
      await requestArchive(twin, searchPath("no such meeting"), source.env, kit)
    ).text();
    expect(eventKeys(empty)).toEqual([]);
    expect(empty).not.toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    expect(empty).not.toContain(PAST_EVENTS_COPY.empty);
    expect(linksIn(empty).some(isClear)).toBe(true);
    source.statements.length = 0;
    const far = await (
      await requestArchive(twin, searchPath(ARCHIVE_QUERY, 999), source.env, kit)
    ).text();
    expect(eventKeys(far)).toEqual([]);
    expect(far).toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    expect(far).toContain('data-total-pages="2"');
    expect(source.statements).toHaveLength(2);
    expect(source.statements[0]!.sql).toMatch(/^select distinct/i);
    expect(source.statements[1]!.sql).not.toContain(" offset ");
    const recovery = linksIn(far).find((link) => link.pager);
    expect(recovery).toBeDefined();
    expect(queryMeaning(recovery!.url.searchParams.get("q"))).toBe("raid  night");
    expect(Number(recovery!.url.searchParams.get("page") ?? 1)).toBeLessThanOrEqual(2);
  });

  it("offers an intentional clear from a nonempty search back to the ordinary archive", async () => {
    const source = archiveReadFixture();
    const body = await (await requestArchive(twin, searchPath(), source.env, kit)).text();
    const clear = linksIn(body).find(isClear);
    expect(clear).toBeDefined();
    const response = await requestArchive(twin, clear!.url.href, source.env, kit);
    expect(eventKeys(await response.text())).toHaveLength(20);
    expect(response.headers.get("cache-control")).toContain("public");
  });

  it("never serves warm unfiltered HTML to q, or one query to another", async () => {
    const source = archiveReadFixture();
    const ordinary = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    const a = await requestArchive(twin, searchPath(), source.env, kit);
    expect(eventKeys(await a.text())).toEqual(firstMatchKeys);
    privateSearch(a);
    const b = await requestArchive(twin, searchPath("Chess", 2), source.env, kit);
    expect(eventKeys(await b.text())).toEqual([
      "archive-other-5",
      "archive-other-4",
      "archive-other-3",
      "archive-other-2",
      "archive-other-1",
    ]);
    privateSearch(b);
    expect(await (await requestArchive(twin, "/events/past", source.env, kit)).text()).toBe(
      ordinary,
    );
  });

  it("does not settle a search into any shared entry, including repeated q and cookie requests", async () => {
    const source = archiveReadFixture();
    for (const init of [undefined, { headers: { cookie: "unrelated=1" } }]) {
      const first = await requestArchive(twin, searchPath(), source.env, kit, init);
      privateSearch(first);
      source.replaceRows([archiveRow(100, { eventKey: "fresh-search", title: ARCHIVE_QUERY })]);
      const fresh = await requestArchive(twin, searchPath(), source.env, kit, init);
      expect(eventKeys(await fresh.text())).toEqual(["fresh-search"]);
      source.replaceRows(archiveRows());
    }
    const ordinary = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    expect(eventKeys(ordinary)).toHaveLength(20);
    expect(ordinary).toContain('data-total-pages="3"');
  });

  it("retains ordinary archive cache retirement while query reads remain isolated", async () => {
    const source = archiveReadFixture();
    await requestArchive(twin, "/events/past", source.env, kit);
    source.replaceRows([archiveRow(100, { eventKey: "after-retirement" })]);
    retireAnonEventCaches();
    const response = await requestArchive(twin, "/events/past", source.env, kit);
    expect(eventKeys(await response.text())).toEqual(["after-retirement"]);
    expect(response.headers.get("cache-control")).toContain("public");
  });
});

describe("calendar search continuation", () => {
  it.each(archiveTwins)(
    "%s keeps the past preview bounded and links to the same filtered archive",
    async (twin) => {
      const source = archiveReadFixture();
      const response = await requestCalendar(
        twin,
        `/events?${new URLSearchParams({ q: ARCHIVE_QUERY, past: "1" })}`,
        source.env,
        kit,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(eventKeys(html)).toEqual(firstMatchKeys);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const continuation = linksIn(html).filter((link) => link.url.pathname === "/events/past");
      expect(
        continuation.some((link) => queryMeaning(link.url.searchParams.get("q")) === "raid  night"),
      ).toBe(true);
    },
  );
});
