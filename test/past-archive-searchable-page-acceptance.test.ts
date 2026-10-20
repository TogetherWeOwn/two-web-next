// route-inventory: GET /events/past
// Acceptance: the past page is searchable from itself and the pager names its
// position (M191 T1). RED-first for the build: the GET form and "Page N of M"
// exist on neither twin yet. The controls pin what the build must not change:
// empty/empty-search/out-of-range copy, the fragment-turn inputs the shipped
// binder validates, and the overlong-q 422 path (owned by TOG-34202).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  EVENTS_SEARCH_TOO_LONG_COPY,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  pastEventsOutOfRangeCopy,
} from "../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  ARCHIVE_QUERY,
  archiveReadFixture,
  archiveRows,
  archiveTwins,
  compileArchiveKit,
  eventKeys,
  firstMatchKeys,
  linksIn,
  requestArchive,
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

// Plain-HTML parsing: the contract is SSR markup, so a plain GET submission
// works with JS off and no DOM library is needed. Fail loudly on ambiguity.
const attr = (tag: string, name: string): string | null => {
  const match = new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
  if (!match) return null;
  const raw = match[1]!;
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
};

function islandSection(html: string): string {
  const match = /<section\b[^>]*data-island="past-events"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(match, "expected the past-events island section").toBeTruthy();
  return match![1]!;
}

function formsIn(html: string): { method: string | null; action: URL; body: string }[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({
    method: attr(m[1]!, "method"),
    action: new URL(
      (attr(m[1]!, "action") ?? "/events/past").replaceAll("&amp;", "&"),
      ARCHIVE_ORIGIN,
    ),
    body: m[2]!,
  }));
}

const inputsNamed = (formBody: string, name: string): string[] =>
  [...formBody.matchAll(/<input\b([^>]*)>/g)]
    .map((m) => m[1]!)
    .filter((tag) => attr(tag, "name") === name);

function hasSubmit(formBody: string): boolean {
  const buttons = [...formBody.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]!);
  if (
    buttons.some((tag) => {
      const type = attr(tag, "type");
      return type === null || type.toLowerCase() === "submit";
    })
  )
    return true;
  return [...formBody.matchAll(/<input\b([^>]*)>/g)]
    .map((m) => m[1]!)
    .some((tag) => ["submit", "image"].includes(attr(tag, "type")?.toLowerCase() ?? ""));
}

function pagerNav(html: string): string {
  const match = /<nav\b[^>]*data-archive-pager[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(match, "expected a [data-archive-pager] nav").toBeTruthy();
  return match![1]!;
}

// Valueless zone attributes render bare (`>`, Kit `=""`, Hono `="true"`);
// the lookahead accepts all three spellings but never a longer name.
const zoneCount = (html: string, zone: string): number =>
  [...html.matchAll(new RegExp(`${zone}(?=[\\s>=])`, "g"))].length;

// Attribute-order tolerant: Hono and Kit shells emit the same tags in their
// own order, and the binder requires canonical and og:url to agree exactly.
function canonicalsIn(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => attr(tag, "rel") === "canonical")
    .map((tag) => attr(tag, "href")!.replaceAll("&amp;", "&"));
}

