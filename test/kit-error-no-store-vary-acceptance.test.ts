// route-inventory: GET /e/:key
// route-inventory: GET /events/:key
// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// route-inventory: GET /leaderboards/members
// route-inventory: GET /events/past
// route-inventory: GET /login
// route-inventory: GET /auth/discord/redirect
//
// Acceptance matrix: every Kit error outcome carries explicit no-store like
// its Hono twin, and every public/Vary tuple matches — no heuristic-cached
// 404s. Failing-first contract for the F8 cache-posture build.
//
// THIS FILE IS THE SPECIFICATION. Owned by the acceptance card; the Builder
// builds on this branch and must never edit this file. Corrections return to
// the acceptance card.
//
// RED legs (fail on current code) prove the gaps; GREEN legs pin the behavior
// the build must not change (positive controls, TTL invariance, 301
// exclusions, out-of-scope locks). The build is done when every leg passes.
//
// Equality semantics: Kit helpers emit `private, no-store` (private-first)
// while most Hono twins emit `no-store, private` (order differs by layer).
// Equality means the same directive SET, asserted by expectSameDirectives;
// exact per-side strings are pinned alongside so neither layer drifts.
//
// Source cites re-verified at eabe55b4 (HEAD has moved since e0c94ff6):
// - src/kit-event-states.ts:197-200 draft 403 -> setHeaders({}); :214-216
//   missing 404 carries only x-robots-tag. HOLDS.
// - src/kit-hotzones.ts:67-84 branded 400/404 throws bypass setHeaders;
//   branded 503 passthrough rethrows without headers; unbranded 503 already
//   sets private, no-store (:82). HOLDS.
// - web/src/routes/leaderboards/members/+page.server.ts:88-94 branded
//   403/400/503 -> error() bare; only the 302 arm (:85) sets no-store. HOLDS.
// - src/route-ownership.ts:563-583 decorateKitResponse never sets
//   cache-control. HOLDS (locked here; restructuring is out of scope).
// - Kit hotzones success sets public, max-age=300 with no Vary (:137,172,191)
//   while all three Hono twins set vary: Cookie
//   (src/hotzones/routes.tsx:47,89,117). HOLDS.
// - Past archive lacks Vary on both sides (Kit src/kit-past-events.ts:204-207;
//   Hono src/events/routes-calendar.tsx:243). HOLDS.
// - /login (src/static-leaves.tsx:36) and /auth/discord/redirect
//   (src/auth/routes.ts:90) use bare `no-store` where siblings use
//   `no-store, private`. HOLDS (line numbers drifted since e0c94ff6; the
//   roadmap cited static-leaves 44-45 and auth/routes 92 — content unchanged).
// - DRIFT (same bug, live resolver): src/events/kit-detail.ts — the resolver
//   the /e/:key binding actually calls — duplicates the event-states gaps at
//   :405-408 (draft 403 -> {}) and :552-553 (missing 404 robots-only). Pinned
//   in this matrix alongside kit-event-states; leaving the served route
//   heuristic-cacheable would defeat the card.
// - PR #1475 (Kit error correlation, same files) is still OPEN: no rebase was
//   due; the Builder re-verifies legs at implementation HEAD.
//
// Hermetic: synthetic Hono apps, framework-free helpers with injected fakes,
// fixture secrets. No database, no network, no OAuth, no route-enablement
// change. dbFor fakes that must never run throw, proving gate/grammar order.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import leafApp from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { MAX_QUERY_LENGTH } from "../src/events/search-log";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { registerCalendarRoutes } from "../src/events/routes-calendar";
import { registerDetailRoutes } from "../src/events/routes-detail";
import type { SessionReader } from "../src/events/routes-shared";
import type { EventAttendee, EventLink, EventNeighbors, PublicEvent } from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import { databaseUnavailable, forbidden, gone, notFoundResponse } from "../src/error-responses";
import { registerHotzoneRoutes } from "../src/hotzones/routes";
import { loadPastArchivePage } from "../src/kit-past-events";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import { loadMembersBoardData } from "../src/kit-members";
import { bufferedMemberHtml, memberReadBoundary } from "../src/member-reads";
import { memberGate } from "../src/profiles/routes-gate";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, newSessionToken, type SessionStore } from "../src/sessions";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "100000000000000001";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const NO_STORE = "private, no-store";
const NOINDEX = "noindex, nofollow";

