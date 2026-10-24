// route-inventory: GET /e/:key
// SvelteKit migration card 25/43: the live /e/:key detail (published, past
// and moderator draft reads) shares the framework-free model in
// src/events/kit-detail.ts. Hono keeps serving — the manifest entry stays
// disabled until the RSVP companion (card 26/43) passes — so this suite pins
// the read contract the future Kit load binds: gate order, member-only
// attendee disclosure with audited subjects, and the metadata/timezone/copy
// surface the Svelte presentation renders.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { memberReadResponse } from "../src/member-reads";
import type { KitRequestSession } from "../src/kit-session";
import type { JoinResult } from "../src/return-journey";
import { events } from "../src/db/admin-schema";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import {
  dispatchEventDetailRequest,
  eventDetailConsumesFlash,
  eventDetailErrorPayload,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import { ROUTE_MANIFEST, resolveRouteOwner } from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "100000000000000001";
const MOD_ID = "100000000000000002";

function row(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
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
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

const NEIGHBORS: EventNeighbors = {
  previous: null,
  next: {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
  },
};

const RELATED: EventLink[] = [NEIGHBORS.next!];

const ATTENDEES: EventAttendee[] = [
  { id: "100000000000000003", name: "ann" },
  { id: "100000000000000004", name: "bob" },
];

const ANSWER: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

const SUGGESTIONS: SuggestedEvent[] = [
  {
    key: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Game night",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    location: "Voice channel",
  },
];

const GUEST: KitRequestSession = { status: "guest", session: null };
const UNKNOWN: KitRequestSession = { status: "unknown", session: null };
const memberSession = (userId = MEMBER_ID, moderator = false): KitRequestSession => ({
  status: "authenticated",
  session: { userId, username: "member", avatar: null, member: true, moderator },
});

// Hermetic store: in-memory fakes behind the same seams the Kit load binds to
// the real reads. Published by default; override per case.
function fakeStore(
  over: Partial<{
    event: PublicEvent | null;
    eventError: Error;
    neighbors: EventNeighbors;
    related: EventLink[];
    attendees: EventAttendee[];
    answer: ViewerRsvp | null;
    waitlist: number | null;
    suggestions: SuggestedEvent[];
    db: Db | null;
    dbError: Error;
  }> = {},
): KitEventDetailStore {
  const event = { ...row(), goingCount: 3 } as PublicEvent;
  return {
    dbForFn: async () => {
      if (over.dbError) throw over.dbError;
      return over.db === undefined ? ({} as Db) : over.db;
    },
    getEventFn: async () => {
      if (over.eventError) throw over.eventError;
      return over.event === undefined ? event : over.event;
    },
    neighborsFn: async () => over.neighbors ?? NEIGHBORS,
    relatedFn: async () => over.related ?? RELATED,
    attendeesFn: async () => over.attendees ?? ATTENDEES,
    // Explicit null is "no answer" (a member who never answered); only an
    // absent key falls back to the default going answer.
    viewerRsvpFn: async () => (over.answer !== undefined ? over.answer : ANSWER),
    waitlistFn: async () => over.waitlist ?? null,
    suggestionsFn: async () => over.suggestions ?? SUGGESTIONS,
  };
}

const env = { APP_URL } as unknown as Env;

async function resolve(
  key: string,
  store: KitEventDetailStore,
  session: KitRequestSession = GUEST,
  joinResult: JoinResult | null = null,
  search = "",
) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key,
    search,
    path: `/e/${key}`,
    env,
    session,
    joinResult,
    setHeaders: (headers) => seen.push(headers),
    store,
  });
  return { outcome, seen };
}

