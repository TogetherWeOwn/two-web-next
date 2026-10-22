// Acceptance contract for the Kit event-detail RSVP companion
// (GET /e/:key under Kit ownership): gate order through the shared seams,
// member-only attendee disclosure with audited subjects, subject-free
// anonymous releases, and Hono-owned JSON/ICS + RSVP mutations. The Builder
// (paired H2 card) implements the companion on this branch and never edits
// this file: every section pins the shipped Hono contract the port must keep.
// Hermetic throughout — instrumented store fakes and the framework-free
// member-read boundary, never a real database, never the network.
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { KitRequestSession } from "../src/kit-session";
import type { JoinResult } from "../src/return-journey";
import { memberReadResponse } from "../src/member-reads";
import {
  dispatchEventDetailRequest,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import { decideRoute, ROUTE_MANIFEST } from "../src/route-ownership";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const APP_URL = "https://next.example.test";
const env = { APP_URL } as unknown as Env;
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const MEMBER_ID = "100000000000000001";
const MOD_ID = "100000000000000002";
const OTHER_ID = "100000000000000003";
const GUEST_ID = "100000000000000004";

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

const ATTENDEES: EventAttendee[] = [
  { id: OTHER_ID, name: "ann" },
  { id: GUEST_ID, name: "bob" },
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
const nonMemberSession = (userId = MEMBER_ID): KitRequestSession => ({
  status: "authenticated",
  session: { userId, username: "viewer", avatar: null, member: false, moderator: false },
});

// Instrumented hermetic store: every seam records its call, so each gate test
// pins both the outcome and which reads ran before it.
function trackingStore(
  calls: string[],
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
      calls.push("dbFor");
      if (over.dbError) throw over.dbError;
      return over.db === undefined ? ({} as Db) : over.db;
    },
    getEventFn: async () => {
      calls.push("getEvent");
      if (over.eventError) throw over.eventError;
      return over.event === undefined ? event : over.event;
    },
    neighborsFn: async () => {
      calls.push("neighbors");
      return over.neighbors ?? { previous: null, next: null };
    },
    relatedFn: async () => {
      calls.push("related");
      return over.related ?? [];
    },
    attendeesFn: async () => {
      calls.push("attendees");
      return over.attendees ?? ATTENDEES;
    },
    viewerRsvpFn: async () => {
      calls.push("viewerRsvp");
      return over.answer ?? ANSWER;
    },
    waitlistFn: async () => {
      calls.push("waitlist");
      return over.waitlist ?? null;
    },
    suggestionsFn: async () => {
      calls.push("suggestions");
      return over.suggestions ?? SUGGESTIONS;
    },
  };
}

async function resolve(
  key: string,
  store: KitEventDetailStore,
  session: KitRequestSession | undefined = undefined,
  search = "",
) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key,
    search,
    path: `/e/${key}`,
    env,
    session: session ?? GUEST,
    joinResult: null,
    setHeaders: (headers) => seen.push(headers),
    store,
  });
  return { outcome, seen };
}

