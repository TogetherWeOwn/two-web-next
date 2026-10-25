// Tier-0 authz matrix (REPORT-ONLY): role x route x expected-status over the
// admin panel, the session-gated event routes and the auth-status probe.
// Table-driven so a new protected route adds one row, not one test.
//
// Memory seams only (no database, no network, no Discord): the matrix pins
// the AUTHORIZATION decision. Moderators admitted past the guard reach
// handlers that need Postgres, which is absent here, so those rows pin the
// deterministic no-DB outcome per route (200 where the handler is DB-free,
// 301 on a legacy alias, else the 503 the app answers when it cannot decide
// otherwise). The point of each such row is what it is NOT: never a login
// bounce (302/303) and never a forbidden (403/401).
import { serializeSigned } from "hono/utils/cookie";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { authStatus, enableAuthStatus } from "../src/auth-status";
import type { Env, Session } from "../src/env";
import { registerEventRoutes, type SessionReader } from "../src/events/routes";
import { LOGIN_INTENDED_COOKIE } from "../src/return-journey";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const MEMBER = { userId: "100000000000000222", username: "pleb", moderator: false };

/** Mint a bearer cookie for a session row seeded directly in the store. */
async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

/** A bearer with a valid signature but no live row: an expired guest. */
async function expiredCookie(): Promise<string> {
  const serialized = await serializeSigned(
    "__Host-two_session",
    newSessionToken(),
    SESSION_SECRET,
    { path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  );
  return serialized.split(";")[0]!;
}

function intendedPair(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(`${LOGIN_INTENDED_COOKIE}=`)) return c.split(";")[0]!;
  }
  return null;
}

function failingStore(): SessionStore {
  return {
    ...createMemorySessionStore(),
    get: async () => {
      throw new Error("session store down");
    },
  };
}

// ---------------------------------------------------------------------------
// Admin panel: the guard-behind GET surface (dashboard, list, form, detail
// and legacy-alias reads). The moderator bit arrives via the seeded session
// row; the pure allowlist behind it (parseModeratorRoleIds/isModerator) is
// pinned by fast-check in request-validation.property.test.ts.
// ---------------------------------------------------------------------------

const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// GET routes behind adminGuard whose authorization the matrix pins: guest
// bounces, member 403s, expired bounces. The queue preview route is absent
// here on purpose: its operator admission runs before the guard and refuses
// every role without staging settings (pinned separately below). POSTs are
// covered by the guest-write rows below; the write envelope (throttle, body
// limit, origin check) has its own suites.
const ADMIN_GET_ROUTES = [
  "/",
  "/events",
  "/events/new",
  `/events/${EVENT_KEY}`,
  `/events/${EVENT_KEY}/edit`,
  "/events/create",
  "/featured",
  "/featured/new",
  "/featured/7",
  "/featured-contents",
  "/featured-contents/create",
  "/featured-contents/7/edit",
  "/join-attempts",
  "/join-attempts/9",
  "/activity-log",
];