describe("event-detail route ownership", () => {
  it("declares the disabled member-read entry so Hono keeps serving", () => {
    const entry = ROUTE_MANIFEST.find(
      (candidate) => candidate.method === "GET" && candidate.path === "/e/:key",
    );
    expect(entry).toMatchObject({
      enabled: false,
      reads: { resource: "member", action: "list", route: "events.page" },
    });
    expect(resolveRouteOwner({ method: "GET", path: `/e/${KEY}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: `/e/${KEY}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: `/e/${KEY.toLowerCase()}` })).toBe("hono");
  });

  it("disables hydration at the layout so the 410/404 error pages ship no script", () => {
    // SvelteKit error pages inherit csr from the layouts above the failing
    // page, not from +page.server.ts: without this layout the branded 410/404
    // responses carry an inline bootstrap script the CSP (script-src 'self')
    // blocks, while the Hono 410/404 pages carry none.
    const layout = readFileSync(
      new URL("../web/src/routes/e/[key]/+layout.server.ts", import.meta.url),
      "utf8",
    );
    // Anchored: a commented-out export must fail too.
    expect(layout).toMatch(/^export const csr = false;/m);
  });

  it("disables hydration at the event page so navigation loads a fresh document", () => {
    // The device-timezone comparison is document-scoped island state: with
    // csr=false every /e/:key navigation is a full document load, so a
    // previous event's converted time can never linger under the next event's
    // host schedule. Re-enabling hydration must fail here, not ship silently.
    const page = readFileSync(
      new URL("../web/src/routes/e/[key]/+page.server.ts", import.meta.url),
      "utf8",
    );
    // Anchored: a commented-out export must fail too.
    expect(page).toMatch(/^export const csr = false;/m);
  });

  it("wires the load through the branded error payloads and the flash rule", () => {
    // Deleting the error-payload mapping or the flash delete must fail: a
    // refactor back to a bare error(410, "...") or a dropped delete would
    // otherwise go unnoticed.
    const load = readFileSync(
      new URL("../web/src/routes/e/[key]/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(load).toContain("eventDetailErrorPayload(outcome)");
    expect(load).toContain("cookies.delete(JOIN_RESULT_COOKIE");
  });
});

describe("event-detail gate order", () => {
  it("301s a lowercase ULID to the canonical key before any read, keeping the query", async () => {
    const store = fakeStore();
    const dbForFn = vi.fn(store.dbForFn);
    const { outcome, seen } = await resolve(
      KEY.toLowerCase(),
      { ...store, dbForFn },
      GUEST,
      null,
      "?tab=about",
    );
    expect(outcome).toEqual({ kind: "redirect", location: `/e/${KEY}?tab=about` });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("maps a forged key to missing without a database read", async () => {
    const store = fakeStore();
    const dbForFn = vi.fn(store.dbForFn);
    const { outcome, seen } = await resolve("nope!!", { ...store, dbForFn });
    expect(outcome.kind).toBe("missing");
    expect(dbForFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(outcome.model.suggestions).toHaveLength(1);
  });

  it("maps a database outage to 503 before any event read", async () => {
    const store = fakeStore({ db: null });
    const getEventFn = vi.fn(store.getEventFn);
    const { outcome, seen } = await resolve(KEY, { ...store, getEventFn });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    expect(outcome.headers).toEqual({ "cache-control": "private, no-store" });
    expect(getEventFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("maps a thrown event read to 503, never a 500", async () => {
    const { outcome } = await resolve(KEY, fakeStore({ eventError: new Error("boom") }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
  });

  it("maps a thrown database binding to 503 before any event read", async () => {
    const store = fakeStore({ dbError: new Error("pool down") });
    const getEventFn = vi.fn(store.getEventFn);
    const { outcome, seen } = await resolve(KEY, { ...store, getEventFn });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    expect(outcome.headers).toEqual({ "cache-control": "private, no-store" });
    expect(getEventFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("maps a valid key with no row to missing with cached suggestions", async () => {
    const { outcome, seen } = await resolve(KEY, fakeStore({ event: null }));
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(outcome.model.suggestions).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("maps a suggestions outage to missing with no suggestions", async () => {
    const store = fakeStore({ event: null });
    const { outcome } = await resolve(KEY, {
      ...store,
      suggestionsFn: async () => {
        throw new Error("suggestions down");
      },
    });
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.model.suggestions).toEqual([]);
  });

  it("refuses an indeterminate session as unavailable after the public lookup", async () => {
    // Mirrors the served handler: the event read and the cancelled branch run
    // before the session read, so an outage there is a 503, never a logout
    // and never a guest render of member state.
    const store = fakeStore();
    const getEventFn = vi.fn(store.getEventFn);
    const attendeesFn = vi.fn(store.attendeesFn);
    const { outcome } = await resolve(KEY, { ...store, getEventFn, attendeesFn }, UNKNOWN);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    expect(getEventFn).toHaveBeenCalled();
    expect(attendeesFn).not.toHaveBeenCalled();
  });

  it("answers cancelled 410 before any session-gated read", async () => {
    const store = fakeStore({
      event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent,
    });
    const attendeesFn = vi.fn(store.attendeesFn);
    const viewerRsvpFn = vi.fn(store.viewerRsvpFn);
    const { outcome, seen } = await resolve(
      KEY,
      { ...store, attendeesFn, viewerRsvpFn },
      memberSession(),
    );
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(attendeesFn).not.toHaveBeenCalled();
    expect(viewerRsvpFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("keeps drafts forbidden to guests and non-moderator members", async () => {
    const draft = { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent;
    for (const session of [GUEST, memberSession()]) {
      const { outcome, seen } = await resolve(KEY, fakeStore({ event: draft }), session);
      expect(outcome.kind).toBe("forbidden");
      if (outcome.kind !== "forbidden") throw new Error("unreachable");
      expect(outcome.status).toBe(403);
      expect(seen).toHaveLength(1);
    }
  });
});

describe("event-detail guest reads", () => {
  it("renders the published contract with no attendee or viewer data", async () => {
    const store = fakeStore();
    const attendeesFn = vi.fn(store.attendeesFn);
    const viewerRsvpFn = vi.fn(store.viewerRsvpFn);
    const waitlistFn = vi.fn(store.waitlistFn);
    const { outcome, seen } = await resolve(
      KEY,
      { ...store, attendeesFn, viewerRsvpFn, waitlistFn },
      GUEST,
      "added",
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(seen).toHaveLength(1);
    const model = outcome.model;
    expect(model.eventKey).toBe(KEY);
    expect(model.title).toBe("Chess night");
    expect(model.canonical).toBe(`${APP_URL}/e/${KEY}`);
    expect(model.path).toBe(`/e/${KEY}`);
    expect(model.robots).toBeNull();
    expect(model.markdownAlternate).toBe(`/e/${KEY}.md`);
    expect(model.icsUrl).toBe(`/events/${KEY}.ics`);
    // Member-only projections never reach an anonymous model.
    expect(model.attendees).toEqual([]);
    expect(model.answer).toBeNull();
    expect(model.waitlistPosition).toBeNull();
    expect(attendeesFn).not.toHaveBeenCalled();
    expect(viewerRsvpFn).not.toHaveBeenCalled();
    expect(waitlistFn).not.toHaveBeenCalled();
    // Guest-only join pitch with this page as the return destination.
    expect(model.showJoinPitch).toBe(true);
    expect(model.joinReturnTo).toBe(`/e/${KEY}`);
    expect(model.joinResult).toBe("added");
    // Discovery + share surface.
    expect(model.related).toHaveLength(1);
    expect(model.related[0]).toMatchObject({ key: RELATED[0]!.eventKey, title: "Chess finals" });
    // Related instants use the served long-offset format, not the grid format.
    expect(model.related[0]!.whenText).toContain("GMT");
    // The sign-in return preserves the query string, as served.
    const queried = await resolve(KEY, fakeStore(), GUEST, null, "?tab=about");
    expect(queried.outcome.kind).toBe("ok");
    if (queried.outcome.kind !== "ok") throw new Error("unreachable");
    expect(queried.outcome.model.joinReturnTo).toBe(`/e/${KEY}?tab=about`);
    expect(model.neighbors.next?.key).toBe(RELATED[0]!.eventKey);
    expect(model.copyLink).toBe(`${APP_URL}/e/${KEY}`);
    expect(model.jsonLd).toContain("https://schema.org/EventScheduled");
    expect(model.siteJsonLd).toContain("Together We Own");
    // Private, cookie-varying HTML: never a public cache entry.
    expect(outcome.headers["cache-control"]).toBe("private, no-store");
    expect(outcome.headers["vary"]).toBe("Cookie");
    expect(outcome.headers["x-robots-tag"]).toBeUndefined();
  });

  it("links both neighbors through the served discovery format", async () => {
    const previous = {
      id: 6,
      eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      title: "Chess prelims",
      startsAt: new Date("2030-01-01T19:00:00Z"),
      timezone: "UTC",
      location: "The lobby",
    };
    const { outcome } = await resolve(
      KEY,
      fakeStore({ neighbors: { previous, next: NEIGHBORS.next } }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.neighbors.previous?.key).toBe(previous.eventKey);
    expect(outcome.model.neighbors.previous?.whenText).toContain("GMT");
    const lonely = await resolve(KEY, fakeStore({ neighbors: { previous: null, next: null } }));
    expect(lonely.outcome.kind).toBe("ok");
    if (lonely.outcome.kind !== "ok") throw new Error("unreachable");
    expect(lonely.outcome.model.neighbors).toEqual({ previous: null, next: null });
  });

  it("marks past rows noindex while keeping their share surface", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "past" }), goingCount: 3 } as PublicEvent }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.isPast).toBe(true);
    expect(outcome.model.robots).toBe("noindex, nofollow");
    expect(outcome.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(outcome.model.markdownAlternate).toBe(`/e/${KEY}.md`);
    expect(outcome.model.copyLink).toBe(`${APP_URL}/e/${KEY}`);
  });

  it("nulls the Google Calendar model link for non-wire years but keeps the Kit page contract", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({
        event: {
          ...row({
            startsAt: new Date("+010000-01-10T20:00:00Z"),
            endsAt: new Date("+010000-01-10T22:00:00Z"),
          }),
          goingCount: 3,
        } as PublicEvent,
      }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.googleCalendarUrl).toBeNull();
    expect(outcome.model.icsUrl).toBe(`/events/${KEY}.ics`);
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-ics"');
    expect(html).not.toContain('data-testid="event-google-calendar"');
  });

  it.each([
    ["expanded endsAt only", "2030-01-10T20:00:00Z", "+010000-01-10T22:00:00Z"],
    ["negative startsAt only", "-000001-01-10T20:00:00Z", "2030-01-10T22:00:00Z"],
  ])("omits only the Google Calendar link for %s", async (_label, startsAt, endsAt) => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({
        event: {
          ...row({ startsAt: new Date(startsAt), endsAt: new Date(endsAt) }),
          goingCount: 3,
        } as PublicEvent,
      }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.googleCalendarUrl).toBeNull();
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-ics"');
    expect(html).not.toContain('data-testid="event-google-calendar"');
  });

  it("renders a moderator draft with noindex and no Markdown alternate", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent }),
      memberSession(MOD_ID, true),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.isDraft).toBe(true);
    expect(outcome.model.robots).toBe("noindex, nofollow");
    expect(outcome.model.markdownAlternate).toBeUndefined();
  });
});

describe("event-detail member reads", () => {
  it("discloses attendees only to members, with the viewer's own answer", async () => {
    const { outcome } = await resolve(KEY, fakeStore(), memberSession());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.attendees).toEqual(ATTENDEES);
    expect(outcome.model.showJoinPitch).toBe(false);
    expect(outcome.model.answer).toEqual(ANSWER);
  });

  it("audits the disclosed attendee subjects before the bytes release", async () => {
    const writes: { subjectUserIds: string[]; viewerDiscordId: string }[] = [];
    const response = await memberReadResponse(
      { method: "GET", route: "/e/[key]" },
      () => ({ viewer: MEMBER_ID, resource: "member", action: "list", route: "events.page" }),
      async (entry) => {
        writes.push({
          subjectUserIds: [...entry.subjectUserIds],
          viewerDiscordId: entry.viewerDiscordId,
        });
        return true;
      },
      async () => {
        const { outcome } = await resolve(KEY, fakeStore(), memberSession());
        if (outcome.kind !== "ok") throw new Error("unreachable");
        return new Response(JSON.stringify(outcome.model.attendees), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.viewerDiscordId).toBe(MEMBER_ID);
    expect(writes[0]!.subjectUserIds).toEqual(["100000000000000003", "100000000000000004"]);
  });

  it("releases an anonymous render with no audit write and no subjects", async () => {
    const writes: unknown[] = [];
    const response = await memberReadResponse(
      { method: "GET", route: "/e/[key]" },
      () => ({ viewer: null, resource: "member", action: "list", route: "events.page" }),
      async (entry) => {
        writes.push(entry);
        return true;
      },
      async () => {
        const { outcome } = await resolve(KEY, fakeStore(), GUEST);
        if (outcome.kind !== "ok") throw new Error("unreachable");
        return new Response(JSON.stringify(outcome.model.attendees), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses the bytes with 503 when the audit write fails", async () => {
    const response = await memberReadResponse(
      { method: "GET", route: "/e/[key]" },
      () => ({ viewer: MEMBER_ID, resource: "member", action: "list", route: "events.page" }),
      async () => {
        throw new Error("audit store down");
      },
      async () => {
        const { outcome } = await resolve(KEY, fakeStore(), memberSession());
        if (outcome.kind !== "ok") throw new Error("unreachable");
        // The model is fully buffered before the boundary decides, exactly as
        // the served page buffers its HTML before the audit releases it.
        return new Response(JSON.stringify(outcome.model), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(response.status).toBe(503);
  });

  it("links a page far past the end back to page one, never to another empty page", async () => {
    // An empty page read two or more pages past the last real page must return
    // to the bare page-one URL: page N-1 (?attendees=9) is empty too.
    const { outcome } = await resolve(
      KEY,
      fakeStore({ attendees: [] }),
      memberSession(),
      null,
      "?attendees=10",
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.attendees).toEqual([]);
    expect(outcome.model.attendeesPaging).toEqual({
      page: 10,
      prevHref: `/e/${KEY}`,
      nextHref: null,
    });
  });
});

describe("event-detail metadata safety", () => {
  it("falls back to the served share description when the event has none", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ description: null }), goingCount: 1 } as PublicEvent }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // The fallback feeds meta/share tags only: the body keeps the raw null
    // so no About section renders, exactly as served.
    expect(outcome.model.description).toBeNull();
    expect(outcome.model.shareDescription).toBe("An event at Together We Own.");
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).not.toContain("event-description");
    expect(html).toContain('content="An event at Together We Own."');
  });

  it("escapes JSON-LD so a hostile title cannot break out of the data block", async () => {
    const hostile = '</script><script>alert("xss")</script>';
    const { outcome } = await resolve(
      KEY,
      fakeStore({
        event: { ...row({ title: hostile }), goingCount: 1 } as PublicEvent,
      }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.title).toBe(hostile);
    expect(outcome.model.jsonLd).not.toContain("</script");
    expect(outcome.model.jsonLd).not.toContain("<!--");
    // Every replacement stays a valid JSON string escape: parsing recovers
    // the original title byte-for-byte.
    expect(JSON.parse(outcome.model.jsonLd).name).toBe(hostile);
  });

  it("keeps the served no-JS RSVP contract: a plain form posting to the Hono action", async () => {
    // The mutation stays Hono-owned (card 26/43); the Kit view renders the
    // same state machine as a native form so no-JS submission works through
    // the unchanged controller. The island only enhances it.
    const { outcome } = await resolve(KEY, fakeStore(), memberSession());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.path).toBe(`/e/${KEY}`);
    expect(outcome.model.answer?.status).toBe("going");
  });
});

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// The real Kit presentation, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as the event-states
// parity bundle: #lib/* resolves through the web alias).
async function buildKitEventDetailBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
  renderGone: (model: Record<string, unknown>) => string;
  renderMissing: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-event-detail-"));
  try {
    const entry = join(scratch, "kit-event-detail-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
import Missing from ${JSON.stringify(join(worktree, "web/src/lib/EventMissing.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderGone(model) {
  const { head, body } = render(Gone, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderMissing(model) {
  const { head, body } = render(Missing, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-event-detail.mjs");
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-event-detail-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    void result;
    const { renderDetail, renderGone, renderMissing } = (await import(
      pathToFileURL(outfile).href
    )) as {
      renderDetail: (model: Record<string, unknown>) => string;
      renderGone: (model: Record<string, unknown>) => string;
      renderMissing: (model: Record<string, unknown>) => string;
    };
    return { renderDetail, renderGone, renderMissing };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function guestHtml(): Promise<string> {
  const { outcome } = await resolve(KEY, fakeStore(), GUEST);
  if (outcome.kind !== "ok") throw new Error("unreachable");
  const { renderDetail } = await buildKitEventDetailBundle();
  return renderDetail(outcome.model as unknown as Record<string, unknown>);
}

async function memberHtml(): Promise<string> {
  const { outcome } = await resolve(KEY, fakeStore(), memberSession());
  if (outcome.kind !== "ok") throw new Error("unreachable");
  const { renderDetail } = await buildKitEventDetailBundle();
  return renderDetail(outcome.model as unknown as Record<string, unknown>);
}

describe("Kit detail presentation", () => {
  it("emits one event block and one site block, byte-identical for guest and member", async () => {
    const jsonLdBlocks = (html: string) =>
      [
        ...html.matchAll(
          /<script type="application\/ld\+json" data-testid="([^"]+)">([\s\S]*?)<\/script>/g,
        ),
      ].map((m) => ({ testid: m[1], payload: JSON.parse(m[2]!) }));
    const guest = jsonLdBlocks(await guestHtml());
    expect(guest.map((b) => b.testid)).toEqual(["event-jsonld", "site-jsonld"]);
    expect(guest[0]!.payload["@type"]).toBe("Event");
    expect(guest[1]!.payload["@graph"]).toHaveLength(2);
    expect(jsonLdBlocks(await memberHtml())).toEqual(guest);
  });

  it("serves the device-timezone action hidden with an empty result region", async () => {
    // A fresh server render never shows a focusable dead button (no-JS keeps
    // the host presentation) and never carries a previous event's conversion:
    // the island unhides the action only after it binds, and fills the result
    // only on activation. Removing `hidden` or pre-filling the region must
    // fail here.
    const html = await guestHtml();
    const mount = html.slice(html.indexOf("data-event-device-timezone"));
    expect(mount).toMatch(
      /<button type="button" hidden[^>]*>\s*Show in my device timezone\s*<\/button>/,
    );
    expect(mount).toContain(
      '<p role="status" aria-live="polite" data-testid="event-device-timezone-starts-status"></p>',
    );
  });

  it("renders the guest contract: pitch, share, discovery, metadata, never attendees", async () => {
    const html = await guestHtml();
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain('data-testid="event-copy-link"');
    expect(html).toContain(`href="${APP_URL}/e/${KEY}"`);
    expect(html).toContain('data-testid="event-copy-toast"');
    expect(html).toContain('data-testid="event-pagination"');
    expect(html).toContain('data-testid="event-related"');
    expect(html).toContain('data-testid="event-jsonld"');
    expect(html).toContain('data-testid="site-jsonld"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('data-testid="event-ics"');
    expect(html).toContain('data-testid="event-venue"');
    expect(html).toContain("The lobby");
    expect(html).toContain("Chess finals");
    expect(html).toContain('class="event-related-location"');
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).not.toContain(">ann<");
    expect(html).not.toContain(">bob<");
    // Published rows carry no robots restriction.
    expect(html).not.toContain('name="robots"');
  });

  it("renders the member contract: attendees with profile links, no join pitch", async () => {
    const html = await memberHtml();
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain("Who's going (2)");
    expect(html).toContain(">ann<");
    expect(html).toContain('href="/members/100000000000000003"');
    expect(html).toContain('data-testid="event-attendees-refresh"');
    expect(html).not.toContain('data-testid="event-join-pitch"');
    // Signed-in header chrome mirrors the served sign-out form.
    expect(html).toContain('class="who">member<');
    expect(html).toContain('action="/logout"');
  });

  it("drives full and the waitlist CTA from seat occupancy, not the named count", async () => {
    // Nameless-seat regression pin: one named going row of a cap of two.
    // The label reads the attributable count while full, spots-left and the
    // CTA read occupancy — the same split the Hono page serves, so the Kit
    // page can never offer a seat the write path refuses.
    const { outcome } = await resolve(
      KEY,
      fakeStore({
        event: { ...row({ capacity: 2 }), goingCount: 1, goingOccupancy: 2 } as PublicEvent,
        answer: null,
      }),
      memberSession(),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.goingCount).toBe(1);
    expect(outcome.model.goingOccupancy).toBe(2);
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-full="true"');
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
    // The lineup spots line reads occupancy too, not the named count.
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">Full<");
  });

  it("renders draft and past states with their notices and noindex", async () => {
    const { renderDetail } = await buildKitEventDetailBundle();
    const draft = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent }),
      memberSession(MOD_ID, true),
    );
    if (draft.outcome.kind !== "ok") throw new Error("unreachable");
    const draftHtml = renderDetail(draft.outcome.model as unknown as Record<string, unknown>);
    expect(draftHtml).toContain('data-testid="event-draft"');
    expect(draftHtml).toContain('name="robots" content="noindex, nofollow"');
    expect(draftHtml).not.toContain("text/markdown");
    const past = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "past" }), goingCount: 3 } as PublicEvent }),
    );
    if (past.outcome.kind !== "ok") throw new Error("unreachable");
    const pastHtml = renderDetail(past.outcome.model as unknown as Record<string, unknown>);
    expect(pastHtml).toContain('data-testid="event-past"');
    expect(pastHtml).toContain("text/markdown");
    // A past row closes RSVP for members, exactly as the served button does.
    const pastMember = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "past" }), goingCount: 3 } as PublicEvent }),
      memberSession(),
    );
    if (pastMember.outcome.kind !== "ok") throw new Error("unreachable");
    const pastMemberHtml = renderDetail(
      pastMember.outcome.model as unknown as Record<string, unknown>,
    );
    expect(pastMemberHtml).toContain('data-testid="rsvp-closed"');
  });

  it("keeps a hostile title inside the data block on both renderers", async () => {
    const hostile = '</script><script>alert("xss")</script>';
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ title: hostile }), goingCount: 1 } as PublicEvent }),
    );
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    // Svelte escapes the title text; the JSON-LD block is pre-escaped.
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("alert(");
  });

  it.each([
    [1, KEY, `/e/${KEY}/rsvp`],
    [2, KEY, `/e/${KEY}/rsvp?attendees=2`],
    [3, "a/b%c d-é", "/e/a%2Fb%25c%20d-%C3%A9/rsvp?attendees=3"],
  ])("preserves page %i on the native RSVP action for %s", async (page, key, action) => {
    const { outcome } = await resolve(
      KEY,
      fakeStore(),
      memberSession(),
      null,
      `?attendees=${page}`,
    );
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.attendeesPaging.page).toBe(page);
    const { renderDetail } = await buildKitEventDetailBundle();
    const html = renderDetail({ ...outcome.model, eventKey: key });
    expect(html.match(/<form[^>]*action="([^"]*)"[^>]*data-rsvp-form/)?.[1]).toBe(action);
  });

  it("works without JavaScript: the RSVP state posts to the Hono controller", async () => {
    const html = await memberHtml();
    expect(html).toContain(`action="/e/${KEY}/rsvp"`);
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(html).toContain('data-testid="rsvp-withdraw"');
    // Progressive enhancement only: the islands load after the form works.
    expect(html).toContain("/islands/rsvp-button.js");
    expect(html).toContain("/islands/copy-link.js");
    expect(html).toContain("/islands/going-count.js");
  });

  it("serves the live contract this port mirrors: roles, privacy and outage", async () => {
    const PUB = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
    const PAST = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const DRAFT = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
    const SECRET = "test-session-secret-at-least-32-bytes-long";
    const byKey = new Map([
      [PUB, { ...row({ id: 7, eventKey: PUB, status: "published" }), goingCount: 2 }],
      [
        PAST,
        {
          ...row({
            id: 8,
            eventKey: PAST,
            status: "past",
            startsAt: new Date("2020-01-10T20:00:00Z"),
            endsAt: new Date("2020-01-10T22:00:00Z"),
          }),
          goingCount: 1,
        },
      ],
      [DRAFT, { ...row({ id: 9, eventKey: DRAFT, status: "draft" }), goingCount: 0 }],
    ]);
    const columns = Object.keys(getTableColumns(events)) as (keyof ReturnType<typeof row>)[];
    const toRow = (r: ReturnType<typeof row>) =>
      columns.map((key) => (r[key] instanceof Date ? (r[key] as Date).toISOString() : r[key]));
    const auditQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
      if (sql.includes("set_config(") || sql.startsWith('insert into "member_data_access_logs"')) {
        auditQueries.push({ sql, params });
        return { rows: [] };
      }
      if (sql.includes("row_number()")) return { rows: [] };
      if (sql.includes('from "rsvps"') && sql.includes("count(")) {
        return {
          rows: [
            [7, 2],
            [8, 1],
            [9, 0],
          ],
        };
      }
      if (sql.includes('"users"')) {
        return {
          rows: [
            [MEMBER_ID, "member"],
            ["100000000000000003", "ann"],
            ["100000000000000004", "bob"],
          ],
        };
      }
      if (sql.includes('from "rsvps"')) {
        if (Array.isArray(params) && params.includes("100000000000000002")) return { rows: [] };
        return { rows: [[MEMBER_ID, "going", null]] };
      }
      if (sql.includes('"event_key" =')) {
        const found = [...byKey.values()].find((r) => (params as unknown[]).includes(r.eventKey));
        return { rows: found ? [toRow(found)] : [] };
      }
      return { rows: [] };
    });
    // pg-proxy cannot open transactions. Keep the real audit recorder on the
    // local SQL fixture, including its transaction-scoped timeout setup.
    const transaction = vi.fn(async (run: (tx: Db) => Promise<unknown>) =>
      run(db as unknown as Db),
    );
    Object.assign(db, { transaction });
    const sessionStore = createMemorySessionStore();
    const honoEnv = {
      APP_URL: `${APP_URL}/`,
      SESSION_SECRET: SECRET,
      SESSION_STORE: sessionStore,
      ADMIN_DB: db as unknown as Db,
    } as unknown as Env;
    const cookieFor = async (userId: string, moderator: boolean) => {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId,
        username: userId === MEMBER_ID ? "member" : "mod",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    };
    const request = (cookie?: string, path = `/e/${PUB}`) =>
      app.request(path, cookie ? { headers: { cookie } } : {}, honoEnv);

    const guest = await request();
    expect(guest.status).toBe(200);
    const guestHtml = await guest.text();
    expect(guestHtml).toContain('data-testid="event-join-pitch"');
    expect(guestHtml).toContain('data-testid="event-copy-link"');
    expect(guestHtml).toContain('data-testid="event-jsonld"');
    expect(guestHtml).toContain('rel="canonical"');
    expect(guestHtml).not.toContain('data-testid="event-attendees"');
    expect(guestHtml).not.toContain(">ann<");
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect(guest.headers.get("vary")).toContain("Cookie");
    expect(transaction).not.toHaveBeenCalled();
    expect(auditQueries).toEqual([]);

    const member = await request(await cookieFor(MEMBER_ID, false));
    expect(member.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(auditQueries).toHaveLength(2);
    expect(auditQueries[0]!.sql).toBe(
      "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    );
    expect(auditQueries[0]!.params).toEqual(["2000ms", "2000ms"]);
    expect(auditQueries[1]!.sql).toMatch(/^insert into "member_data_access_logs"/);
    expect(auditQueries[1]!.params).toContain(JSON.stringify(ATTENDEES.map((user) => user.id)));
    const memberHtml = await member.text();
    expect(memberHtml).toContain('data-testid="event-attendees"');
    expect(memberHtml).toContain("Who&#39;s going (3)");
    expect(memberHtml).toContain(">ann<");
    expect(memberHtml).not.toContain('data-testid="event-join-pitch"');

    expect((await request(undefined, `/e/${DRAFT}`)).status).toBe(403);
    const draftMod = await request(await cookieFor("100000000000000002", true), `/e/${DRAFT}`);
    expect(draftMod.status).toBe(200);
    expect(await draftMod.text()).toContain('data-testid="event-draft"');

    const past = await request(undefined, `/e/${PAST}`);
    expect(past.status).toBe(200);
    expect(past.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await past.text()).toContain('data-testid="event-past"');
  });

  it("formats wall time in the event zone and falls back for an unknown zone", async () => {
    const zoned = await resolve(
      KEY,
      fakeStore({
        event: {
          ...row({ timezone: "America/New_York" }),
          goingCount: 1,
        } as PublicEvent,
      }),
    );
    expect(zoned.outcome.kind).toBe("ok");
    if (zoned.outcome.kind !== "ok") throw new Error("unreachable");
    expect(zoned.outcome.model.zoneLabel).toBe("America/New_York");
    expect(zoned.outcome.model.whenText).toContain("January");
    expect(zoned.outcome.model.timeDatetime).toBe("2030-01-10T20:00:00.000Z");
    const broken = await resolve(
      KEY,
      fakeStore({ event: { ...row({ timezone: "Mars/Olympus" }), goingCount: 1 } as PublicEvent }),
    );
    expect(broken.outcome.kind).toBe("ok");
    if (broken.outcome.kind !== "ok") throw new Error("unreachable");
    expect(broken.outcome.model.zoneLabel).toBe("UTC");
    expect(broken.outcome.model.whenText).toBe("2030-01-10T20:00:00.000Z");
  });
});

