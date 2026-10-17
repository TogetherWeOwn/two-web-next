// route-inventory: GET /events
// route-inventory: POST /events
// route-inventory: GET /events.json
// Acceptance tests: events index under Kit ownership.
//
// Test files only: the sibling build card builds on this branch
// and never edits this file. Failing-first: the ownership pins below require
// the shipped ROUTE_MANIFEST to carry GET /events enabled, so they fail on
// current main (Hono-owned) and pass only once the sibling flips the flag.
// POST /events and GET /events.json stay Hono-owned in both states.
//
// Journey coverage: a seeded Hono listing contract (rows, calendar controls,
// navigation, guest chrome) plus the Kit load+render preserving the same
// contract through loadEventsPage/renderEventsHtml against the same fixture.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  EVENTS_CALENDAR_TESTID,
  EVENTS_CONTENT_TESTID,
  EVENTS_LIST_TESTID,
  EVENTS_PAST_ARCHIVE_LINK_TESTID,
  EVENTS_SEARCH_TESTID,
  EVENTS_SUBSCRIBE_TESTID,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_LIST_TESTID,
  EVENT_CARD_TESTID,
} from "../src/islands/contracts-calendar";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  decideOwner,
  dispatchHookRequest,
  resolveRouteOwner,
} from "../src/route-ownership";
import { createMemorySessionStore } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const expectCookieVaryToken = (value: string): void => {
  const tokens = value.split(",").map((token) => token.trim().toLowerCase());
  expect(tokens).toContain("cookie");
  expect(tokens).not.toContain("x-cookie");
};

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "test-guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
} as unknown as Env;

// All-digit 26-char keys: no secret-scanner shape, deterministic order.
const key = (n: number): string => String(n).padStart(26, "0");