const env = { APP_URL } as unknown as Env;
const gateEnv = { APP_URL, SESSION_SECRET: SECRET } as unknown as Env;

// --- directive-set helpers -------------------------------------------------
// Kit and Hono spell the same posture in different directive orders; compare
// sets, and pin each side's exact string where the order is contractual.

function directivesOf(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "")
    .sort();
}

function expectNoStore(value: string | null | undefined): void {
  const directives = directivesOf(value);
  expect(directives).toContain("no-store");
  expect(directives).toContain("private");
}

function expectSameDirectives(a: string | null | undefined, b: string | null | undefined): void {
  expect(directivesOf(a)).toEqual(directivesOf(b));
}

function branded(status: number, message = "branded"): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

// --- shared event fakes ----------------------------------------------------

function eventRow(status: string): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status,
    rsvpOpen: true,
    goingCount: 3,
    goingOccupancy: 3,
  } as unknown as PublicEvent;
}

const RELATED: EventLink[] = [
  {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
  },
];

const NEIGHBORS: EventNeighbors = { previous: null, next: RELATED[0]! };

const SUGGESTIONS: SuggestedEvent[] = [
  {
    key: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Game night",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    location: "Voice channel",
  },
];

const noRead: () => Promise<never> = async () => {
  throw new Error("must not read on this leg");
};

function eventStateStore(over: Partial<{ event: PublicEvent | null }> = {}): EventStateStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (over.event === undefined ? eventRow("cancelled") : over.event),
    relatedFn: async () => RELATED,
    suggestionsFn: async () => SUGGESTIONS,
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };

function detailStore(over: Partial<{ event: PublicEvent | null }> = {}): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (over.event === undefined ? eventRow("published") : over.event),
    neighborsFn: async () => NEIGHBORS,
    relatedFn: async () => RELATED,
    attendeesFn: async (): Promise<EventAttendee[]> => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => SUGGESTIONS,
  };
}

const memberBoardSession = (member: boolean) => ({
  status: "authenticated" as const,
  userId: MEMBER_ID,
  username: "member",
  member,
});

const dummyReader = (async () => null) as unknown as SessionReader;

// Redirect leaves run through the full app (the auth module imports the app
// root, so it cannot be mounted standalone). Database bindings refuse: the
// leaves stay 302 when everything behind them is down.
function leafEnv() {
  const refuse = (): never => {
    throw new Error("redirect must not read a database binding");
  };
  return {
    APP_URL,
    SESSION_SECRET: SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: createMemorySessionStore(),
    get DB() {
      return refuse();
    },
    get DATABASE_URL() {
      return refuse();
    },
    get ADMIN_DB() {
      return refuse();
    },
  } as unknown as Env;
}

// --- 1. Kit event-states outcomes -------------------------------------------