describe("event-detail gone presentation", () => {
  it("carries the branded gone model: alternatives, ICS entry and structured data", async () => {
    const store = fakeStore({
      event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent,
    });
    const attendeesFn = vi.fn(store.attendeesFn);
    const viewerRsvpFn = vi.fn(store.viewerRsvpFn);
    const { outcome } = await resolve(
      KEY,
      { ...store, attendeesFn, viewerRsvpFn },
      memberSession(),
    );
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    const model = outcome.model;
    expect(model.title).toBe("Chess night");
    expect(model.game).toBe("Chess");
    expect(model.eventKey).toBe(KEY);
    expect(model.icsUrl).toBe(`/events/${KEY}.ics`);
    expect(model.markdownAlternate).toBe(`/e/${KEY}.md`);
    expect(model.upcomingUrl).toBe("/events");
    expect(model.related).toHaveLength(1);
    expect(model.related[0]).toMatchObject({
      key: RELATED[0]!.eventKey,
      title: "Chess finals",
      location: "The lobby",
    });
    expect(model.related[0]!.whenText).toContain("2030");
    expect(model.jsonLd).toContain("https://schema.org/EventCancelled");
    expect(model.jsonLd).toContain("Chess night");
    expect(model.siteJsonLd).toContain("Together We Own");
    // Viewer-independent: no session-gated read runs for the static page.
    expect(attendeesFn).not.toHaveBeenCalled();
    expect(viewerRsvpFn).not.toHaveBeenCalled();
  });

  it("degrades to an empty alternatives list when the related read fails", async () => {
    const store = fakeStore({
      event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent,
    });
    const { outcome } = await resolve(KEY, {
      ...store,
      relatedFn: async () => {
        throw new Error("related down");
      },
    });
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.model.related).toEqual([]);
    expect(outcome.model.title).toBe("Chess night");
  });

  it("renders the branded cancellation, not the generic error shell", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent }),
    );
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const { renderGone } = await buildKitEventDetailBundle();
    const html = renderGone(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-cancelled"');
    expect(html).toContain('data-testid="event-cancelled-alternatives"');
    expect(html).toContain("Chess finals");
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).toContain('data-testid="event-jsonld"');
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).not.toContain('data-testid="join-result"');
  });

  it("maps the gone outcome onto the 410 branded error payload", async () => {
    const { outcome } = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent }),
    );
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const payload = eventDetailErrorPayload(outcome);
    expect(payload.status).toBe(410);
    expect(payload.body.message).toBe("This event was cancelled.");
    expect(payload.body.gone).toBe(outcome.model);
    expect(payload.body.missing).toBeUndefined();
  });
});