describe("events index ownership under Kit (failing-first)", () => {
  it("matches Cookie as an exact case-insensitive Vary token", () => {
    expectCookieVaryToken("Cookie, X-Two-Island");
    expectCookieVaryToken("cOoKiE, X-Two-Island");
    expect(() => expectCookieVaryToken("X-Cookie, X-Two-Island")).toThrow();
  });

  it("ships GET /events enabled as public reads", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/events",
      enabled: true,
      reads: "public",
    });
  });

  it("routes GET and HEAD /events to Kit once enabled", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/events" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/events" })).toBe("kit");
    expect(decideOwner(new Request("https://next.example.test/events"))).toBe("kit");
  });

  it("keeps POST /events and GET /events.json on Hono", () => {
    expect(resolveRouteOwner({ method: "POST", path: "/events" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events.json" })).toBe("hono");
    // Only the GET list migrates: no POST or JSON entry may ever flip it.
    expect(
      ROUTE_MANIFEST.some(
        (entry) => entry.method === "POST" && entry.path === "/events" && entry.enabled,
      ),
    ).toBe(false);
    expect(ROUTE_MANIFEST.some((entry) => entry.path === "/events.json" && entry.enabled)).toBe(
      false,
    );
  });

  it("dispatches GET /events to Kit with the renderer marker on the shipped manifest", async () => {
    const request = new Request("https://next.example.test/events", {
      headers: { host: "next.example.test" },
    });
    const event = {
      request,
      url: new URL(request.url),
      route: { id: "/events" },
    };
    const honoFetch = vi.fn(async () => new Response("hono", { status: 200 }));
    const resolve = vi.fn(
      async () =>
        new Response("<main>kit list</main>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const response = await dispatchHookRequest(event, {
      appUrl: APP_URL,
      honoFetch,
      resolve,
    });

    expect(resolve).toHaveBeenCalledOnce();
    expect(honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("sends POST /events to Hono with the body unread and no Kit marker", async () => {
    const body = JSON.stringify({ title: "Seed swap" });
    const request = new Request("https://next.example.test/events", {
      method: "POST",
      headers: {
        host: "next.example.test",
        "content-type": "application/json",
      },
      body,
    });
    const event = {
      request,
      url: new URL(request.url),
      route: { id: "/events" },
    };
    let usedAtHandoff: boolean | null = null;
    const honoFetch = vi.fn(async (req: Request) => {
      usedAtHandoff = req.bodyUsed;
      return new Response("hono-post", { status: 200 });
    });
    const resolve = vi.fn(async () => new Response("kit", { status: 200 }));
    expect(request.bodyUsed).toBe(false);

    const response = await dispatchHookRequest(event, {
      appUrl: APP_URL,
      honoFetch,
      resolve,
    });

    expect(honoFetch).toHaveBeenCalledOnce();
    expect(usedAtHandoff).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono-post");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("sends GET /events.json to Hono with no Kit marker", async () => {
    const request = new Request("https://next.example.test/events.json", {
      headers: { host: "next.example.test" },
    });
    const event = {
      request,
      url: new URL(request.url),
      route: { id: "/[...path]" },
    };
    const honoFetch = vi.fn(async () => new Response("hono-json", { status: 200 }));
    const resolve = vi.fn(async () => new Response("kit", { status: 200 }));

    const response = await dispatchHookRequest(event, {
      appUrl: APP_URL,
      honoFetch,
      resolve,
    });

    expect(honoFetch).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono-json");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });
});

describe("Hono /events write and JSON stay Hono-owned (no Kit marker)", () => {
  it("answers guest POST /events unauthenticated without the Kit marker", async () => {
    const res = await app.request(
      "/events",
      {
        method: "POST",
        headers: { origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ title: "Seed swap" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("answers guest GET /events.json unauthenticated JSON without the Kit marker", async () => {
    const res = await app.request("/events.json", {}, baseEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("events index journey (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;

  const liveEnv = (): Env =>
    ({
      ...baseEnv,
      SESSION_STORE: createMemorySessionStore(),
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      ADMIN_DB: db,
    }) as unknown as Env;

  const seedListRows = async (): Promise<void> => {
    await db.insert(events).values([
      {
        eventKey: key(701),
        title: "Acceptance list seed Alpha",
        game: "Chess",
        status: "published",
        startsAt: new Date("2099-06-10T19:00:00Z"),
        endsAt: new Date("2099-06-10T21:00:00Z"),
        timezone: "Europe/London",
        location: "Voice",
      },
      {
        eventKey: key(702),
        title: "Acceptance list seed Beta",
        game: "Go",
        status: "published",
        startsAt: new Date("2099-06-11T19:00:00Z"),
        endsAt: new Date("2099-06-11T21:00:00Z"),
        timezone: "Europe/London",
        location: "Voice",
      },
    ]);
  };

  beforeAll(async () => {
    testDatabaseUrl(process.env.DATABASE_URL!);
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("Hono GET /events renders seeded rows, calendar controls, navigation and guest chrome", async () => {
    __resetAnonEventCacheForTests();
    await fixture.reset();
    await seedListRows();

    const res = await app.request("/events", {}, liveEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expectCookieVaryToken(res.headers.get("vary") ?? "");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();

    const html = await res.text();
    // Seeded rows.
    expect(html).toContain("Acceptance list seed Alpha");
    expect(html).toContain("Acceptance list seed Beta");
    expect(html).toContain(`data-testid="${EVENT_CARD_TESTID}"`);
    // Calendar controls: island identity, view toggles, search, archive + subscribe.
    expect(html).toContain('data-island="events-calendar"');
    expect(html).toContain(`data-testid="${EVENTS_CALENDAR_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_CONTENT_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_LIST_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_CALENDAR_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_PAST_ARCHIVE_LINK_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`);
    expect(html).toContain('<form method="get" action="/events"');
    expect(html).toContain('name="q"');
    expect(html).toContain('<script src="/islands/events-calendar.js"');
    // Navigation: primary Events current, canonical, markdown alternate.
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('<a href="/events" aria-current="page">Events</a>');
    expect(html).toContain('<link rel="canonical" href="https://next.example.test/events"');
    expect(html).toContain('href="/events.md"');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('id="main"');
    // Guest chrome: header sign-in plus the in-page join CTA, never member chrome.
    expect(html).toContain("Welcome, guest");
    expect(html).toContain('data-testid="signin"');
    expect(html).toContain("/auth/discord?next=%2Fevents");
    expect(html).toContain("Join the Discord");
    expect(html).toContain("/join?next=%2Fevents");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Open Discord");
    expect(html).not.toContain('data-testid="join-result"');
  });

  it("Kit load+render preserves the seeded Hono listing contract", async () => {
    __resetAnonEventCacheForTests();
    await fixture.reset();
    await seedListRows();

    const collected: Record<string, string> = {};
    const data = await loadEventsPage({
      env: { APP_URL, DISCORD_INVITE_URL: "https://discord.gg/invite" } as never,
      url: new URL("https://next.example.test/events"),
      method: "GET",
      island: false,
      request: new Request("https://next.example.test/events"),
      setHeaders: (headers) => Object.assign(collected, headers),
      deleteJoinCookie: () => {},
      dbForFn: async () => db,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });
    const rendered = await renderEventsHtml(data as never, collected);
    expect(rendered.status).toBe(200);
    expect(rendered.headers["content-type"]).toBe("text/html; charset=UTF-8");
    expectCookieVaryToken(rendered.headers.vary ?? "");

    const html = rendered.body;
    expect(html).toContain("Acceptance list seed Alpha");
    expect(html).toContain("Acceptance list seed Beta");
    expect(html).toContain(`data-testid="${EVENT_CARD_TESTID}"`);
    expect(html).toContain('data-island="events-calendar"');
    expect(html).toContain(`data-testid="${EVENTS_CALENDAR_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_CONTENT_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_LIST_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_CALENDAR_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_PAST_ARCHIVE_LINK_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`);
    expect(html).toContain('<form method="get" action="/events"');
    expect(html).toContain('<script src="/islands/events-calendar.js"');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('<a href="/events" aria-current="page">Events</a>');
    expect(html).toContain('<link rel="canonical" href="https://next.example.test/events"');
    expect(html).toContain('href="/events.md"');
    expect(html).toContain("Welcome, guest");
    expect(html).toContain("/auth/discord?next=%2Fevents");
    expect(html).toContain("Join the Discord");
    expect(html).toContain("/join?next=%2Fevents");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Open Discord");
    expect(html).not.toContain('data-testid="join-result"');
  });
});
