// route-inventory: GET /e/:key
// Saved-event review handback regressions (hermetic). Moderator review keeps
// its validated marker on attendee refresh/next/previous links, so paging
// inside a review never drops back to the live RSVP page; ordinary links stay
// byte-identical and never echo raw query text. Review authorizes before any
// event read and selects the dedicated review read only once admitted, so an
// unreadable saved window still renders its corrections. The cancelled
// guidance makes no listing claim. Real-store and DB-backed twins live in
// test/event-attendee-current-page-acceptance.test.ts.
import { jsx } from "hono/jsx/jsx-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { ArchiveContext } from "../src/events/attendee-paths";
import { archiveEventHref } from "../src/events/attendee-paths";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { EventPage } from "../src/events/pages-detail";
import { ATTENDEE_PAGE_SIZE, type EventAttendee, type PublicEvent } from "../src/events/reads";
import type { KitRequestSession } from "../src/kit-session";
import { eventJsonLd } from "../src/seo-json-ld";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVIL_KEY = 'a"b?c#d/e&review=1';
const ARCHIVE: ArchiveContext = { page: 3, q: "raid night" };
const ARCHIVE_SEARCH = "archivePage=3&archiveQuery=raid+night";
// Unrelated and hostile query text that must never reach a generated link.
const NOISE = "junk=evil&next=%2F%2Fevil.example&returnTo=%2F%2Fevil.example";
const now = new Date("2030-01-10T20:00:00Z");

const event: PublicEvent = {
  id: 7,
  icsSequence: 4n,
  eventKey: KEY,
  title: "Chess night",
  game: "Chess",
  description: "Bring a board.",
  startsAt: new Date("2030-01-10T21:00:00Z"),
  endsAt: new Date("2030-01-10T23:00:00Z"),
  timezone: "UTC",
  location: "Hall",
  capacity: 10,
  status: "published",
  rsvpOpen: true,
  goingCount: 0,
  goingOccupancy: 0,
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  syncRevision: 1,
  syncedRevision: 0,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: now,
  updatedAt: now,
};

const MODERATOR: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: "100000000000000002",
    username: "Moderator",
    avatar: null,
    member: true,
    moderator: true,
  },
};
const MEMBER: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: "100000000000000001",
    username: "Member",
    avatar: null,
    member: true,
    moderator: false,
  },
};
const GUEST: KitRequestSession = { status: "guest", session: null };
const UNKNOWN: KitRequestSession = { status: "unknown", session: null };

const attendee = (n: number): EventAttendee => ({ id: `owner-${n}`, name: `name-${n}` });
// Page 1 is full with a lookahead (powers Next), page 2 holds one row, page 3
// is an empty past-end page whose Previous link resets to page 1.
const attendeeWindow = (page: number): EventAttendee[] =>
  page === 1
    ? Array.from({ length: ATTENDEE_PAGE_SIZE + 1 }, (_, n) => attendee(n))
    : page === 2
      ? [attendee(ATTENDEE_PAGE_SIZE)]
      : [];

const DB = {} as Db;

function store(over: Partial<KitEventDetailStore> = {}, row: PublicEvent | null = event) {
  return {
    dbForFn: vi.fn(async () => DB),
    getEventFn: vi.fn(async () => row),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    seriesFn: async () => null,
    attendeesFn: vi.fn(async (_db: Db, _id: number, page: number) => attendeeWindow(page)),
    viewerRsvpFn: vi.fn(async () => null),
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
    ...over,
  } satisfies KitEventDetailStore;
}

async function resolve(
  search: string,
  session: KitRequestSession = MODERATOR,
  kitStore: KitEventDetailStore = store(),
  key = KEY,
) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key,
    path: `/e/${key}`,
    search,
    env: { APP_URL } as Env,
    session,
    joinResult: null,
    setHeaders: (headers) => seen.push(headers),
    store: kitStore,
  });
  return { outcome, seen };
}

