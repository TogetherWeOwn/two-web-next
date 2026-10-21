// route-inventory: GET /events/past
// Fail-first acceptance for past-archive edge links and pager testids.
// The header "upcoming schedule" must link to /events, the out-of-range
// notice must link back into range, and the pager + back link must carry
// testids — identically on the Hono and Kit twins. Search/prefill, 422 and
// failed-search behavior is pinned unchanged. Local fixtures only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import * as contracts from "../src/islands/contracts";
import {
  EVENTS_SEARCH_TOO_LONG_COPY,
  PAST_EVENTS_COPY,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../src/islands/contracts";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  ARCHIVE_QUERY,
  archiveReadFixture,
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

// New contract testids this suite prescribes. The Builder adds them to
// contracts-past-events.ts; the namespace lookup fails (undefined) until then.
const NEW_TESTIDS = {
  PAST_EVENTS_PAGER_TESTID: "past-events-pager",
  PAST_EVENTS_PAGER_NEWER_TESTID: "past-events-pager-newer",
  PAST_EVENTS_PAGER_OLDER_TESTID: "past-events-pager-older",
  PAST_EVENTS_BACK_TESTID: "past-events-back",
} as const;

const textOf = (markup: string): string =>
  markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function anchorsIn(html: string): {
  href: string;
  label: string;
  testid: string | null;
  pager: boolean;
}[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => {
    const attrs = m[1]!;
    return {
      href: (attrs.match(/\bhref="([^"]*)"/)?.[1] ?? "").replaceAll("&amp;", "&"),
      label: textOf(m[2]!).replaceAll("&amp;", "&"),
      testid: attrs.match(/\bdata-testid="([^"]*)"/)?.[1] ?? null,
      pager: /\bdata-archive-page\b/.test(attrs),
    };
  });
}

const headingOf = (html: string): string => {
  const m = html.match(/<div class="schedule-heading">([\s\S]*?)<\/div>/);
  expect(m, "schedule heading block renders").not.toBeNull();
  return m![1]!;
};

const noticeOf = (html: string): string => {
  const m = html.match(
    new RegExp(
      `<p\\b[^>]*data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"[^>]*>([\\s\\S]*?)<\\/p>`,
    ),
  );
  expect(m, "out-of-range notice renders").not.toBeNull();
  return m![1]!;
};

const navOf = (html: string): { attrs: string; inner: string } => {
  const m = html.match(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/);
  expect(m, "pager nav renders").not.toBeNull();
  return { attrs: m![1]!, inner: m![2]! };
};

const pageNumber = (url: URL): number => Number(url.searchParams.get("page") ?? 1);

describe("past archive edge-link contract", () => {
  it("exports the pager and back-link testids from the island contracts", () => {
    for (const [name, value] of Object.entries(NEW_TESTIDS)) {
      expect((contracts as Record<string, unknown>)[name]).toBe(value);
    }
  });
});