describe("tier-0 admin guard matrix", () => {
  for (const route of ADMIN_GET_ROUTES) {
    it(`guest GET ${route} bounces to OAuth, never a 403`, async () => {
      const res = await adminApp(createMemorySessionStore()).request(route, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
      expect(intendedPair(res)).toBeTruthy();
    });

    it(`signed non-moderator GET ${route} gets 403, never a login loop`, async () => {
      const store = createMemorySessionStore();
      const res = await adminApp(store).request(
        route,
        { headers: { cookie: await cookieFor(store, MEMBER) } },
        env,
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect(intendedPair(res)).toBeNull();
    });

    it(`expired session GET ${route} bounces back to OAuth`, async () => {
      const res = await adminApp(createMemorySessionStore()).request(
        route,
        { headers: { cookie: await expiredCookie() } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    });
  }

  // Moderator outcomes past the guard with no Postgres: DB-free renders
  // answer 200, legacy aliases redirect, data reads answer the app's
  // database-unavailable 503. None may bounce (302/303) or forbid (403).
  for (const [route, expected, location] of [
    ["/", 200, null],
    ["/events/new", 200, null],
    ["/featured/new", 200, null],
    ["/events/create", 301, "/admin/events/new"],
    [`/events/${EVENT_KEY}/edit`, 301, `/admin/events/${EVENT_KEY}`],
    ["/featured-contents", 301, "/admin/featured"],
    ["/featured-contents/create", 301, "/admin/featured/new"],
    ["/events", 503, null],
    [`/events/${EVENT_KEY}`, 503, null],
    ["/featured", 503, null],
    ["/featured/7", 503, null],
    ["/featured-contents/7/edit", 503, null],
    ["/join-attempts", 503, null],
    ["/join-attempts/9", 503, null],
    ["/activity-log", 503, null],
  ] as const) {
    it(`moderator GET ${route} gets ${expected}`, async () => {
      const store = createMemorySessionStore();
      const res = await adminApp(store).request(
        route,
        { headers: { cookie: await cookieFor(store, MOD) } },
        env,
      );
      expect(res.status).toBe(expected);
      expect(res.headers.get("location")).toBe(location);
    });
  }

  it("queue preview without operator admission refuses every role before the guard", async () => {
    const store = createMemorySessionStore();
    const mod = await cookieFor(store, MOD);
    const mem = await cookieFor(store, MEMBER);
    for (const cookie of [undefined, mem, mod]) {
      const res = await adminApp(store).request(
        "/queue/failed/3/preview",
        cookie ? { headers: { cookie } } : {},
        env,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "preview_disabled" });
    }
  });

  it("session store outage fails closed to 503, not 302 or 403", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = createMemorySessionStore();
    const res = await adminApp({ sessionStore: failingStore() }).request(
      "/events",
      { headers: { cookie: await cookieFor(seed, MOD) } },
      env,
    );
    expect(res.status).toBe(503);
    vi.restoreAllMocks();
  });

  it("guest POST with a JSON body keeps 401 with a recovery link, never a redirect", async () => {
    const res = await adminApp(createMemorySessionStore()).request(
      "/events/new",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { error: string; recovery: string };
    expect(body.error).toBe("unauthenticated");
    expect(typeof body.recovery).toBe("string");
  });

  it("guest POST as a form bounces to the recovery page", async () => {
    const res = await adminApp(createMemorySessionStore()).request(
      "/events/new",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=x",
      },
      env,
    );
    expect(res.status).toBe(303);
  });
});

// ---------------------------------------------------------------------------
// Session-gated event routes: JSON collection, RSVP verbs, moderator writes.
// ---------------------------------------------------------------------------

const memberSession = (moderator: boolean, member = true): Session => ({
  id: "100000000000000222",
  username: "pleb",
  avatar: null,
  member,
  moderator,
});
const readerFor =
  (session: Session | null): SessionReader =>
  async () =>
    session;

function eventsApp(session: Session | null) {
  const app = new Hono<{ Bindings: Env }>();
  const reader = readerFor(session);
  registerEventRoutes(app, reader, reader);
  return app;
}

describe("tier-0 event session-gate matrix", () => {
  it("guest GET /events.json asking JSON gets 401, never a redirect", async () => {
    const res = await eventsApp(null).request(
      "/events.json",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("guest GET /events.json asking HTML bounces to login", async () => {
    const res = await eventsApp(null).request(
      "/events.json",
      { headers: { accept: "text/html" } },
      env,
    );
    expect(res.status).toBe(302);
  });

  it("signed member GET /events.json passes the gate and waits on Postgres", async () => {
    const res = await eventsApp(memberSession(false)).request(
      "/events.json",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "db_unavailable" });
  });

  for (const [role, session, expected] of [
    ["guest", null, 401],
    ["signed non-member", memberSession(false, false), 403],
    ["signed member", memberSession(false), 503],
    ["moderator", memberSession(true), 503],
  ] as const) {
    it(`${role} PUT /events/:key/rsvp gets ${expected}`, async () => {
      const res = await eventsApp(session).request(
        `/events/${EVENT_KEY}/rsvp`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "going" }),
        },
        env,
      );
      expect(res.status).toBe(expected);
    });
  }

  it("signed member PUT with an unparsable status gets 422 before Postgres", async () => {
    const res = await eventsApp(memberSession(false)).request(
      `/events/${EVENT_KEY}/rsvp`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(422);
  });

  it("signed member PUT for another member's row gets 403, never their data", async () => {
    const res = await eventsApp(memberSession(false)).request(
      `/events/${EVENT_KEY}/rsvp`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "going", user_id: "100000000000000999" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("signed member PUT with a forged key gets 404 before Postgres", async () => {
    const res = await eventsApp(memberSession(false)).request(
      "/events/nope/rsvp",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "going" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("guest DELETE /events/:key/rsvp gets 401", async () => {
    const res = await eventsApp(null).request(
      `/events/${EVENT_KEY}/rsvp`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("guest POST /e/:key/rsvp (no-JS adapter) redirects into the join flow", async () => {
    const res = await eventsApp(null).request(
      `/e/${EVENT_KEY}/rsvp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/join/discord");
    expect(location).toContain("next=");
  });

  for (const [role, session, expected] of [
    ["guest", null, 401],
    ["signed non-moderator", memberSession(false), 403],
  ] as const) {
    it(`${role} POST /events (moderator write) gets ${expected}`, async () => {
      const res = await eventsApp(session).request(
        "/events",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        env,
      );
      expect(res.status).toBe(expected);
    });
  }

  it("moderator POST /events passes the gate and waits on Postgres", async () => {
    const res = await eventsApp(memberSession(true)).request(
      "/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Auth-status probe: the tab-sync liveness cookie.
// ---------------------------------------------------------------------------

function statusApp(store: SessionStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/auth/status", (c) => authStatus(c, async () => store));
  return app;
}

describe("tier-0 auth-status probe matrix", () => {
  it("no cookies means anonymous, still 200", async () => {
    const res = await statusApp(createMemorySessionStore()).request("/auth/status", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("garbage cookies mean anonymous, still 200", async () => {
    const res = await statusApp(createMemorySessionStore()).request(
      "/auth/status",
      { headers: { cookie: "__Host-two_session_status=garbage; __Host-two_session=two_bogus" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("a live probe cookie reports authenticated", async () => {
    const store = createMemorySessionStore();
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await store.create({
      tokenHash,
      userId: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const mint = new Hono<{ Bindings: Env }>();
    mint.get("/test/mint", async (c) => {
      await enableAuthStatus(c, store, tokenHash);
      return c.text("ok");
    });
    const mintRes = await mint.request("/test/mint", {}, env);
    const cookies = mintRes.headers.getSetCookie().map((c) => c.split(";")[0]!);
    expect(cookies.length).toBeGreaterThan(0);
    const res = await statusApp(store).request(
      "/auth/status",
      { headers: { cookie: cookies.join("; ") } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
  });

  it("a revoked session reports anonymous", async () => {
    const store = createMemorySessionStore();
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await store.create({
      tokenHash,
      userId: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const key = (await store.statusHash(tokenHash))!;
    await store.revoke(tokenHash);
    const probe = await serializeSigned("__Host-two_session_status", key, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const res = await statusApp(store).request(
      "/auth/status",
      { headers: { cookie: probe.split(";")[0]! } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});