async function resolveOk(search: string, kitStore: KitEventDetailStore = store()) {
  const { outcome } = await resolve(search, MODERATOR, kitStore);
  if (outcome.kind !== "ok") throw new Error(`Expected detail, got ${outcome.kind}`);
  return outcome;
}

/** Path plus every query entry, so an extra or duplicated parameter fails. */
function parts(href: string | null | undefined) {
  if (href == null) return null;
  const url = new URL(href, "https://parts.invalid");
  expect(url.origin).toBe("https://parts.invalid");
  expect(url.hash).toBe("");
  const entries = [...url.searchParams];
  return {
    path: url.pathname,
    query: Object.fromEntries(entries),
    count: entries.length,
  };
}

const expected = (
  path: string,
  query: Record<string, string>,
): { path: string; query: Record<string, string>; count: number } => ({
  path,
  query,
  count: Object.keys(query).length,
});

const archiveQuery = { archivePage: "3", archiveQuery: "raid night" };

/** Hrefs of the rendered roster links, attribute-unescaped. */
function rosterLinks(html: string) {
  const links: Record<string, string> = {};
  for (const match of html.matchAll(
    /<a href="([^"]*)"[^>]*\bdata-testid="event-attendees-(prev|next|refresh)"/g,
  )) {
    links[match[2]!] = match[1]!.replace(/&amp;/g, "&");
  }
  return links;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archiveEventHref review marker", () => {
  it("keeps ordinary links byte-identical with or without an explicit false", () => {
    for (const review of [undefined, false] as const) {
      const href = (archive: ArchiveContext | null, page?: number) =>
        review === undefined
          ? archiveEventHref(KEY, archive, page)
          : archiveEventHref(KEY, archive, page ?? 1, review);
      expect(href(null)).toBe(`/e/${KEY}`);
      expect(href(null, 2)).toBe(`/e/${KEY}?attendees=2`);
      expect(href(ARCHIVE)).toBe(`/e/${KEY}?archivePage=3&archiveQuery=raid+night`);
      expect(href(ARCHIVE, 2)).toBe(`/e/${KEY}?attendees=2&archivePage=3&archiveQuery=raid+night`);
      expect(href({ page: 1, q: "" })).toBe(`/e/${KEY}?archivePage=1`);
    }
  });

  it("adds only the validated review=1 marker beside page and archive state", () => {
    expect(parts(archiveEventHref(KEY, null, 1, true))).toEqual(
      expected(`/e/${KEY}`, { review: "1" }),
    );
    expect(parts(archiveEventHref(KEY, null, 2, true))).toEqual(
      expected(`/e/${KEY}`, { attendees: "2", review: "1" }),
    );
    expect(parts(archiveEventHref(KEY, ARCHIVE, 1, true))).toEqual(
      expected(`/e/${KEY}`, { ...archiveQuery, review: "1" }),
    );
    expect(parts(archiveEventHref(KEY, ARCHIVE, 4, true))).toEqual(
      expected(`/e/${KEY}`, { attendees: "4", ...archiveQuery, review: "1" }),
    );
  });

  it.each([false, true])(
    "encodes a hostile stored key into one path segment (review %s)",
    (review) => {
      const encoded = `/e/${encodeURIComponent(EVIL_KEY)}`;
      for (const [archive, page] of [
        [null, 1],
        [null, 2],
        [ARCHIVE, 1],
        [ARCHIVE, 2],
      ] as const) {
        const href = archiveEventHref(EVIL_KEY, archive, page, review);
        expect(href.startsWith(encoded)).toBe(true);
        expect(href).not.toMatch(/["#]/);
        expect(href.split("?")).toHaveLength(page > 1 || archive || review ? 2 : 1);
        expect(parts(href)).toEqual(
          expected(encoded, {
            ...(page > 1 ? { attendees: String(page) } : {}),
            ...(archive ? archiveQuery : {}),
            ...(review ? { review: "1" } : {}),
          }),
        );
      }
    },
  );
});

