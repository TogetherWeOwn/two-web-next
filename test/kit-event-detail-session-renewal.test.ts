// Acceptance contract: an authenticated Kit GET /e/:key read renews the
// sliding session — the post-release twin of Hono's readSession rotation
// (src/index.tsx: every authenticated page view mints a fresh token, deletes
// the old row and re-stamps the 120-minute sliding expiry, so a replayed
// bearer finds no row). The read-only bridge (src/kit-session.ts
// resolveRequestSession) still only peeks: rotation runs in the hook core
// after the member-read boundary releases a successful GET, at the same
// post-response position as the auth-status probe append in
// dispatchHookRequest. A refused, failed, throttled, redirected or fragment
// read never burns the presented bearer — the delivered response cannot strand
// a session it never issued.
//
// These tests drive the real boundaries a fix must sit behind — the real
// session bridge (kitSessionBridge), the real detail model
// (resolveKitEventDetail, as +page.server.ts calls it) and the real hook core
// (dispatchHookRequest + memberReadResponse, as web/src/hooks.server.ts
// delegates to it) — with the shipped detail entry enabled only inside this
// test manifest. Shipped ownership stays disabled (pinned below).
//
// Hermetic: synthetic signed cookies, a memory session store, fake detail
// reads, no DB/OAuth.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  kitEventDetailRotationFor,
  kitSessionBridge,
  type KitLocals,
  type KitRequestSession,
} from "../src/kit-session";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  isValidSessionToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from "../src/sessions";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import { env as baseEnv } from "./helpers/member-data";

const APP_URL = "https://next.example.test";
const HOST = "next.example.test";
const SECRET = "session-renewal-test-secret-32bytes";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DRAFT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FBV";
const CANCELLED_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FCV";
const MISSING_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FZV";
const MEMBER_ID = "100000000000000001";
const REFUSAL = "Member data is temporarily unavailable.";

const TEST_MANIFEST = ROUTE_MANIFEST.map((entry) =>
  entry.method === "GET" && entry.path === "/e/:key" ? { ...entry, enabled: true } : entry,
);

const NEIGHBORS: EventNeighbors = { previous: null, next: null };
const ATTENDEES: EventAttendee[] = [
  { id: "100000000000000003", name: "ann" },
  { id: "100000000000000004", name: "bob" },
];
const ANSWER: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

function fakeEvent(eventKey: string, status: string): PublicEvent {
  const startsAt = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    eventKey,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend.",
    startsAt,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status,
    rsvpOpen: true,
    discordEventId: null,
    goingCount: 2,
    goingOccupancy: 2,
  } as PublicEvent;
}

type Variant = "published" | "draft" | "cancelled" | "missing" | "outage";