function ogUrlsIn(html: string): string[] {
  return [...html.matchAll(/<meta\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => attr(tag, "property") === "og:url")
    .map((tag) => attr(tag, "content")!.replaceAll("&amp;", "&"));
}

function expectSearchForm(html: string) {
  const searchForms = formsIn(islandSection(html)).filter(
    (form) => inputsNamed(form.body, "q").length > 0,
  );
  expect(searchForms, "expected exactly one archive search form").toHaveLength(1);
  const form = searchForms[0]!;
  // Plain GET navigation: a missing method defaults to GET; post/dialog would
  // break the JS-off contract.
  expect(["get", null].includes(form.method?.toLowerCase() ?? null)).toBe(true);
  expect(form.action.pathname).toBe("/events/past");
  // Submitting starts from page 1: no page state in the action, and no q
  // there either, or the field would submit a duplicate query.
  expect(form.action.searchParams.has("page")).toBe(false);
  expect(form.action.searchParams.has("q")).toBe(false);
  const qInputs = inputsNamed(form.body, "q");
  expect(qInputs).toHaveLength(1);
  expect(attr(qInputs[0]!, "type")?.toLowerCase() ?? "text").not.toBe("hidden");
  expect(inputsNamed(form.body, "page")).toHaveLength(0);
  expect(hasSubmit(form.body)).toBe(true);
  return form;
}

describe.each(archiveTwins)("%s searchable past page", (twin) => {
  it.each(["/events/past", searchPath(ARCHIVE_QUERY, 1), searchPath(ARCHIVE_QUERY, 2)])(
    "renders one GET search form with a q field and no page state on %s",
    async (path) => {
      const source = archiveReadFixture();
      const html = await (await requestArchive(twin, path, source.env, kit)).text();
      expectSearchForm(html);
    },
  );

  it("renders the search form on empty and out-of-range states, not just result pages", async () => {
    const source = archiveReadFixture();
    source.replaceRows([]);
    expectSearchForm(await (await requestArchive(twin, "/events/past", source.env, kit)).text());
    source.replaceRows(archiveRows());
    expectSearchForm(
      await (await requestArchive(twin, searchPath(ARCHIVE_QUERY, 999), source.env, kit)).text(),
    );
  });

  it("submits a fresh search to page one with q carried into the pager", async () => {
    const source = archiveReadFixture();
    const landing = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    const form = expectSearchForm(landing);
    // What the browser navigates to on submit: the action plus the named fields.
    const submit = new URL(form.action.href);
    submit.searchParams.set("q", ARCHIVE_QUERY);
    expect(submit.pathname).toBe("/events/past");
    expect(submit.searchParams.has("page")).toBe(false);
    const results = await requestArchive(twin, submit.pathname + submit.search, source.env, kit);
    expect(results.status).toBe(200);
    const html = await results.text();
    expect(html).toContain('data-page="1"');
    expect(eventKeys(html)).toEqual(firstMatchKeys);
    const pager = linksIn(html).filter((link) => link.pager);
    expect(pager).toHaveLength(1);
    expect(pager[0]!.url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
  });

  it.each([
    ["/events/past", "Page 1 of 3"],
    [searchPath(ARCHIVE_QUERY, 1), "Page 1 of 2"],
    [searchPath(ARCHIVE_QUERY, 2), "Page 2 of 2"],
  ])("shows pager position %s on %s", async (path, position) => {
    const source = archiveReadFixture();
    const html = await (await requestArchive(twin, path, source.env, kit)).text();
    expect(pagerNav(html)).toContain(position);
  });

  it("preserves the Newer/Older pager links on plain and searched pages", async () => {
    const source = archiveReadFixture();
    const plain = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    expect(linksIn(plain).filter((link) => link.pager)).toHaveLength(1);
    const older = linksIn(plain).find((link) => link.pager)!;
    expect(older.label).toBe("Older");
    expect(older.url.pathname + older.url.search).toBe("/events/past?page=2");
    const first = await (
      await requestArchive(twin, searchPath(ARCHIVE_QUERY, 1), source.env, kit)
    ).text();
    const firstPager = linksIn(first).filter((link) => link.pager);
    expect(firstPager).toHaveLength(1);
    expect(firstPager[0]!.label).toBe("Older");
    expect(firstPager[0]!.url.searchParams.get("page")).toBe("2");
    expect(firstPager[0]!.url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
    const second = await (
      await requestArchive(twin, searchPath(ARCHIVE_QUERY, 2), source.env, kit)
    ).text();
    const secondPager = linksIn(second).filter((link) => link.pager);
    expect(secondPager).toHaveLength(1);
    expect(secondPager[0]!.label).toBe("Newer");
    expect(secondPager[0]!.url.searchParams.get("page")).toBeNull();
    expect(secondPager[0]!.url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
  });

  it("keeps the empty-search copy and clear-search recovery distinct from out-of-range", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath("no such meeting"), source.env, kit);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(eventKeys(html)).toEqual([]);
    expect(html).toContain("No past events match your search.");
    expect(html).not.toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    expect(html).not.toContain(PAST_EVENTS_COPY.empty);
    const clear = linksIn(html).find(
      (link) =>
        link.url.pathname === "/events/past" &&
        !link.url.searchParams.get("q") &&
        (link.url.searchParams.get("page") ?? "1") === "1" &&
        link.label.length > 0,
    );
    expect(clear, "expected a clear-search recovery link").toBeDefined();
  });

  it("keeps the never-run archive copy, join pitch and bare canonical", async () => {
    const source = archiveReadFixture();
    source.replaceRows([]);
    const html = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    expect(eventKeys(html)).toEqual([]);
    expect(html).toContain(`data-testid="${PAST_EVENTS_EMPTY_TESTID}"`);
    expect(html).toContain(PAST_EVENTS_COPY.empty);
    expect(html).toContain(PAST_EVENTS_COPY.join);
    expect(canonicalsIn(html)).toEqual([`${ARCHIVE_ORIGIN}/events/past`]);
  });

  it("keeps the out-of-range copy, total and q-carrying recovery on searched far pages", async () => {
    const source = archiveReadFixture();
    const html = await (
      await requestArchive(twin, searchPath(ARCHIVE_QUERY, 999), source.env, kit)
    ).text();
    expect(eventKeys(html)).toEqual([]);
    expect(html).toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(html).toContain(pastEventsOutOfRangeCopy(999, 2));
    expect(html).toContain('data-page="999"');
    expect(html).toContain('data-total-pages="2"');
    const recovery = linksIn(html).find((link) => link.pager);
    expect(recovery, "expected a q-carrying recovery pager link").toBeDefined();
    expect(recovery!.url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
    expect(Number(recovery!.url.searchParams.get("page") ?? 1)).toBeLessThanOrEqual(2);
    expect(canonicalsIn(html)).toEqual([`${ARCHIVE_ORIGIN}/events/past?page=999&q=Raid++night`]);
  });

  it("keeps the fragment-turn inputs consistent on searched pages", async () => {
    const source = archiveReadFixture();
    const html = await (
      await requestArchive(twin, searchPath(ARCHIVE_QUERY, 2), source.env, kit)
    ).text();
    // The shipped binder swaps exactly these zones and refuses a turn unless
    // the incoming canonical search equals archiveSearch(page, query).
    for (const zone of ["data-archive-state", "data-archive-list", "data-archive-pager"]) {
      expect(zoneCount(html, zone), `expected exactly one ${zone}`).toBe(1);
    }
    expect(html).toContain(`data-query="${ARCHIVE_QUERY}"`);
    expect(html).toContain('data-page="2"');
    expect(html).toContain('data-total-pages="2"');
    const canonical = `${ARCHIVE_ORIGIN}/events/past?page=2&q=Raid++night`;
    expect(canonicalsIn(html)).toEqual([canonical]);
    expect(ogUrlsIn(html)).toEqual([canonical]);
  });

  it("leaves the overlong-q 422 path untouched: reject before reads", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath("x".repeat(256)), source.env, kit);
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).not.toContain("public");
    expect(source.statements).toEqual([]);
    expect(await response.text()).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
  });
});