describe("Hono EventPage review refresh link", () => {
  const e = { ...event, status: "draft" };
  const base = {
    e,
    neighbors: { previous: null, next: null },
    related: [],
    appUrl: APP_URL,
    jsonLd: eventJsonLd(e, APP_URL),
    member: true,
    attendees: [attendee(0)],
    attendeesPaging: { page: 2, prevHref: archiveEventHref(KEY, ARCHIVE, 1, true), nextHref: null },
    archive: ARCHIVE,
    review: savedEventReview(e, now),
  };
  const mod = { id: "mod", username: "Mod", avatar: null, member: true, moderator: true };
  const member = { ...mod, id: "member", moderator: false };

  it("carries the review marker only for an admitted moderator review", () => {
    const html = String(jsx(EventPage, { ...base, session: mod }));
    expect(html).toContain('data-testid="event-review"');
    expect(parts(rosterLinks(html).refresh)).toEqual(
      expected(`/e/${KEY}`, { attendees: "2", ...archiveQuery, review: "1" }),
    );
    expect(html).not.toContain("data-rsvp-form");
  });

  it("drops the marker when the session is not a moderator, even if review is passed", () => {
    const html = String(jsx(EventPage, { ...base, session: member }));
    expect(html).not.toContain('data-testid="event-review"');
    expect(rosterLinks(html).refresh).toBe(archiveEventHref(KEY, ARCHIVE, 2));
  });

  it("keeps the ordinary refresh byte-identical without review", () => {
    const html = String(jsx(EventPage, { ...base, session: mod, review: undefined }));
    expect(rosterLinks(html).refresh).toBe(archiveEventHref(KEY, ARCHIVE, 2));
    expect(html).not.toContain("review=1");
  });
});