describe("acceptance: companion gate order through the shared seams", () => {
  it("canonical redirect runs before any read, query preserved", async () => {
    const calls: string[] = [];
    const store = trackingStore(calls);
    const { outcome, seen } = await resolve(KEY.toLowerCase(), store, GUEST, "?tab=about");
    expect(outcome).toEqual({ kind: "redirect", location: `/e/${KEY}?tab=about` });
    expect(calls).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("key admission runs before lookup: forged keys reach missing on suggestions alone", async () => {
    const calls: string[] = [];
    const { outcome } = await resolve("nope!!", trackingStore(calls));
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(outcome.model.suggestions).toHaveLength(1);
    // Admission refused before the database: only the suggestion read ran.
    expect(calls).toEqual(["suggestions"]);
  });

  it("missing rows 404 with suggestions after lookup, before any projection read", async () => {
    const calls: string[] = [];
    const { outcome } = await resolve(UNKNOWN_KEY, trackingStore(calls, { event: null }));
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(calls.indexOf("dbFor")).toBe(0);
    expect(calls.indexOf("getEvent")).toBe(1);
    expect(calls).toContain("suggestions");
    for (const projection of ["neighbors", "related", "attendees", "waitlist", "viewerRsvp"]) {
      expect(calls, projection).not.toContain(projection);
    }
  });

  it("a database outage is 503 before any event read", async () => {
    const calls: string[] = [];
    const { outcome } = await resolve(KEY, trackingStore(calls, { db: null }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    expect(outcome.headers).toEqual({ "cache-control": "private, no-store" });
    expect(calls).toEqual(["dbFor"]);
  });

  it("an indeterminate session is 503, never a guest render of member state", async () => {
    const calls: string[] = [];
    const { outcome } = await resolve(KEY, trackingStore(calls), UNKNOWN);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    for (const projection of ["neighbors", "related", "attendees", "waitlist", "viewerRsvp"]) {
      expect(calls, projection).not.toContain(projection);
    }
  });

  it("cancelled 410 runs before any session-gated read, even on an outage session", async () => {
    const calls: string[] = [];
    const cancelled = { ...row({ status: "cancelled" }), goingCount: 0 } as PublicEvent;
    const { outcome } = await resolve(KEY, trackingStore(calls, { event: cancelled }), UNKNOWN);
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    // The static cancellation renders without the session: none of the
    // session-gated projections ran, so a rotated cookie or store outage can
    // never turn it into a 500.
    for (const gated of ["attendees", "waitlist", "viewerRsvp"]) {
      expect(calls, gated).not.toContain(gated);
    }
  });

  it("draft without the moderator bit is forbidden before any projection read", async () => {
    const calls: string[] = [];
    const draft = { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent;
    const { outcome } = await resolve(KEY, trackingStore(calls, { event: draft }), GUEST);
    expect(outcome.kind).toBe("forbidden");
    if (outcome.kind !== "forbidden") throw new Error("unreachable");
    expect(outcome.status).toBe(403);
    expect(calls).toEqual(["dbFor", "getEvent"]);
  });

  it("draft on an indeterminate session is an outage, not a logout or a leak", async () => {
    const calls: string[] = [];
    const draft = { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent;
    const { outcome } = await resolve(KEY, trackingStore(calls, { event: draft }), UNKNOWN);
    expect(outcome.kind).toBe("unavailable");
  });

  it("published member reads 200 through every shared seam, suggestions never run", async () => {
    const calls: string[] = [];
    const { outcome, seen } = await resolve(KEY, trackingStore(calls), memberSession());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.status).toBe(200);
    expect(outcome.headers).toMatchObject({ "cache-control": "private, no-store", vary: "Cookie" });
    expect(seen).toHaveLength(1);
    // Lookup order is pinned; the five projections all run after it.
    expect(calls.indexOf("dbFor")).toBe(0);
    expect(calls.indexOf("getEvent")).toBe(1);
    for (const projection of ["neighbors", "related", "attendees", "waitlist", "viewerRsvp"]) {
      expect(calls.indexOf(projection)).toBeGreaterThan(calls.indexOf("getEvent"));
    }
    expect(calls).not.toContain("suggestions");
    expect(outcome.model.attendees).toEqual(ATTENDEES);
    expect(outcome.model.answer).toEqual(ANSWER);
    expect(outcome.model.robots).toBeNull();
  });

  it("past member reads 200 with the served noindex robots", async () => {
    const calls: string[] = [];
    const past = { ...row({ status: "past" }), goingCount: 5 } as PublicEvent;
    const { outcome } = await resolve(KEY, trackingStore(calls, { event: past }), memberSession());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.status).toBe(200);
    expect(outcome.model.isPast).toBe(true);
    expect(outcome.model.robots).toBe("noindex, nofollow");
    expect(outcome.headers).toMatchObject({ "x-robots-tag": "noindex, nofollow" });
  });

  it("moderator draft reads 200 where guests are forbidden", async () => {
    const draft = { ...row({ status: "draft" }), goingCount: 0 } as PublicEvent;
    const mod = await resolve(
      KEY,
      trackingStore([], { event: draft }),
      memberSession(MOD_ID, true),
    );
    expect(mod.outcome.kind).toBe("ok");
    if (mod.outcome.kind !== "ok") throw new Error("unreachable");
    expect(mod.outcome.model.isDraft).toBe(true);
  });
});

describe("acceptance: disclosure and audit subjects match the Hono declarations", () => {
  const DECLARATION = { resource: "member", action: "list", route: "events.page" } as const;

  it("the shipped manifest entry carries the Hono handler's declaration, disabled", () => {
    // The served GET /e/:key handler observes the whole render inside
    // memberReadBoundary with exactly this declaration
    // (src/events/routes-detail.tsx): the Kit hook must audit the same triple.
    expect(read("src/events/routes-detail.tsx")).toContain(
      'resource: "member", action: "list", route: "events.page"',
    );
    const entry = ROUTE_MANIFEST.find((r) => r.method === "GET" && r.path === "/e/:key");
    expect(entry).toEqual({ method: "GET", path: "/e/:key", enabled: false, reads: DECLARATION });
  });

  // Resolve inside the framework-free boundary the hook renders in, so the
  // recorded audit entries are the companion's real declared subjects.
  async function releaseAs(
    viewer: string | null,
    session: KitRequestSession,
    store: KitEventDetailStore,
  ) {
    const entries: AccessEntry[] = [];
    const response = await memberReadResponse(
      { method: "GET", route: "events.page" },
      () => ({ ...DECLARATION, viewer }),
      async (entry) => {
        entries.push(entry);
        return true;
      },
      async () => {
        const outcome = await resolveKitEventDetail({
          key: KEY,
          search: "",
          path: `/e/${KEY}`,
          env,
          session,
          joinResult: null,
          setHeaders: () => {},
          store,
        });
        expect(outcome.kind).toBe("ok");
        return new Response(JSON.stringify({ kind: outcome.kind }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    return { response, entries };
  }

  it("member release audits exactly the disclosed attendee owners", async () => {
    const calls: string[] = [];
    const { response, entries } = await releaseAs(MEMBER_ID, memberSession(), trackingStore(calls));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(entries).toEqual([
      {
        viewerDiscordId: MEMBER_ID,
        viewerUserId: MEMBER_ID,
        resource: "member",
        action: "list",
        route: "events.page",
        subjectUserIds: [OTHER_ID, GUEST_ID].sort(),
      },
    ]);
  });

  it("the caller's own key never becomes a subject, even when attending", async () => {
    const own: EventAttendee[] = [
      { id: MEMBER_ID, name: "me" },
      { id: OTHER_ID, name: "ann" },
    ];
    const { response, entries } = await releaseAs(
      MEMBER_ID,
      memberSession(),
      trackingStore([], { attendees: own }),
    );
    expect(response.status).toBe(200);
    // The own-RSVP read keys on the session user; the boundary filters the
    // viewer out, so only the other disclosed owner is audited.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subjectUserIds).toEqual([OTHER_ID]);
    expect(entries[0]?.subjectUserIds).not.toContain(MEMBER_ID);
  });

  it("anonymous viewers disclose nothing, run no member projection, and release with no audit row", async () => {
    const calls: string[] = [];
    const store = trackingStore(calls);
    const attendeesFn = vi.fn(store.attendeesFn);
    const viewerRsvpFn = vi.fn(store.viewerRsvpFn);
    const { response, entries } = await releaseAs(null, GUEST, {
      ...store,
      attendeesFn,
      viewerRsvpFn,
    });
    expect(response.status).toBe(200);
    // Member-only projections never run for anonymous viewers, so the capture
    // holds no subjects and the boundary releases with no audit row — exactly
    // as the served handler resolves [] without reading.
    expect(attendeesFn).not.toHaveBeenCalled();
    expect(viewerRsvpFn).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it("signed-in non-members see no attendees and no own answer, with no audit row", async () => {
    const calls: string[] = [];
    const store = trackingStore(calls);
    const attendeesFn = vi.fn(store.attendeesFn);
    const viewerRsvpFn = vi.fn(store.viewerRsvpFn);
    const { response, entries } = await releaseAs(MEMBER_ID, nonMemberSession(), {
      ...store,
      attendeesFn,
      viewerRsvpFn,
    });
    expect(response.status).toBe(200);
    expect(attendeesFn).not.toHaveBeenCalled();
    expect(viewerRsvpFn).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });
});

describe("acceptance: JSON/ICS have no Kit entries and RSVP mutations stay Hono-owned", () => {
  it("the shipped manifest carries no JSON, feed, or mutation entry", () => {
    const suspect = ROUTE_MANIFEST.filter((entry) => /ics|json|rss|rsvp|__data/i.test(entry.path));
    expect(suspect).toEqual([]);
    // The only event :key entries are the disabled admin edit page and the
    // disabled detail page itself: nothing JSON/feed/mutation-shaped.
    expect(
      ROUTE_MANIFEST.filter((entry) => entry.path.includes(":key")).map((entry) => entry.path),
    ).toEqual(["/admin/events/:key", "/e/:key"]);
  });

  it.each([
    ["GET", "/events.json"],
    ["GET", "/events.rss"],
    ["GET", `/events/${KEY}`],
    ["GET", `/events/${KEY}.ics`],
    ["POST", `/e/${KEY}/rsvp`],
    ["PUT", `/events/${KEY}/rsvp`],
    ["DELETE", `/events/${KEY}/rsvp`],
  ])("%s %s decides away from Kit: Hono answers", (method, path) => {
    expect(
      decideRoute(new Request(new URL(path, APP_URL).href, { method }), ROUTE_MANIFEST),
    ).toBeUndefined();
  });

  it("the Hono RSVP controller keeps the only mutation authority", () => {
    const rsvp = read("src/events/routes-rsvp.tsx");
    expect(rsvp).toContain('app.put("/events/:key/rsvp"');
    expect(rsvp).toContain('app.delete("/events/:key/rsvp"');
    expect(rsvp).toContain('app.post("/e/:key/rsvp"');
    // The Kit view renders the same state machine as a native form posting to
    // the Hono controller: no client-side mutation, no fetch, same endpoint.
    const detail = read("web/src/lib/EventDetail.svelte");
    expect(detail).toContain('<form method="post" action={rsvpAction}');
    expect(detail).toContain("`/e/${encodeURIComponent(model.eventKey)}/rsvp`");
    expect(detail).not.toMatch(/fetch\s*\(/);
  });

  it("the Kit load binds the shared seams and ships no hydration bundle", () => {
    const load = read("web/src/routes/e/[key]/+page.server.ts");
    expect(load).toContain("resolveKitEventDetail({");
    expect(load).toContain("kitEventDetailStore(env)");
    expect(load).toMatch(/^export const csr = false;/m);
  });

  it("the throttle-first dispatch answers limited clients without rendering", async () => {
    const render = vi.fn(async () => new Response("kit"));
    const limited = new Response("limited", { status: 429 });
    const request = new Request(new URL(`/e/${KEY}`, APP_URL).href);
    const answered = await dispatchEventDetailRequest(request, env, render, async () => limited);
    expect(answered).toBe(limited);
    expect(render).not.toHaveBeenCalled();
    const passed = await dispatchEventDetailRequest(request, env, render, async () => null);
    expect(render).toHaveBeenCalledTimes(1);
    expect(await passed.text()).toBe("kit");
  });
});