function fakeStore(variant: Variant, keyFor: (pathKey: string) => string): KitEventDetailStore {
  return {
    dbForFn: async () => {
      if (variant === "outage") throw new Error("detail db down");
      return {} as Db;
    },
    getEventFn: async (_db, key) => {
      if (variant === "missing") return null;
      if (key === KEY) return fakeEvent(KEY, "published");
      if (key === DRAFT_KEY) return fakeEvent(DRAFT_KEY, "draft");
      if (key === CANCELLED_KEY) return fakeEvent(CANCELLED_KEY, "cancelled");
      return null;
    },
    neighborsFn: async () => NEIGHBORS,
    relatedFn: async (): Promise<EventLink[]> => [],
    attendeesFn: async () => ATTENDEES,
    viewerRsvpFn: async () => ANSWER,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

type HarnessOptions = {
  variant?: Variant;
  contentType?: string;
  throttle?: boolean;
  sink?: (entry: AccessEntry) => Promise<boolean>;
};

function harness(options: HarnessOptions = {}) {
  const { variant = "published", contentType = "text/html", throttle = false } = options;
  const store = createMemorySessionStore();
  const env = { ...baseEnv, SESSION_SECRET: SECRET, SESSION_STORE: store } as Env;
  const entries: AccessEntry[] = [];
  const rotations: { oldHash: string; expiresAt: Date }[] = [];
  const deps: HookDispatchDeps = {
    appUrl: APP_URL,
    honoFetch: vi.fn(async () => new Response("hono")),
    manifest: TEST_MANIFEST,
    sessionFor: kitSessionBridge(env),
    eventDetailRotationFor: kitEventDetailRotationFor(env),
    accessSink: async () =>
      options.sink ??
      (async (entry: AccessEntry) => {
        entries.push(entry);
        return true;
      }),
    ...(throttle
      ? {
          eventDetail: async () =>
            new Response("slow down", {
              status: 429,
              headers: { "content-type": "text/plain", "cache-control": "private, no-store" },
            }),
        }
      : {}),
    resolve: async (event) => {
      const locals = event.locals as Partial<KitLocals>;
      const headers: Record<string, string> = {};
      const outcome = await resolveKitEventDetail({
        key: event.url.pathname.split("/")[2] ?? "",
        search: event.url.search,
        path: event.url.pathname,
        env,
        session: { status: locals.status ?? "unknown", session: locals.session ?? null },
        joinResult: locals.joinResult ?? null,
        setHeaders: (h) => Object.assign(headers, h),
        store: fakeStore(variant, (k) => k),
      });
      if (outcome.kind === "redirect")
        return new Response(null, { status: 301, headers: { location: outcome.location } });
      const html = { "content-type": "text/html" };
      if (outcome.kind === "gone")
        return new Response("This event was cancelled.", { status: 410, headers: html });
      if (outcome.kind === "missing")
        return new Response("Not found", { status: 404, headers: html });
      if (outcome.kind === "forbidden")
        return new Response("Forbidden", { status: 403, headers: html });
      if (outcome.kind === "unavailable")
        return new Response(REFUSAL, { status: 503, headers: html });
      if (contentType !== "text/html") return Response.json({ eventKey: outcome.model.eventKey });
      const body = outcome.model.viewerMember
        ? `<h1>${outcome.model.title}</h1><button>Sign out</button>`
        : `<div data-testid="event-join-pitch">Welcome, guest</div><h1>${outcome.model.title}</h1>`;
      return new Response(event.request.method === "HEAD" ? null : body, {
        headers: { "content-type": "text/html", ...headers },
      });
    },
  };
  return { deps, entries, env, store, rotations };
}

const eventFor = (
  path: string,
  cookie: string | null,
  method = "GET",
  extraHeaders: Record<string, string> = {},
): HookEventLike => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...extraHeaders },
  });
  return { request, url: new URL(request.url), route: { id: "/e/[key]" } };
};

async function mint(
  store: SessionStore,
  actor: { userId: string; username: string; member: boolean; moderator: boolean },
  secret: string = SECRET,
  expiresAt: Date = new Date(Date.now() + 3600_000),
): Promise<{ cookie: string; token: string }> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt,
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { cookie, token };
}

const MEMBER = { userId: MEMBER_ID, username: "member", member: true, moderator: false };

const sessionSets = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));

function bearerOfSetCookie(setCookie: string): string {
  const value = setCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
  return value.slice(0, value.lastIndexOf("."));
}

function expectRotationCookie(res: Response, priorToken: string): string {
  const sets = sessionSets(res);
  expect(sets).toHaveLength(1);
  const parts = sets[0]!.split(";").map((p) => p.trim().toLowerCase());
  expect(parts).toContain("path=/");
  expect(parts).toContain("secure");
  expect(parts).toContain("httponly");
  expect(parts).toContain("samesite=lax");
  expect(parts).toContain(`max-age=${SESSION_TTL_SECONDS}`);
  const replacement = bearerOfSetCookie(sets[0]!);
  expect(isValidSessionToken(replacement)).toBe(true);
  expect(replacement).not.toBe(priorToken);
  return replacement;
}