describe("event-detail missing presentation", () => {
  it("carries suggestion locations for the branded recovery section", async () => {
    const { outcome } = await resolve(KEY, fakeStore({ event: null }));
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.model.suggestions).toHaveLength(1);
    expect(outcome.model.suggestions[0]).toMatchObject({
      key: SUGGESTIONS[0]!.key,
      title: "Game night",
      location: "Voice channel",
    });
    expect(outcome.model.suggestions[0]!.datetime).toBe("2030-03-01T19:00:00.000Z");
  });

  it("renders the branded recovery with suggestion locations", async () => {
    const { outcome } = await resolve(KEY, fakeStore({ event: null }));
    if (outcome.kind !== "missing") throw new Error("unreachable");
    const { renderMissing } = await buildKitEventDetailBundle();
    const html = renderMissing(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="error-event-suggestions"');
    expect(html).toContain("Game night");
    expect(html).toContain("Voice channel");
  });

  it("maps the missing outcome onto the 404 branded error payload", async () => {
    const { outcome } = await resolve(KEY, fakeStore({ event: null }));
    if (outcome.kind !== "missing") throw new Error("unreachable");
    const payload = eventDetailErrorPayload(outcome);
    expect(payload.status).toBe(404);
    expect(payload.body.message).toBe("Not found");
    expect(payload.body.missing).toBe(outcome.model);
    expect(payload.body.gone).toBeUndefined();
  });
});