describe.each(archiveTwins)("%s past-archive edge links", (twin) => {
  it("links the header upcoming schedule to /events", async () => {
    const source = archiveReadFixture();
    const body = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    const heading = headingOf(body);

    expect(textOf(heading)).toBe(
      "The archive Past events Game nights we’ve shared. Find the next one in the upcoming schedule.",
    );
    const upcoming = anchorsIn(heading).filter((link) => link.label.includes("upcoming schedule"));
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.href).toBe("/events");
  });

  it("links the out-of-range notice back into range", async () => {
    const source = archiveReadFixture();
    const body = await (
      await requestArchive(twin, "/events/past?page=999", source.env, kit)
    ).text();

    expect(body).toContain('data-page="999"');
    expect(body).toContain('data-total-pages="3"');
    const notice = noticeOf(body);
    expect(textOf(notice)).toContain(pastEventsOutOfRangeCopy(999, 3));
    const recovery = anchorsIn(notice);
    expect(recovery.length).toBeGreaterThanOrEqual(1);
    for (const link of recovery) {
      const url = new URL(link.href, ARCHIVE_ORIGIN);
      expect(url.pathname).toBe("/events/past");
      expect([1, 3]).toContain(pageNumber(url));
      expect(url.searchParams.has("q")).toBe(false);
    }
  });

  it("preserves the search query on the out-of-range recovery link", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: ARCHIVE_QUERY, page: "999" })}`;
    const body = await (await requestArchive(twin, path, source.env, kit)).text();

    expect(body).toContain('data-total-pages="2"');
    const recovery = anchorsIn(noticeOf(body));
    expect(recovery.length).toBeGreaterThanOrEqual(1);
    for (const link of recovery) {
      const url = new URL(link.href, ARCHIVE_ORIGIN);
      expect(url.pathname).toBe("/events/past");
      expect([1, 2]).toContain(pageNumber(url));
      expect(url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
    }
  });

  it("pins both pager directions with testids on a middle page", async () => {
    const source = archiveReadFixture();
    const body = await (await requestArchive(twin, "/events/past?page=2", source.env, kit)).text();

    expect(body).toContain('data-page="2"');
    expect(body).toContain('data-total-pages="3"');
    const nav = navOf(body);
    expect(nav.attrs).toContain("data-archive-pager");
    expect(nav.attrs).toContain('aria-label="Past event pages"');
    expect(nav.attrs).toContain(`data-testid="${NEW_TESTIDS.PAST_EVENTS_PAGER_TESTID}"`);
    const pager = anchorsIn(nav.inner);
    expect(pager).toHaveLength(2);
    expect(pager[0]).toMatchObject({
      label: "Newer",
      href: pastEventsUrl(1),
      testid: NEW_TESTIDS.PAST_EVENTS_PAGER_NEWER_TESTID,
      pager: true,
    });
    expect(pager[1]).toMatchObject({
      label: "Older",
      href: pastEventsUrl(3),
      testid: NEW_TESTIDS.PAST_EVENTS_PAGER_OLDER_TESTID,
      pager: true,
    });
  });

  it("pins the single pager direction at the archive ends", async () => {
    const source = archiveReadFixture();
    const first = await (await requestArchive(twin, "/events/past", source.env, kit)).text();
    const firstPager = anchorsIn(navOf(first).inner);
    expect(firstPager).toHaveLength(1);
    expect(firstPager[0]).toMatchObject({
      label: "Older",
      href: pastEventsUrl(2),
      testid: NEW_TESTIDS.PAST_EVENTS_PAGER_OLDER_TESTID,
      pager: true,
    });

    const last = await (await requestArchive(twin, "/events/past?page=3", source.env, kit)).text();
    const lastPager = anchorsIn(navOf(last).inner);
    expect(lastPager).toHaveLength(1);
    expect(lastPager[0]).toMatchObject({
      label: "Newer",
      href: pastEventsUrl(2),
      testid: NEW_TESTIDS.PAST_EVENTS_PAGER_NEWER_TESTID,
      pager: true,
    });
  });

  it("pins the back link to the upcoming schedule", async () => {
    const source = archiveReadFixture();
    for (const path of ["/events/past", "/events/past?page=999"]) {
      const body = await (await requestArchive(twin, path, source.env, kit)).text();
      const back = anchorsIn(body).filter((link) => link.label === "Back to upcoming events");
      expect(back).toHaveLength(1);
      expect(back[0]!.href).toBe("/events");
      expect(back[0]!.testid).toBe(NEW_TESTIDS.PAST_EVENTS_BACK_TESTID);
      expect(back[0]!.pager).toBe(false);
    }
  });

  it("keeps filtered search results, status copy and clear-search recovery", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: ARCHIVE_QUERY, page: "1" })}`;
    const response = await requestArchive(twin, path, source.env, kit);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(eventKeys(body)).toEqual(firstMatchKeys);
    expect(body).toContain('data-total-pages="2"');
    expect(body).toContain(`data-query="${ARCHIVE_QUERY}"`);
    expect(body).toContain(`Past events matching “${ARCHIVE_QUERY}”.`);
    const clear = linksIn(body).find(
      (link) =>
        link.label === "Clear search" &&
        link.url.pathname === "/events/past" &&
        !link.url.searchParams.get("q") &&
        pageNumber(link.url) === 1,
    );
    expect(clear).toBeDefined();
    const cleared = await requestArchive(twin, clear!.url.href, source.env, kit);
    expect(eventKeys(await cleared.text())).toHaveLength(20);
    expect(cleared.headers.get("cache-control")).toContain("public");
  });

  it("rejects an oversized query with 422 before any read", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: "x".repeat(256) })}`;
    const response = await requestArchive(twin, path, source.env, kit);

    expect(response.status).toBe(422);
    expect(source.statements).toEqual([]);
    expect(await response.text()).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
  });

  it("admits a 255-code-point query with the failed-search copy", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: "x".repeat(255) })}`;
    const response = await requestArchive(twin, path, source.env, kit);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(eventKeys(body)).toEqual([]);
    expect(body).toContain("No past events match your search.");
  });

  it("keeps zero-match failed search distinct from out-of-range", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: "no such meeting" })}`;
    const body = await (await requestArchive(twin, path, source.env, kit)).text();

    expect(eventKeys(body)).toEqual([]);
    expect(body).toContain("No past events match your search.");
    expect(body).not.toContain(PAST_EVENTS_OUT_OF_RANGE_TESTID);
    expect(linksIn(body).some((link) => link.label === "Clear search")).toBe(true);
    expect(body).toContain(`data-load-error="${PAST_EVENTS_COPY.failed}"`);
  });

  it("carries the query on pager turns without unrelated URL state", async () => {
    const source = archiveReadFixture();
    const path = `/events/past?${new URLSearchParams({ q: ARCHIVE_QUERY, page: "1" })}&month=2030-01`;
    const body = await (await requestArchive(twin, path, source.env, kit)).text();
    const pager = linksIn(body).filter((link) => link.pager);

    expect(pager).toHaveLength(1);
    expect(pager[0]!.url.pathname).toBe("/events/past");
    expect(pager[0]!.url.searchParams.get("q")).toBe(ARCHIVE_QUERY);
    expect(pageNumber(pager[0]!.url)).toBe(2);
    expect(pager[0]!.url.searchParams.has("month")).toBe(false);
  });
});
