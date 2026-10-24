// route-inventory: GET /events/past
// route-inventory: GET /e/:key
// Independent, locked acceptance. Builder consumes these files unchanged.
// Transport names are discovered from real card hrefs, not invented here.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as access from "../src/admin/store-access";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  ARCHIVE_ORIGIN,
  DETAIL_PATH,
  QUERY,
  RAW_QUERY,
  attendeeId,
  compileReturnTwins,
  eventKey,
  returnFixture,
  type Viewer,
} from "./helpers/archive-detail-return-acceptance";
import {
  archiveTwins,
  eventKeys,
  linksIn,
  type ArchiveTwin,
} from "./helpers/past-archive-search-acceptance";

let twins: Awaited<ReturnType<typeof compileReturnTwins>>;
let source: ReturnType<typeof returnFixture>;
let audited: string[][];
beforeAll(async () => {
  twins = await compileReturnTwins();
});
afterAll(() => twins?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-06-15T12:00:00Z"));
  source = returnFixture();
  audited = [];
  // Only the external audit write is faked; real reads, owner declarations,
  // buffered rendering and the release decision remain inside the boundary.
  vi.spyOn(access, "recordAccess").mockImplementation(async (_db, entry) => {
    audited.push(entry.subjectUserIds);
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const relative = (url: URL) => url.pathname + url.search;
const archivePath = (q = RAW_QUERY, page = "2") =>
  `/events/past?${new URLSearchParams({ page, q })}`;
async function detail(twin: ArchiveTwin, url: URL, viewer: Viewer = "guest") {
  return twins.detail(twin, url, source, viewer, async (entry) => {
    audited.push(entry.subjectUserIds);
    return true;
  });
}
async function card(twin: ArchiveTwin, q = RAW_QUERY, page = "2", enhanced = false) {
  const response = await twins.archive(twin, archivePath(q, page), source, enhanced);
  expect(response.status).toBe(200);
  const html = await response.text();
  const link = linksIn(html).find((link) => link.url.pathname === DETAIL_PATH);
  expect(link, "archive fixture must contain the fifth event on page two").toBeDefined();
  return { url: link!.url, html };
}
function fields(url: URL, query = QUERY) {
  const entries = [...url.searchParams.entries()];
  const page = entries.find(([, value]) => value === "2")?.[0];
  const q = entries.find(([, value]) => value === query)?.[0];
  expect(page, "card href must carry its normalized archive page").toBeDefined();
  expect(q, "card href must carry its normalized archive query").toBeDefined();
  expect(page).not.toBe(q);
  return { page: page!, q: q! };
}
function archiveReturn(html: string, page = "2", query: string | null = QUERY) {
  const candidates = linksIn(html).filter(
    (link) =>
      link.url.origin === ARCHIVE_ORIGIN &&
      link.url.pathname === "/events/past" &&
      (link.url.searchParams.get("page") ?? "1") === page &&
      link.url.searchParams.get("q") === query,
  );
  expect(
    candidates.length,
    "detail must offer a labelled return to the exact archive result",
  ).toBeGreaterThan(0);
  const link = candidates.find((link) =>
    /back|return|results|search|past|archive/i.test(link.label),
  );
  expect(link, "return anchor needs a useful visible accessible name").toBeDefined();
  expect([...link!.url.searchParams.keys()].every((key) => key === "q" || key === "page")).toBe(
    true,
  );
  return link!.url;
}
function fallback(html: string) {
  const link = linksIn(html).find((link) => /all events/i.test(link.label));
  expect(link, "direct/invalid context keeps All events").toBeDefined();
  expect(link!.url.href).toBe(`${ARCHIVE_ORIGIN}/events`);
  expect(linksIn(html).some((link) => link.url.hostname === "evil.example")).toBe(false);
}
function cleanDestinations(html: string) {
  const canonical = `${ARCHIVE_ORIGIN}${DETAIL_PATH}`;
  expect(html).toMatch(
    new RegExp(`rel="canonical"[^>]*href="${canonical}"|href="${canonical}"[^>]*rel="canonical"`),
  );
  const copy = html.match(/<a\b[^>]*data-copy-link="([^"]+)"[^>]*>/)?.[1];
  expect(copy).toBe(canonical);
  expect(html).toContain(`property="og:url" content="${canonical}"`);
  const links = linksIn(html);
  expect(links.find((link) => /Copy link/.test(link.label))?.url.href).toBe(canonical);
  const icsTag = [...html.matchAll(/<a\b[^>]*>/g)].find(([tag]) =>
    tag.includes('data-testid="event-ics"'),
  )?.[0];
  expect(icsTag, "the event-specific calendar link is present").toBeDefined();
  const ics = new URL(
    icsTag!.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"),
    ARCHIVE_ORIGIN,
  );
  expect(ics.pathname).toBe(`/events/${eventKey(5)}.ics`);
  expect(ics.search).toBe("");
  const eventJson = html.match(
    /<script[^>]*data-testid="event-jsonld"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  expect(eventJson, "event share metadata is present").toBeDefined();
  expect(JSON.parse(eventJson!).url).toBe(canonical);
  const google = links.find(
    (link) => link.url.hostname === "calendar.google.com" || link.url.hostname === "www.google.com",
  );
  expect(google, "fixture has a Google Calendar destination").toBeDefined();
  expect(Object.fromEntries(google!.url.searchParams)).toEqual({
    action: "TEMPLATE",
    text: `${QUERY} 5`,
    dates: "20310110T200000Z/20310110T220000Z",
  });
  expect(google!.url.search).not.toContain("attendees");
  expect(google!.url.search).not.toContain("archive");
  // Public metadata and JSON-LD may mention the event, never the browse context.
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).not.toContain(encodeURIComponent(QUERY));
}
function privateDetail(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe.each(archiveTwins)("%s archive → detail → same results", (twin) => {
  it("CONTROL: the fixture serves a real member roster, bounded lookahead and clean public destinations", async () => {
    source.setEvent({
      status: "published",
      startsAt: new Date("2031-01-10T20:00:00Z"),
      endsAt: new Date("2031-01-10T22:00:00Z"),
    });
    const response = await detail(
      twin,
      new URL(`${DETAIL_PATH}?attendees=2`, ARCHIVE_ORIGIN),
      "member",
    );
    expect(response.status).toBe(200);
    privateDetail(response);
    const html = await response.text();
    expect(html).toContain(">return-attendee-100</a>");
    expect(html).toContain(">return-attendee-199</a>");
    expect(html).not.toContain(">return-attendee-200</a>");
    expect(audited).toEqual([Array.from({ length: 101 }, (_, i) => attendeeId(100 + i))]);
    cleanDestinations(html);
    fallback(html);
  });

  it("CONTROL: a failed audit still refuses member bytes even when arbitrary browse context is present", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(access.recordAccess).mockResolvedValue(false);
    const response = await twins.detail(
      twin,
      new URL(`${DETAIL_PATH}?returnTo=/events/past&page=2`, ARCHIVE_ORIGIN),
      source,
      "member",
      async () => false,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("return-attendee-");
  });

  it.each([false, true])(
    "native/enhanced HTML card carries normalized Unicode/quoted query and page (enhanced=%s)",
    async (enhanced) => {
      const { url, html } = await card(twin, RAW_QUERY, "2suffix", enhanced);
      expect(eventKeys(html)).toEqual([5, 4, 3, 2, 1].map(eventKey));
      expect(url.origin).toBe(ARCHIVE_ORIGIN);
      expect(url.pathname).toBe(DETAIL_PATH);
      const names = fields(url);
      expect(url.searchParams.getAll(names.q)).toEqual([QUERY]);
      expect(url.searchParams.getAll(names.page)).toEqual(["2"]);
      expect(url.search).not.toContain("%00");
    },
  );

  it("opens independently in a same tab/new tab and survives a fresh document reload without referrer/storage", async () => {
    const { url } = await card(twin);
    // Three fresh GETs, with neither Referer nor browser-side state. This also
    // proves the link is useful with no JavaScript, not an onclick-only action.
    for (let visit = 0; visit < 3; visit++) {
      const response = await detail(twin, new URL(url.href));
      expect(response.status).toBe(200);
      privateDetail(response);
      const html = await response.text();
      const back = archiveReturn(html);
      const returned = await twins.archive(twin, relative(back), source);
      expect(eventKeys(await returned.text())).toEqual([5, 4, 3, 2, 1].map(eventKey));
    }
  });

  it("understands the other archive twin's context too", async () => {
    const { url } = await card(twin === "Hono" ? "Kit" : "Hono");
    const response = await detail(twin, url);
    expect(response.status).toBe(200);
    archiveReturn(await response.text());
  });

  it("normalizes an admitted raw query at the detail boundary as well as at the producer", async () => {
    const { url } = await card(twin);
    const names = fields(url);
    url.searchParams.set(names.q, RAW_QUERY);
    archiveReturn(await (await detail(twin, url)).text());
  });

  it("retains an unfiltered archive page and the ordinary first page, not an invented search", async () => {
    for (const page of ["1", "2"]) {
      const response = await twins.archive(twin, `/events/past?page=${page}`, source);
      const url = linksIn(await response.text()).find((link) =>
        link.url.pathname.startsWith("/e/"),
      )!.url;
      const html = await (
        await detail(twin, new URL(DETAIL_PATH + url.search, ARCHIVE_ORIGIN))
      ).text();
      archiveReturn(html, page, null);
    }
  });

  it("preserves archive context independently of attendee page, pager and refresh without leaking lookahead", async () => {
    const { url } = await card(twin);
    let current = new URL(url.href);
    for (const page of [1, 2, 3]) {
      const response = await detail(twin, current, "member");
      expect(response.status).toBe(200);
      privateDetail(response);
      const html = await response.text();
      const first = (page - 1) * 100;
      expect(html).toContain(`>return-attendee-${first}</a>`);
      expect(html).not.toContain(`>return-attendee-${page * 100}</a>`);
      const expectedIds = Array.from({ length: Math.min(101, 205 - first) }, (_, i) =>
        attendeeId(first + i),
      );
      expect(audited.at(-1)).toEqual(expectedIds);
      archiveReturn(html);
      const refresh = linksIn(html).find((link) => /Refresh attendees/.test(link.label))!.url;
      expect(refresh.searchParams.get("attendees") ?? "1").toBe(String(page));
      expect(relative(archiveReturn(await (await detail(twin, refresh, "member")).text()))).toBe(
        relative(archiveReturn(html)),
      );
      if (page < 3) {
        const next = linksIn(html).find(
          (link) => link.url.searchParams.get("attendees") === String(page + 1),
        );
        expect(next, "native attendee pager remains present").toBeDefined();
        current = next!.url;
      } else {
        const prev = linksIn(html).find((link) => link.url.searchParams.get("attendees") === "2");
        expect(prev).toBeDefined();
        archiveReturn(await (await detail(twin, prev!.url, "member")).text());
      }
    }
  });

  it.each(["🌌".repeat(255), "https://evil.example/path?x=1", 'a%_\\ "quoted"  query'])(
    "preserves admitted literal query %s rather than treating it as a return URL",
    async (query) => {
      source.setArchiveQuery(query);
      const { url } = await card(twin, query);
      fields(url, query);
      archiveReturn(await (await detail(twin, url)).text(), "2", query);
    },
  );

  it("keeps canonical, copy, social, ICS and Google Calendar targets context-free", async () => {
    const { url } = await card(twin);
    url.searchParams.set("attendees", "2");
    source.setEvent({
      status: "published",
      startsAt: new Date("2031-01-10T20:00:00Z"),
      endsAt: new Date("2031-01-10T22:00:00Z"),
    });
    const html = await (await detail(twin, url, "member")).text();
    cleanDestinations(html);
    archiveReturn(html);
  });

  it.each(["guest", "outsider"] as const)(
    "does not turn archive context into a member grant for %s",
    async (viewer) => {
      const { url } = await card(twin);
      const response = await detail(twin, url, viewer);
      expect(response.status).toBe(200);
      privateDetail(response);
      const html = await response.text();
      expect(html).not.toContain("return-attendee-");
      expect(html).not.toContain('data-testid="event-attendees"');
      expect(audited).toEqual([]);
      expect(source.statements.some(({ sql }) => sql.startsWith('select "users"."id"'))).toBe(
        false,
      );
    },
  );

  it.each(["draft", "cancelled", "missing"] as const)(
    "does not change %s visibility or served status",
    async (status) => {
      const { url } = await card(twin);
      source.setEvent(status === "missing" ? null : { status });
      const response = await detail(twin, url, "guest");
      expect(response.status).toBe(status === "draft" ? 403 : status === "cancelled" ? 410 : 404);
      expect(await response.text()).not.toContain("return-attendee-");
      expect(audited).toEqual([]);
    },
  );

  it("keeps direct visits on All events", async () => {
    fallback(await (await detail(twin, new URL(DETAIL_PATH, ARCHIVE_ORIGIN))).text());
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/profile",
    "/events?past=1&q=raid",
    "%E0%A4%A",
    "x".repeat(2048),
  ])("does not accept arbitrary/unrelated return URL %s", async (returnTo) => {
    const url = new URL(DETAIL_PATH, ARCHIVE_ORIGIN);
    url.search = new URLSearchParams({ returnTo, return: returnTo, next: returnTo }).toString();
    const response = await detail(twin, url);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    fallback(await response.text());
  });

  it.each([
    "0",
    "-1",
    "NaN",
    "9007199254740992",
    "https://evil.example/",
    "//evil.example/",
    "2&next=/profile",
  ])(
    "rejects invalid structured archive page %s after proving the unmodified context is accepted",
    async (badPage) => {
      const { url } = await card(twin);
      const names = fields(url);
      archiveReturn(await (await detail(twin, url)).text());
      url.searchParams.set(names.page, badPage);
      const response = await detail(twin, url);
      expect(response.status).toBe(200);
      fallback(await response.text());
    },
  );

  it.each(["🌌".repeat(256), " ".repeat(256), "\0".repeat(256)])(
    "rejects raw over-bound structured archive query before normalization",
    async (badQuery) => {
      const { url } = await card(twin);
      const names = fields(url);
      archiveReturn(await (await detail(twin, url)).text());
      url.searchParams.set(names.q, badQuery);
      fallback(await (await detail(twin, url)).text());
    },
  );

  it.each(["same-page", "different-page", "same-query", "different-query"] as const)(
    "rejects duplicate/ambiguous context (%s), not first-value-wins",
    async (duplicate) => {
      const { url } = await card(twin);
      const names = fields(url);
      archiveReturn(await (await detail(twin, url)).text());
      url.searchParams.append(
        duplicate.endsWith("page") ? names.page : names.q,
        duplicate === "same-page"
          ? "2"
          : duplicate === "different-page"
            ? "3"
            : duplicate === "same-query"
              ? QUERY
              : "other",
      );
      fallback(await (await detail(twin, url)).text());
    },
  );

  it("rejects malformed UTF-8 in context rather than creating a different search", async () => {
    const { url } = await card(twin);
    const names = fields(url);
    archiveReturn(await (await detail(twin, url)).text());
    url.searchParams.delete(names.q);
    url.search += `&${encodeURIComponent(names.q)}=%E0%A4%A`;
    fallback(await (await detail(twin, url)).text());
  });
});