describe("event-detail join flash consumption", () => {
  it("deletes the cookie only on the GET that renders the banner", async () => {
    const flashed = await resolve(KEY, fakeStore(), GUEST, "added");
    if (flashed.outcome.kind !== "ok") throw new Error("unreachable");
    // The banner renders, so this GET consumes the one-shot flash.
    expect(eventDetailConsumesFlash(flashed.outcome, "GET")).toBe(true);
    // A repeat navigation no longer renders the banner: the bridge peek finds
    // no cookie, so the model carries no flash and nothing is consumed again.
    const replayed = await resolve(KEY, fakeStore(), GUEST, null);
    if (replayed.outcome.kind !== "ok") throw new Error("unreachable");
    expect(eventDetailConsumesFlash(replayed.outcome, "GET")).toBe(false);
    // Non-rendering requests never consume, even with a pending flash.
    expect(eventDetailConsumesFlash(flashed.outcome, "HEAD")).toBe(false);
    expect(eventDetailConsumesFlash(flashed.outcome, "POST")).toBe(false);
  });

  it("never consumes the flash on non-ok outcomes", async () => {
    const gone = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "cancelled" }), goingCount: 3 } as PublicEvent }),
      GUEST,
      "added",
    );
    expect(eventDetailConsumesFlash(gone.outcome, "GET")).toBe(false);
    const missing = await resolve(KEY, fakeStore({ event: null }), GUEST, "added");
    expect(eventDetailConsumesFlash(missing.outcome, "GET")).toBe(false);
    const forbidden = await resolve(
      KEY,
      fakeStore({ event: { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent }),
      GUEST,
      "added",
    );
    expect(eventDetailConsumesFlash(forbidden.outcome, "GET")).toBe(false);
  });
});

describe("event-detail read throttle", () => {
  const requestFor = (path = `/e/${KEY}`) =>
    new Request(new URL(path, APP_URL).href, {
      method: "GET",
      headers: { host: "next.example.test" },
    });
  const testEnv = { APP_URL } as unknown as Env;

  it("runs the shared public-read budget before the render", async () => {
    const order: string[] = [];
    const guard = vi.fn(async () => {
      order.push("guard");
      return null;
    });
    const render = vi.fn(async () => {
      order.push("render");
      return new Response("kit");
    });
    const res = await dispatchEventDetailRequest(requestFor(), testEnv, render, guard);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("kit");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["guard", "render"]);
  });

  it("returns the 429 with its no-store, private headers and never renders", async () => {
    const render = vi.fn(async () => new Response("kit"));
    const limited = new Response("slow down", {
      status: 429,
      headers: { "cache-control": "no-store, private" },
    });
    const guard = vi.fn(async () => limited);
    const res = await dispatchEventDetailRequest(requestFor(), testEnv, render, guard);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.text()).toBe("slow down");
    expect(render).not.toHaveBeenCalled();
  });
});