function spyWriters(store: SessionStore) {
  const calls: string[] = [];
  for (const method of ["create", "replace", "rotate", "revoke"] as const) {
    const original = store[method].bind(store);
    store[method] = (async (...args: never[]) => {
      calls.push(method);
      return (original as (...a: never[]) => Promise<unknown>)(...args);
    }) as never;
  }
  return calls;
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("authenticated detail reads renew the sliding session", () => {
  it("rotates the bearer, re-stamps 120 minutes, and retires the old row", async () => {
    const { deps, store } = harness();
    const { cookie, token } = await mint(store, MEMBER);
    const startedAt = Date.now();
    let captured: { tokenHash: string; expiresAt: Date } | null = null;
    const rawRotate = store.rotate.bind(store);
    store.rotate = (async (oldHash: string, replacement: never) => {
      captured = replacement as unknown as { tokenHash: string; expiresAt: Date };
      return rawRotate(oldHash, replacement);
    }) as SessionStore["rotate"];

    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    expect(await res.clone().text()).toContain("Sign out");
    const replacement = expectRotationCookie(res, token);
    expect(await store.get(await hashToken(token))).toBeNull();
    const row = await store.get(await hashToken(replacement));
    expect(row?.userId).toBe(MEMBER_ID);
    expect(captured).not.toBeNull();
    expect(captured!.expiresAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + SESSION_TTL_SECONDS * 1000 - 60_000,
    );
    expect(captured!.expiresAt.getTime()).toBeLessThanOrEqual(
      startedAt + SESSION_TTL_SECONDS * 1000 + 60_000,
    );
  });

  it("signs the replacement with the session secret Hono verifies", async () => {
    const { deps, store } = harness();
    const { cookie } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    const verified = await parseSigned(sessionSets(res)[0]!, SECRET);
    expect(isValidSessionToken(verified[SESSION_COOKIE])).toBe(true);
  });

  it("rejects the prior bearer after rotation: replay renders the guest contract", async () => {
    const { deps, store } = harness();
    const { cookie } = await mint(store, MEMBER);
    const first = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(first.status).toBe(200);
    expect(sessionSets(first)).toHaveLength(1);

    const replay = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(replay.status).toBe(200);
    const body = await replay.clone().text();
    expect(body).toContain('data-testid="event-join-pitch"');
    expect(body).toContain("Welcome, guest");
    expect(body).not.toContain("Sign out");
    expect(sessionSets(replay)).toEqual([]);
  });

  it("rotates a signed-in non-moderator draft read (403): Hono reads the session before the draft check", async () => {
    const { deps, store } = harness({ variant: "draft" });
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${DRAFT_KEY}`, cookie), deps);
    expect(res.status).toBe(403);
    expectRotationCookie(res, token);
    expect(await store.get(await hashToken(token))).toBeNull();
  });
});

describe("anonymous and non-live reads never mint or rotate", () => {
  it("anonymous reads set no session cookie and write no session rows", async () => {
    const { deps, store } = harness();
    const writes = spyWriters(store);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, null), deps);
    expect(res.status).toBe(200);
    const body = await res.clone().text();
    expect(body).toContain('data-testid="event-join-pitch"');
    expect(body).not.toContain("Sign out");
    expect(sessionSets(res)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each(["tampered signature", "unknown token", "expired row"] as const)(
    "a %s renders guest without rotation",
    async (kind) => {
      const { deps, store } = harness();
      let cookie: string;
      if (kind === "tampered signature") {
        cookie = (await mint(store, MEMBER, "wrong-secret")).cookie;
      } else if (kind === "unknown token") {
        const token = newSessionToken();
        cookie = (
          await serializeSigned(SESSION_COOKIE, token, SECRET, { path: "/", secure: true })
        ).split(";")[0]!;
      } else {
        cookie = (await mint(store, MEMBER, SECRET, new Date(Date.now() - 1000))).cookie;
      }
      // Installed after setup: minting above is the fixture, not the read.
      const writes = spyWriters(store);
      const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toContain("Welcome, guest");
      expect(sessionSets(res)).toEqual([]);
      expect(writes).toEqual([]);
    },
  );
});

describe("unsuccessful and non-page reads leave the bearer live", () => {
  it.each([
    ["cancelled 410", "cancelled", `/e/${CANCELLED_KEY}`, 410],
    ["missing 404", "missing", `/e/${MISSING_KEY}`, 404],
    ["outage 503", "outage", `/e/${KEY}`, 503],
  ] as const)("%s never rotates", async (_label, variant, path, status) => {
    const { deps, store } = harness({ variant });
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(path, cookie), deps);
    expect(res.status).toBe(status);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("canonical 301 redirects before any session write", async () => {
    const { deps, store } = harness();
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY.toLowerCase()}`, cookie), deps);
    expect(res.status).toBe(301);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("throttled 429 reads never reach the session bridge", async () => {
    const { deps, store } = harness({ throttle: true });
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(res.status).toBe(429);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("a refused audit keeps the 503 refusal and the live bearer (no consume-before-audit)", async () => {
    const { deps, store } = harness({ sink: async () => false });
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toBe(REFUSAL);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("attendees-live fragment re-reads do not rotate (Hono reads fragments non-rotating)", async () => {
    const { deps, store } = harness();
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(
      eventFor(`/e/${KEY}`, cookie, "GET", {
        "x-two-island": "attendees-live",
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("HEAD reads do not rotate", async () => {
    const { deps, store } = harness();
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie, "HEAD"), deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });

  it("a non-HTML 200 does not rotate", async () => {
    const { deps, store } = harness({ contentType: "application/json" });
    const { cookie, token } = await mint(store, MEMBER);
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("rotation races stay safe", () => {
  it("a lost rotation race still delivers the released 200 without a cookie", async () => {
    const { deps, store } = harness();
    const { cookie } = await mint(store, MEMBER);
    store.rotate = (async () => false) as SessionStore["rotate"];
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain("Sign out");
    expect(sessionSets(res)).toEqual([]);
  });

  it("a rotation store error delivers the released 200 without renewal (fail-open, warned)", async () => {
    const { deps, store } = harness();
    const { cookie } = await mint(store, MEMBER);
    store.rotate = (async () => {
      throw new Error("rotation store down");
    }) as SessionStore["rotate"];
    const res = await dispatchHookRequest(eventFor(`/e/${KEY}`, cookie), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain("Sign out");
    expect(sessionSets(res)).toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });
});

describe("rotation helper guards", () => {
  const helperEvent = (cookie: string | null, locals: unknown): HookEventLike => ({
    ...eventFor(`/e/${KEY}`, cookie),
    locals,
  });

  it("returns null without an authenticated session in locals", async () => {
    const { env, store } = harness();
    const rotate = kitEventDetailRotationFor(env);
    const { cookie } = await mint(store, MEMBER);
    for (const locals of [
      undefined,
      { status: "guest", session: null },
      { status: "unknown", session: null },
      { status: "authenticated", session: null },
    ]) {
      await expect(rotate(helperEvent(cookie, locals))).resolves.toBeNull();
    }
  });

  it("re-verifies the cookie: forged locals with a tampered bearer rotate nothing", async () => {
    const { env, store } = harness();
    const rotate = kitEventDetailRotationFor(env);
    const { cookie } = await mint(store, MEMBER, "wrong-secret");
    const forged: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: MEMBER_ID,
        username: "member",
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    await expect(rotate(helperEvent(cookie, forged))).resolves.toBeNull();
  });

  it("returns null when no session secret is configured", async () => {
    const { store } = harness();
    const rotate = kitEventDetailRotationFor({
      ...baseEnv,
      SESSION_SECRET: "",
      SESSION_STORE: store,
    } as Env);
    const { cookie } = await mint(store, MEMBER);
    const locals: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: MEMBER_ID,
        username: "member",
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    await expect(rotate(helperEvent(cookie, locals))).resolves.toBeNull();
  });
});

describe("route ownership", () => {
  it("the shipped manifest keeps GET /e/:key Hono-owned", () => {
    const entry = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/e/:key");
    expect(entry?.enabled).toBe(false);
  });

  it("a released non-detail member page never rotates (route-scoped renewal)", async () => {
    const store = createMemorySessionStore();
    const env = { ...baseEnv, SESSION_SECRET: SECRET, SESSION_STORE: store } as Env;
    const { cookie, token } = await mint(store, MEMBER);
    // The shipped manifest already enables the member board: an authenticated
    // 200 there must leave the bearer alone.
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      sessionFor: kitSessionBridge(env),
      eventDetailRotationFor: kitEventDetailRotationFor(env),
      accessSink: async () => async () => true,
      resolve: async () =>
        new Response("<h1>Board</h1>", {
          headers: { "content-type": "text/html", "cache-control": "private, no-store" },
        }),
    };
    const request = new Request(new URL("/leaderboards/members", APP_URL).href, {
      headers: { host: HOST, cookie },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/leaderboards/members" } },
      deps,
    );
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(await store.get(await hashToken(token))).not.toBeNull();
  });
});