describe("Kit event-states header contract", () => {
  it("RED: draft 403 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: eventRow("draft") }),
    });

    expect(outcome).toMatchObject({ kind: "forbidden", status: 403 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: missing 404 emits private, no-store and keeps its robots tag", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: null }),
    });

    expect(outcome).toMatchObject({ kind: "missing", status: 404 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
    expect(seen[0]!["x-robots-tag"]).toBe(NOINDEX);
  });

  it("GREEN: cancelled 410 keeps private, no-store plus its robots tag", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: eventRow("cancelled") }),
    });

    expect(outcome).toMatchObject({ kind: "gone", status: 410 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
    expect(seen[0]!["x-robots-tag"]).toBe(NOINDEX);
  });

  it("GREEN: canonical redirect stays cacheable — 301s are excluded from no-store", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveEventState({
      key: KEY.toLowerCase(),
      search: "?attendees=2",
      path: `/e/${KEY.toLowerCase()}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: {
        ...eventStateStore(),
        dbForFn: noRead as () => Promise<Db | null>,
      },
    });

    expect(outcome).toMatchObject({ kind: "redirect", location: `/e/${KEY}?attendees=2` });
    expect(seen).toHaveLength(1);
    expect(seen[0]!).not.toHaveProperty("cache-control");
  });
});

// --- 2. Kit live detail outcomes (the resolver the binding calls) -----------

describe("Kit live detail header contract", () => {
  it("RED: draft 403 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveKitEventDetail({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      session: GUEST,
      joinResult: null,
      setHeaders: (headers) => seen.push(headers),
      store: detailStore({ event: eventRow("draft") }),
    });

    expect(outcome).toMatchObject({ kind: "forbidden", status: 403 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: missing 404 emits private, no-store and keeps its robots tag", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveKitEventDetail({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      session: GUEST,
      joinResult: null,
      setHeaders: (headers) => seen.push(headers),
      store: detailStore({ event: null }),
    });

    expect(outcome).toMatchObject({ kind: "missing", status: 404 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
    expect(seen[0]!["x-robots-tag"]).toBe(NOINDEX);
  });

  it("GREEN: cancelled 410 keeps private, no-store plus its robots tag", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveKitEventDetail({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      session: GUEST,
      joinResult: null,
      setHeaders: (headers) => seen.push(headers),
      store: detailStore({ event: eventRow("cancelled") }),
    });

    expect(outcome).toMatchObject({ kind: "gone", status: 410 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
    expect(seen[0]!["x-robots-tag"]).toBe(NOINDEX);
  });

  it("GREEN: canonical redirect stays cacheable — 301s are excluded from no-store", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveKitEventDetail({
      key: KEY.toLowerCase(),
      search: "",
      path: `/e/${KEY.toLowerCase()}`,
      env,
      session: GUEST,
      joinResult: null,
      setHeaders: (headers) => seen.push(headers),
      store: { ...detailStore(), dbForFn: noRead as () => Promise<Db | null> },
    });

    expect(outcome).toMatchObject({ kind: "redirect", location: `/e/${KEY}` });
    expect(seen).toHaveLength(1);
    expect(seen[0]!).not.toHaveProperty("cache-control");
  });

  it("GREEN: served 200 keeps private, no-store with Vary: Cookie", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await resolveKitEventDetail({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      session: GUEST,
      joinResult: null,
      setHeaders: (headers) => seen.push(headers),
      store: detailStore({ event: eventRow("published") }),
    });

    expect(outcome).toMatchObject({ kind: "ok", status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
    expect(seen[0]!.vary).toBe("Cookie");
  });
});

// --- 3. Kit hotzones error outcomes ------------------------------------------

describe("Kit hotzones error headers", () => {
  it("RED: index answers bad-season 400 with private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: "not-a-season",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: signal answers bad-season 400 with private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: "not-a-season",
        signalParam: "joins",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: signal answers unknown-signal 404 with private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "nope",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: index maps a branded 503 read failure with private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadJoinsGridFn: async () => {
          throw branded(503, "downstream outage");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: joins signal maps a branded 503 read failure with private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "joins",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadJoinsGridFn: async () => {
          throw branded(503, "downstream outage");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: index keeps private, no-store on an unbranded 503 read failure", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadJoinsGridFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: joins signal keeps private, no-store on an unbranded 503 read failure", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "joins",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadJoinsGridFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });
});

// --- 4. Kit hotzones success Vary --------------------------------------------

describe("Kit hotzones success Vary", () => {
  const grid = () => ({ cells: [], total: 0, eventCount: 0 }) as never;

  it("RED: index serves public TTL with Vary: Cookie", async () => {
    const seen: Record<string, string>[] = [];
    await loadHotzonesIndexData({
      env,
      seasonParam: null,
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => null,
      loadJoinsGridFn: async () => grid(),
      recordBoardViewFn: async () => {},
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe("public, max-age=300");
    expect(seen[0]!.vary).toBe("Cookie");
  });

  it("RED: joins signal serves public TTL with Vary: Cookie", async () => {
    const seen: Record<string, string>[] = [];
    await loadHotzoneSignalData({
      env,
      seasonParam: null,
      signalParam: "joins",
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => null,
      loadJoinsGridFn: async () => grid(),
      recordBoardViewFn: async () => {},
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe("public, max-age=300");
    expect(seen[0]!.vary).toBe("Cookie");
  });

  it("RED: prior signal serves public TTL with Vary: Cookie", async () => {
    const seen: Record<string, string>[] = [];
    await loadHotzoneSignalData({
      env,
      seasonParam: null,
      signalParam: "voice",
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => null,
      recordBoardViewFn: async () => {},
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe("public, max-age=300");
    expect(seen[0]!.vary).toBe("Cookie");
  });
});

// --- 5. Kit member-board outcomes ---------------------------------------------

describe("Kit member-board headers", () => {
  it("RED: non-member 403 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(false),
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: bad-season 400 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: "bogus",
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: bad-scope 400 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: null,
        scopeParam: "bogus",
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: bad-activity 400 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: null,
        scopeParam: null,
        activityParam: "x".repeat(101),
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: unreadable-session 503 emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: { status: "unknown", userId: null, member: false },
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: branded 503 ranking failure emits private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadRankingFn: async () => {
          throw branded(503, "downstream outage");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: unbranded 503 ranking failure keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => ({}) as Db,
        loadRankingFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: guest 302 sets no helper headers — the binding owns the bounce", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: { status: "guest", userId: null, member: false },
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 302 });
    expect(seen).toHaveLength(0);
  });

  it("GREEN: served board keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    const board = await loadMembersBoardData({
      env,
      session: memberBoardSession(true),
      seasonParam: null,
      scopeParam: null,
      activityParam: null,
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => ({}) as Db,
      loadRankingFn: async () => [],
      queueBoardViewFn: () => {},
    });

    expect(board.rows).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });
});

// --- 6. Kit past-archive outcomes ---------------------------------------------

describe("Kit past-archive headers", () => {
  const fakeDb = {} as Db;
  const rows = () => ({ rows: [{ id: 1 }], hasMore: false, totalPages: 1 });

  it("GREEN: missing database 503 keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadPastArchivePage({
        env,
        pageParam: null,
        queryParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => null,
        listPastFn: async () => rows(),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: throwing database 503 keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadPastArchivePage({
        env,
        pageParam: null,
        queryParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        listPastFn: async () => rows(),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: throwing list 503 keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadPastArchivePage({
        env,
        pageParam: null,
        queryParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: async () => fakeDb,
        listPastFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: overlong query 422 keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadPastArchivePage({
        env,
        pageParam: null,
        queryParam: "q".repeat(MAX_QUERY_LENGTH + 1),
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
        listPastFn: async () => rows(),
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("GREEN: searching render keeps private, no-store", async () => {
    const seen: Record<string, string>[] = [];
    await loadPastArchivePage({
      env,
      pageParam: null,
      queryParam: "chess",
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => fakeDb,
      listPastFn: async () => rows(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe(NO_STORE);
  });

  it("RED: browsing render serves public TTL with Vary: Cookie", async () => {
    const seen: Record<string, string>[] = [];
    await loadPastArchivePage({
      env,
      pageParam: null,
      queryParam: null,
      setHeaders: (headers) => seen.push(headers),
      dbForFn: async () => fakeDb,
      listPastFn: async () => rows(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!["cache-control"]).toBe("public, max-age=300");
    expect(seen[0]!["x-two-past-cacheable"]).toBe("true");
    expect(seen[0]!.vary).toBe("Cookie");
  });
});

// --- 7. Hono hotzones twins --------------------------------------------------

describe("Hono hotzones twins", () => {
  const hotzones = new Hono<{ Bindings: Env }>();
  registerHotzoneRoutes(hotzones);

  it.each(["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"])(
    "GREEN: %s serves public TTL with Vary: Cookie",
    async (path) => {
      const response = await hotzones.request(path, {}, env);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(response.headers.get("vary")).toBe("Cookie");
    },
  );
});

// --- 8. Hono event/error-envelope twins ---------------------------------------

describe("Hono error-envelope twins", () => {
  it("GREEN: app 404 carries no-store, private", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/twin-404", (c) => notFoundResponse(c, []));

    const response = await app.request("/twin-404", {}, env);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("GREEN: branded 403 carries no-store, private with Vary: Accept", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/twin-403", (c) => forbidden(c));

    const response = await app.request("/twin-403", {}, env);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("GREEN: branded 410 carries private, no-store", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/twin-410", (c) => gone(c));

    const response = await app.request("/twin-410", {}, env);

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("GREEN: outage 503 carries no-store, private", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/twin-503", (c) => databaseUnavailable(c));

    const response = await app.request("/twin-503", {}, env);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("GREEN: member gate refuses a non-member 403 with no-store", async () => {
    const fakeStore = {
      get: async () => ({ userId: MEMBER_ID, username: "member", member: false, moderator: false }),
    } as unknown as SessionStore;
    const app = new Hono<{ Bindings: Env }>();
    app.use(memberGate({ sessionStore: fakeStore }));
    app.get("/members/board", (c) => c.text("unreached"));

    const pair = (
      await serializeSigned(SESSION_COOKIE, newSessionToken(), SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const response = await app.request("/members/board", { headers: { cookie: pair } }, gateEnv);

    expect(response.status).toBe(403);
    expectNoStore(response.headers.get("cache-control"));
  });

  it("GREEN: member-read boundary stamps a buffered 400 private, no-store", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use(async (c, next) =>
      memberReadBoundary(
        c,
        {
          viewer: MEMBER_ID,
          resource: "leaderboard",
          action: "list",
          route: "leaderboards.members",
        },
        async () => {
          throw new Error("no audit write on this leg");
        },
        next,
      ),
    );
    app.get("/board", (c) => bufferedMemberHtml(c, "<p>Unknown season</p>", 400));

    const response = await app.request("/board", {}, env);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("GREEN: Hono /e/:key HTML 301 keeps its boundary headers — redirect behavior is out of scope", async () => {
    const app = new Hono<{ Bindings: Env }>();
    registerDetailRoutes(app, dummyReader, dummyReader);

    const response = await app.request(`/e/${KEY.toLowerCase()}`, {}, env);

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/e/${KEY}`);
    // The member-read boundary stamps every response it releases, 301s
    // included. The build must not touch redirect behavior.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("GREEN: Hono JSON canonical 301 stays cacheable — 301s are excluded from no-store", async () => {
    const app = new Hono<{ Bindings: Env }>();
    registerDetailRoutes(app, dummyReader, dummyReader);

    const response = await app.request(`/events/${KEY.toLowerCase()}`, {}, env);

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/events/${KEY}`);
    expect(response.headers.get("cache-control") ?? "").not.toContain("no-store");
  });
});

// --- 9. Hono past-archive twins ------------------------------------------------

describe("Hono past-archive twins", () => {
  it("GREEN: overlong query 422 carries no-store, private", async () => {
    const app = new Hono<{ Bindings: Env }>();
    registerCalendarRoutes(app, dummyReader, dummyReader);

    const response = await app.request(
      `/events/past?q=${encodeURIComponent("q".repeat(MAX_QUERY_LENGTH + 1))}`,
      {},
      env,
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  // Executed route legs on a pg-proxy fake behind the ADMIN_DB seam: no
  // database. An empty archive still takes the fresh-render arm that sets
  // cache-control, so it distinguishes the guard from its inversion or an
  // unconditional set.
  const pastApp = (): Hono<{ Bindings: Env }> => {
    const app = new Hono<{ Bindings: Env }>();
    registerCalendarRoutes(app, dummyReader, dummyReader);
    return app;
  };
  const pastEnv = {
    APP_URL,
    ADMIN_DB: drizzle(async () => ({ rows: [] })) as unknown as Db,
  } as unknown as Env;

  it("RED: browsing render is public and varies on Cookie", async () => {
    const response = await pastApp().request("/events/past", {}, pastEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it("GREEN: searching render stays private no-store with no Vary", async () => {
    const response = await pastApp().request("/events/past?q=chess", {}, pastEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBeNull();
  });
});

// --- 10. Redirect leaves -------------------------------------------------------

describe("redirect leaves", () => {
  it("RED: /login emits no-store, private", async () => {
    const response = await leafApp.request("/login?next=/events", {}, leafEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/auth\/discord/);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("RED: /auth/discord/redirect emits no-store, private", async () => {
    const response = await leafApp.request("/auth/discord/redirect?next=/events", {}, leafEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/auth\/discord/);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("GREEN: /discord keeps no-store, private", async () => {
    const response = await leafApp.request("/discord", {}, leafEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("GREEN: /community keeps no-store, private", async () => {
    const response = await leafApp.request("/community", {}, leafEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});

// --- 11. Binding and dispatch locks --------------------------------------------

describe("binding and dispatch locks", () => {
  it("GREEN: leaderboards 302 arm keeps its no-store plus Vary: Cookie", () => {
    const binding = read("web/src/routes/leaderboards/members/+page.server.ts");

    expect(binding).toContain(
      'setHeaders({ "cache-control": "no-store, private", vary: "Cookie" })',
    );
  });

  it.each([
    ["season grammar", /if \(!parseSeasonParam\(.*\)\) \{[\s\S]*?error\(\d+, "[^"]*"\);/],
    ["signal vocabulary", /if \(!SIGNALS\.includes\(.*\)\) \{[\s\S]*?error\(\d+, "[^"]*"\);/],
  ])("RED: hotzone signal binding %s pre-check arm sets its own no-store", (_name, arm) => {
    // Each pre-check arm bypasses the helper, so it must carry its own
    // setHeaders: scope to the arm's block, not a window before the anchor.
    const binding = read("web/src/routes/hotzones/[signal]/+page.server.ts");
    const block = binding.match(arm)?.[0] ?? "";

    expect(block).toMatch(/setHeaders\(\{\s*"cache-control":\s*"private, no-store"\s*\}\)/);
    expect(block).toMatch(/error\(40[04],/);
  });

  it("GREEN: decorateKitResponse still sets no cache-control — helpers own the headers", () => {
    const ownership = read("src/route-ownership.ts");
    const decoration = ownership.slice(
      ownership.indexOf("function decorateKitResponse("),
      ownership.indexOf("// Same-origin parity"),
    );

    expect(decoration).not.toContain("cache-control");
  });
});

// --- 12. Kit/Hono directive-set equality ----------------------------------------

describe("Kit/Hono no-store equality", () => {
  async function honoHeader(
    mount: (app: Hono<{ Bindings: Env }>) => void,
    path: string,
  ): Promise<string | null> {
    const app = new Hono<{ Bindings: Env }>();
    mount(app);
    return (await app.request(path, {}, env)).headers.get("cache-control");
  }

  it("RED: event-states 403 equals the Hono 403 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: eventRow("draft") }),
    });
    const hono = await honoHeader((app) => app.get("/t", (c) => forbidden(c)), "/t");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("RED: event-states 404 equals the Hono 404 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: null }),
    });
    const hono = await honoHeader((app) => app.get("/t", (c) => notFoundResponse(c, [])), "/t");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("RED: hotzones 400 equals the Hono bad-season directive set", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: "bogus",
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const app = new Hono<{ Bindings: Env }>();
    registerHotzoneRoutes(app);
    const hono = (await app.request("/hotzones?season=bogus", {}, env)).headers.get(
      "cache-control",
    );

    expect(hono).toBe("no-store, private");
    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("RED: member-board 403 equals the Hono 403 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(false),
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const hono = await honoHeader((app) => app.get("/t", (c) => forbidden(c)), "/t");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("RED: member-board 400 equals the Hono boundary-400 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: memberBoardSession(true),
        seasonParam: "bogus",
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const app = new Hono<{ Bindings: Env }>();
    app.use(async (c, next) =>
      memberReadBoundary(
        c,
        {
          viewer: MEMBER_ID,
          resource: "leaderboard",
          action: "list",
          route: "leaderboards.members",
        },
        async () => true,
        next,
      ),
    );
    app.get("/board", (c) => bufferedMemberHtml(c, "<p>Unknown season</p>", 400));
    const hono = (await app.request("/board", {}, env)).headers.get("cache-control");

    expect(hono).toBe("private, no-store");
    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("RED: member-board unreadable-session 503 equals the Hono 503 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadMembersBoardData({
        env,
        session: { status: "unknown", userId: null, member: false },
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const hono = await honoHeader((app) => app.get("/t", (c) => databaseUnavailable(c)), "/t");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("GREEN: past 422 already equals the Hono 422 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await expect(
      loadPastArchivePage({
        env,
        pageParam: null,
        queryParam: "q".repeat(MAX_QUERY_LENGTH + 1),
        setHeaders: (headers) => seen.push(headers),
        dbForFn: noRead as () => Promise<Db | null>,
        listPastFn: async () => ({ rows: [], hasMore: false, totalPages: 0 }),
      }),
    ).rejects.toMatchObject({ status: 422 });
    const app = new Hono<{ Bindings: Env }>();
    registerCalendarRoutes(app, dummyReader, dummyReader);
    const hono = (
      await app.request(
        `/events/past?q=${encodeURIComponent("q".repeat(MAX_QUERY_LENGTH + 1))}`,
        {},
        env,
      )
    ).headers.get("cache-control");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });

  it("GREEN: event-states 410 already equals the Hono 410 directive set", async () => {
    const seen: Record<string, string>[] = [];
    await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env,
      setHeaders: (headers) => seen.push(headers),
      store: eventStateStore({ event: eventRow("cancelled") }),
    });
    const hono = await honoHeader((app) => app.get("/t", (c) => gone(c)), "/t");

    expectSameDirectives(seen[0]?.["cache-control"], hono);
  });
});