describe("Kit review attendee navigation", () => {
  const reviewLinks = {
    1: {
      refresh: expected(`/e/${KEY}`, { ...archiveQuery, review: "1" }),
      prev: null,
      next: expected(`/e/${KEY}`, { attendees: "2", ...archiveQuery, review: "1" }),
    },
    2: {
      refresh: expected(`/e/${KEY}`, { attendees: "2", ...archiveQuery, review: "1" }),
      prev: expected(`/e/${KEY}`, { ...archiveQuery, review: "1" }),
      next: null,
    },
    // Empty past-end page: Previous resets to page one, still in review.
    3: {
      refresh: expected(`/e/${KEY}`, { attendees: "3", ...archiveQuery, review: "1" }),
      prev: expected(`/e/${KEY}`, { ...archiveQuery, review: "1" }),
      next: null,
    },
  } as const;

  it.each([1, 2, 3] as const)(
    "keeps refresh/next/previous in review with archive state on page %i",
    async (page) => {
      const attendees = page > 1 ? `attendees=${page}&` : "";
      const { model, headers } = await resolveOk(
        `?review=1&${attendees}${ARCHIVE_SEARCH}&${NOISE}`,
      );
      expect(headers["cache-control"]).toBe("private, no-store");
      expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
      const want = reviewLinks[page];
      expect(parts(model.attendeesRefreshHref)).toEqual(want.refresh);
      expect(parts(model.attendeesPaging.prevHref)).toEqual(want.prev);
      expect(parts(model.attendeesPaging.nextHref)).toEqual(want.next);
      // The rendered leaf carries exactly the model's links.
      const rendered = rosterLinks(model.detailHtml.roster);
      expect(rendered.refresh).toBe(model.attendeesRefreshHref);
      expect(rendered.prev ?? null).toBe(model.attendeesPaging.prevHref);
      expect(rendered.next ?? null).toBe(model.attendeesPaging.nextHref);
      for (const html of [model.detailHtml.roster, model.detailHtml.rsvp]) {
        expect(html).not.toMatch(/junk|evil|returnTo/);
      }
      // Inert RSVP while paging a review.
      expect(model.detailHtml.rsvp).toContain("RSVP is disabled in preview.");
      expect(model.detailHtml.rsvp).not.toContain("<form");
      expect(model.detailHtml.rsvp).not.toContain("data-island");
    },
  );

  it.each([1, 2, 3])("keeps ordinary page %i links byte-identical", async (page) => {
    const attendees = page > 1 ? `attendees=${page}&` : "";
    for (const prefix of ["", "review=true&", "review=0&", "review=1x&"]) {
      const { model } = await resolveOk(`?${prefix}${attendees}${ARCHIVE_SEARCH}&${NOISE}`);
      expect(model.review).toBeUndefined();
      expect(model.attendeesRefreshHref).toBe(archiveEventHref(KEY, ARCHIVE, page));
      expect(model.attendeesPaging.prevHref).toBe(
        page > 1 ? archiveEventHref(KEY, ARCHIVE, 1) : null,
      );
      expect(model.attendeesPaging.nextHref).toBe(
        page === 1 ? archiveEventHref(KEY, ARCHIVE, 2) : null,
      );
      expect(model.detailHtml.roster).not.toContain("review=");
    }
  });

  it.each([false, true])(
    "encodes a hostile stored key in every roster link (review %s)",
    async (review) => {
      const hostile = store({}, { ...event, eventKey: EVIL_KEY });
      const { model } = await resolveOk(
        `?${review ? "review=1&" : ""}attendees=2&${ARCHIVE_SEARCH}`,
        hostile,
      );
      const path = `/e/${encodeURIComponent(EVIL_KEY)}`;
      const marker: Record<string, string> = review ? { review: "1" } : {};
      expect(parts(model.attendeesRefreshHref)).toEqual(
        expected(path, { attendees: "2", ...archiveQuery, ...marker }),
      );
      expect(parts(model.attendeesPaging.prevHref)).toEqual(
        expected(path, { ...archiveQuery, ...marker }),
      );
      for (const href of Object.values(rosterLinks(model.detailHtml.roster))) {
        expect(href.startsWith(path)).toBe(true);
        expect(href).not.toMatch(/["#]/);
      }
    },
  );

  it.each([
    ["guest", GUEST, "forbidden", 403],
    ["member", MEMBER, "forbidden", 403],
    ["unknown", UNKNOWN, "unavailable", 503],
  ] as const)("refuses %s review before any event read", async (_label, session, kind, status) => {
    const getReviewEventFn = vi.fn(async () => event);
    const kitStore = store({ getReviewEventFn });
    const { outcome, seen } = await resolve(
      `?review=1&attendees=2&${ARCHIVE_SEARCH}`,
      session,
      kitStore,
    );
    expect(outcome).toMatchObject({ kind, status });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe("private, no-store");
    expect(kitStore.getEventFn).not.toHaveBeenCalled();
    expect(getReviewEventFn).not.toHaveBeenCalled();
    expect(kitStore.attendeesFn).not.toHaveBeenCalled();
    expect(kitStore.viewerRsvpFn).not.toHaveBeenCalled();
  });
});

describe("Kit review read selection", () => {
  const unreadable: PublicEvent = {
    ...event,
    status: "draft",
    title: 'Raid <script>alert("t")</script>',
    location: '<img src=x onerror="bad">',
    startsAt: new Date(Number.NaN),
    endsAt: new Date(Number.NaN),
  };

  it("selects the review read only for an admitted moderator review", async () => {
    // The ordinary read refuses the unreadable window (as getPublicEvent does);
    // only the review read returns it.
    const getReviewEventFn = vi.fn(async () => unreadable);
    const kitStore = store({ getReviewEventFn }, null);
    const outcome = await resolveOk("?review=1", kitStore);
    expect(getReviewEventFn).toHaveBeenCalledTimes(1);
    expect(getReviewEventFn).toHaveBeenCalledWith(DB, KEY);
    expect(kitStore.getEventFn).not.toHaveBeenCalled();
    const { model, headers } = outcome;
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(model.robots).toBe("noindex, nofollow");
    expect(model.whenText).toBe("Time unavailable");
    expect(model.endsWhenText).toBe("Time unavailable");
    expect(model.detailHtml.metadata).toContain("Time unavailable");
    expect(model.review?.banner).toContain("Fix these before publishing");
    for (const anchor of ["#f-starts-at", "#f-ends-at"]) {
      expect(model.review?.banner).toContain(`href="/admin/events/${KEY}${anchor}"`);
    }
    expect(model.review?.banner).toContain("The saved start time can&#39;t be read.");
    expect(model.review?.banner).toContain("The saved end time can&#39;t be read.");
    // Escaped server leaves; the title stays raw text for Svelte to escape.
    expect(model.title).toBe(unreadable.title);
    expect(model.detailHtml.metadata).toContain("&lt;img src=x");
    for (const html of [
      model.detailHtml.metadata,
      model.detailHtml.roster,
      model.detailHtml.rsvp,
      model.review!.banner,
      model.review!.actions,
      model.review!.rsvp,
    ]) {
      expect(html).not.toMatch(/<(?:script|img|svg)\b/);
    }
    expect(model.detailHtml.rsvp).toContain("RSVP is disabled in preview.");
    expect(model.detailHtml.rsvp).not.toContain("<form");
    expect(model.detailHtml.rsvp).not.toContain("data-island");
    expect(JSON.parse(model.jsonLd)).not.toHaveProperty("startDate");
  });

  it("keeps ordinary reads on the ordinary read, which still refuses the window", async () => {
    const getReviewEventFn = vi.fn(async () => unreadable);
    for (const [search, session] of [
      ["", MODERATOR],
      ["?review=0", MODERATOR],
      ["", MEMBER],
      ["", GUEST],
    ] as const) {
      const kitStore = store({ getReviewEventFn }, null);
      const { outcome } = await resolve(search, session, kitStore);
      expect(outcome).toMatchObject({ kind: "missing", status: 404 });
      expect(kitStore.getEventFn).toHaveBeenCalledWith(DB, KEY);
    }
    expect(getReviewEventFn).not.toHaveBeenCalled();
  });

  it("answers 404 when the review read finds no row", async () => {
    const getReviewEventFn = vi.fn(async () => null);
    const kitStore = store({ getReviewEventFn });
    const { outcome } = await resolve("?review=1", MODERATOR, kitStore);
    expect(outcome).toMatchObject({ kind: "missing", status: 404 });
    expect(getReviewEventFn).toHaveBeenCalledWith(DB, KEY);
    expect(kitStore.getEventFn).not.toHaveBeenCalled();
  });

  it("lets a fixture without the review read reuse its injected read", async () => {
    const kitStore = store({}, unreadable);
    const { model } = await resolveOk("?review=1", kitStore);
    expect(kitStore.getEventFn).toHaveBeenCalledWith(DB, KEY);
    expect(model.whenText).toBe("Time unavailable");
  });

  it("keeps a malformed key 404 before any read, review or not", async () => {
    for (const search of ["", "?review=1"]) {
      const getReviewEventFn = vi.fn(async () => event);
      const kitStore = store({ getReviewEventFn });
      const { outcome } = await resolve(search, MODERATOR, kitStore, "invalid-key");
      expect(outcome).toMatchObject({ kind: "missing", status: 404 });
      expect(kitStore.getEventFn).not.toHaveBeenCalled();
      expect(getReviewEventFn).not.toHaveBeenCalled();
    }
  });
});

describe("cancelled review guidance", () => {
  it("keeps status guidance without the false listing claim on Kit and Hono", async () => {
    const cancelled = { ...event, status: "cancelled" };
    const { model } = await resolveOk("?review=1", store({}, cancelled));
    expect(model.review?.banner).toContain("This event is cancelled.");
    expect(model.review?.banner).not.toContain("listings");
    expect(model.review?.banner).not.toContain("Members don&#39;t see it");
    const html = String(
      jsx(EventPage, {
        e: cancelled,
        neighbors: { previous: null, next: null },
        related: [],
        appUrl: APP_URL,
        jsonLd: eventJsonLd(cancelled, APP_URL),
        session: { id: "mod", username: "Mod", avatar: null, member: true, moderator: true },
        review: savedEventReview(cancelled, now),
      }),
    );
    expect(html).toContain("This event is cancelled.");
    expect(html).not.toContain("see it in listings");
    expect(html).toContain('data-testid="event-cancelled"');
  });
});
