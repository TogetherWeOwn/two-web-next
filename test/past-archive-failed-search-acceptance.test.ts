// route-inventory: GET /events
// route-inventory: GET /events/past
// Acceptance-owned: a failed past search stays inside the archive.
// The build implements this contract; it never edits this file.
//
// Contract under test:
// - Past miss (200, search with zero matches) renders a miss block pinned by
//   data-testid="past-events-search-miss" that names the (escaped) query and
//   carries a clear-search link back to /events/past (no q param, page 1).
// - Hono overlong-query 422 for /events/past returns to the archive
//   (a link to /events/past), keeps 422 + no-store + the too-long notice, and
//   never echoes the query. The /events 422 return is unchanged.
// - Kit 422 destinations are untouched here; their current shapes are pinned.
// - Hit, empty-archive and out-of-range states are unchanged (no miss block).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  EVENTS_SEARCH_TOO_LONG_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
} from "../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_QUERY,
  archiveReadFixture,
  archiveTwins,
  compileArchiveKit,
  eventKeys,
  firstMatchKeys,
  linksIn,
  requestArchive,
  requestCalendar,
  type ArchiveTwin,
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

/** Miss-block pin the build adds to both twins (see header contract). */
const PAST_SEARCH_MISS_TESTID = "past-events-search-miss";
const MISS_QUERY = "no such meeting";

const searchPath = (q: string, page = 1) =>
  `/events/past?${new URLSearchParams({ q, page: String(page) })}`;

/** Extract the miss block by testid; null when the build has not added it yet. */
function missBlock(html: string): string | null {
  const match = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${PAST_SEARCH_MISS_TESTID}"[^>]*>([\\s\\S]*?)</\\1>`,
  ).exec(html);
  return match ? match[0] : null;
}

function clearToArchive(html: string) {
  return linksIn(html).find(
    (link) =>
      link.url.pathname === "/events/past" &&
      !link.url.searchParams.get("q") &&
      Number(link.url.searchParams.get("page") ?? 1) === 1 &&
      link.label.length > 0,
  );
}

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cache-control")).not.toContain("public");
}

describe.each(archiveTwins)("%s failed past search stays in the archive", (twin) => {
  it("names the missed query, offers clear-search back to the archive, and pins a testid", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath(MISS_QUERY), source.env, kit);
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = await response.text();
    expect(eventKeys(body)).toEqual([]);
    expect(body).not.toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    const miss = missBlock(body);
    expect(miss).not.toBeNull();
    expect(miss).toContain(MISS_QUERY);
    expect(clearToArchive(miss!)).toBeDefined();
  });

  it("escapes markup in the named miss query instead of rendering it", async () => {
    const source = archiveReadFixture();
    const q = '<img src="x">';
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(response.status).toBe(200);
    const miss = missBlock(await response.text());
    expect(miss).not.toBeNull();
    expect(miss).toContain("&lt;img");
    expect(miss).not.toContain("<img");
  });

  it("keeps the hit state unchanged: matching banner, clear link, no miss block", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath(ARCHIVE_QUERY), source.env, kit);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(eventKeys(body)).toEqual(firstMatchKeys);
    expect(body).toContain("Past events matching");
    expect(clearToArchive(body)).toBeDefined();
    expect(body).not.toContain(PAST_SEARCH_MISS_TESTID);
  });

  it("keeps the empty archive unchanged: no miss block on a query-free empty page", async () => {
    const source = archiveReadFixture();
    source.replaceRows([]);
    const response = await requestArchive(twin, "/events/past", source.env, kit);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PAST_EVENTS_EMPTY_TESTID);
    expect(body).not.toContain(PAST_SEARCH_MISS_TESTID);
  });

  it("keeps the out-of-range state unchanged: no miss block past the last page", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, searchPath(ARCHIVE_QUERY, 999), source.env, kit);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(eventKeys(body)).toEqual([]);
    expect(body).toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    expect(body).not.toContain(PAST_SEARCH_MISS_TESTID);
  });
});

describe("past miss block twin parity", () => {
  it("renders the same miss testid, named query and archive return in both twins", async () => {
    const bodies: Record<ArchiveTwin, string> = {} as Record<ArchiveTwin, string>;
    for (const twin of archiveTwins) {
      const source = archiveReadFixture();
      bodies[twin] = await (
        await requestArchive(twin, searchPath(MISS_QUERY), source.env, kit)
      ).text();
    }
    const misses = {
      Hono: missBlock(bodies.Hono),
      Kit: missBlock(bodies.Kit),
    };
    expect(misses.Hono).not.toBeNull();
    expect(misses.Kit).not.toBeNull();
    for (const miss of [misses.Hono!, misses.Kit!]) {
      expect(miss).toContain(`data-testid="${PAST_SEARCH_MISS_TESTID}"`);
      expect(miss).toContain(MISS_QUERY);
      expect(clearToArchive(miss)).toBeDefined();
    }
    expect(clearToArchive(misses.Hono!)!.url.pathname).toBe(
      clearToArchive(misses.Kit!)!.url.pathname,
    );
  });
});

describe("Hono overlong past search 422", () => {
  const overlong = (sentinel: string) => sentinel + "x".repeat(256 - sentinel.length);

  it("returns to the archive, keeps 422 + no-store, and never echoes the query", async () => {
    const source = archiveReadFixture();
    const q = overlong("past422probe");
    const response = await requestArchive("Hono", searchPath(q), source.env, kit);
    expect(response.status).toBe(422);
    expectPrivate(response);
    expect(source.statements).toEqual([]);
    const body = await response.text();
    expect(body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(body).toContain('href="/events/past"');
    expect(body).not.toContain('<a href="/events">Back to events</a>');
    expect(body).not.toContain("past422probe");
  });

  it("leaves the /events 422 return unchanged", async () => {
    const source = archiveReadFixture();
    const q = overlong("events422probe");
    const response = await requestCalendar(
      "Hono",
      `/events?${new URLSearchParams({ q })}`,
      source.env,
      kit,
    );
    expect(response.status).toBe(422);
    expectPrivate(response);
    const body = await response.text();
    expect(body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(body).toContain('<a href="/events">Back to events</a>');
    expect(body).not.toContain("events422probe");
  });
});

describe("Kit 422 untouched pins", () => {
  it("keeps the Kit past-archive 422 an unechoed notice without archive chrome", async () => {
    const source = archiveReadFixture();
    const q = `kitpast422probe${"x".repeat(256 - "kitpast422probe".length)}`;
    const response = await requestArchive("Kit", searchPath(q), source.env, kit);
    expect(response.status).toBe(422);
    expectPrivate(response);
    expect(source.statements).toEqual([]);
    const body = await response.text();
    expect(body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(body).not.toContain("kitpast422probe");
    expect(body).not.toContain('data-testid="past-events"');
  });

  it("keeps the Kit /events 422 an unechoed notice returning to /events", async () => {
    const source = archiveReadFixture();
    const q = `kitevents422probe${"x".repeat(256 - "kitevents422probe".length)}`;
    const response = await requestCalendar(
      "Kit",
      `/events?${new URLSearchParams({ q })}`,
      source.env,
      kit,
    );
    expect(response.status).toBe(422);
    expectPrivate(response);
    expect(source.statements).toEqual([]);
    const body = await response.text();
    expect(body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(body).toContain('href="/events"');
    expect(body).not.toContain("kitevents422probe");
  });
});
