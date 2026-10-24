// route-inventory: GET /
// route-inventory: GET /auth/status
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /profile
//
// Acceptance proof: oversized/malformed session cookies are rejected as
// guest/no-op BEFORE hashing or any session-store call, across every reader
// of the signed session bearer:
//
// - Hono readSession + fresh-login prior-token revoke (src/index.tsx)
// - auth-status fallback probe (src/auth-status.ts)
// - Kit request session + Kit auth-status cookie writer (src/kit-session.ts)
// - profile member gate (src/profiles/routes-gate.ts)
// - admin guard (src/admin/guard.ts)
//
// The minted token shape is fixed: `two_` + 32 random bytes, base64url with
// padding stripped — 47 chars of [A-Za-z0-9_-] after the prefix. Every
// malformed variant below is signed with the real secret, so the signature
// verifies and the token *shape* is the only defect. A spy store proves the
// rejection happens before the store: no get/statusHash/isActive/rotate/
// replace call may occur for a malformed bearer.
//
// Hermetic only: memory stores, serializeSigned-minted cookies, stubbed
// Discord fetch. No DB (no DATABASE_URL in the env passed to the app).
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import { kitAuthStatusCookieFor, resolveRequestSession } from "../src/kit-session";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
  DISCORD_MODERATOR_ROLE_IDS: "",
};

// Signed correctly; only the bearer shape is wrong. Valid minted shape is
// `two_` + 43 base64url chars (47 total).
const MALFORMED: ReadonlyArray<readonly [string, string]> = [
  ["oversized, 204 chars", `two_${"A".repeat(200)}`],
  ["over a 64-char bound, 65 chars", `two_${"A".repeat(61)}`],
  ["bad charset ! at valid length", `two_${"A".repeat(42)}!`],
  ["bad charset + (plain base64, not base64url) at valid length", `two_${"A".repeat(42)}+`],
  ["bad charset / at valid length", `two_${"A".repeat(42)}/`],
  ["padding = at valid length", `two_${"A".repeat(42)}=`],
  ["empty body", "two_"],
  ["short body", "two_abc"],
];

const READ_METHODS = ["get", "statusHash", "isActive", "rotate", "replace"] as const;

type SpyCall = { method: string; args: unknown[] };

/** Memory store wrapped so every session decision call is recorded. */
function spyStore() {
  const inner = createMemorySessionStore();
  const calls: SpyCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
    };
  const store: SessionStore = {
    ...inner,
    create: record("create") as SessionStore["create"],
    replace: record("replace") as SessionStore["replace"],
    get: record("get") as SessionStore["get"],
    statusHash: record("statusHash") as SessionStore["statusHash"],
    isActive: record("isActive") as SessionStore["isActive"],
    rotate: record("rotate") as SessionStore["rotate"],
    revoke: record("revoke") as SessionStore["revoke"],
    revokeLineage: record("revokeLineage") as SessionStore["revokeLineage"],
    revokeUserSessions: record("revokeUserSessions") as SessionStore["revokeUserSessions"],
  };
  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  const readCalls = () =>
    calls.filter((c) => (READ_METHODS as readonly string[]).includes(c.method));
  return { inner, store, calls, callsTo, readCalls, reset: () => (calls.length = 0) };
}

const pair = async (value: string, secret: string = SECRET) =>
  (await serializeSigned(SESSION_COOKIE, value, secret, { path: "/", secure: true })).split(
    ";",
  )[0]!;

async function seedLive(
  inner: SessionStore,
  row: { userId?: string; username?: string; member?: boolean; moderator?: boolean } = {},
) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await inner.create({
    tokenHash,
    // Snowflake-shaped: gated handlers validate the actor id format.
    userId: row.userId ?? "100000000000000042",
    username: row.username ?? "Rick",
    avatar: null,
    member: row.member ?? true,
    moderator: row.moderator ?? false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { token, tokenHash };
}

function envWith(store: SessionStore): Env {
  return { ...baseEnv, SESSION_STORE: store } as Env;
}

/** Discord answers for the OAuth callback and the homepage events read. */
function mockDiscord() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (u.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (u.includes("/scheduled-events")) return Response.json([]);
      if (u.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (u.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

const jarOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Fresh ordinary Discord login presenting `presented` as the prior cookie jar. */
async function discordLogin(env: Env, presented: string) {
  const start = await app.request("/auth/discord", {}, env);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = [jarOf(start), presented].filter(Boolean).join("; ");
  return app.request(
    `/auth/discord/callback?code=abc&state=${state}`,
    { headers: { cookie } },
    env,
  );
}

function profileHarness(store: SessionStore) {
  const log: AccessEntry[] = [];
  return profilesApp({
    sessionStore: store,
    store: createMemoryProfileStore([
      {
        id: "100000000000000042",
        username: "Rick",
        avatar: null,
        bio: null,
        games: [],
        timezone: null,
      },
    ]),
    accessLog: async (e) => {
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fixture sanity: the defect is shape, not signature or transport", () => {
  it("the minted token shape is two_ + 43 base64url chars (47 total)", () => {
    const token = newSessionToken();
    expect(token).toHaveLength(47);
    expect(token).toMatch(/^two_[A-Za-z0-9_-]{43}$/);
  });

  it.each(MALFORMED)("malformed variant round-trips signed parsing: %s", async (_label, value) => {
    const parsed = await parseSigned(await pair(value), SECRET);
    expect(parsed[SESSION_COOKIE]).toBe(value);
  });
});

describe("Kit resolveRequestSession", () => {
  it.each(MALFORMED)("malformed bearer is guest with no store read: %s", async (_label, value) => {
    const spy = spyStore();
    const request = new Request("https://next.example.test/events/past", {
      headers: { cookie: await pair(value) },
    });
    const decision = await resolveRequestSession(request, {
      sessionSecret: SECRET,
      store: spy.store,
    });
    expect(decision).toEqual({ status: "guest", session: null });
    expect(spy.readCalls()).toEqual([]);
  });
});

describe("Kit auth-status cookie writer", () => {
  it.each(MALFORMED)(
    "malformed bearer signs no probe and never reaches statusHash: %s",
    async (_label, value) => {
      const spy = spyStore();
      const request = new Request("https://next.example.test/admin", {
        headers: { cookie: await pair(value) },
      });
      const write = await kitAuthStatusCookieFor(envWith(spy.store))({
        request,
        url: new URL(request.url),
        route: { id: "/admin" },
        locals: {
          status: "authenticated",
          session: { userId: "42", username: "Rick", avatar: null, member: true, moderator: true },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
          restoredWrite: null,
        },
      });
      expect(write).toBeNull();
      expect(spy.readCalls()).toEqual([]);
    },
  );
});

describe("auth-status fallback probe (session cookie only, no probe cookie)", () => {
  it.each(MALFORMED)(
    "malformed bearer answers unauthenticated with no store read: %s",
    async (_label, value) => {
      const spy = spyStore();
      const res = await app.request(
        "/auth/status",
        { headers: { cookie: await pair(value) } },
        envWith(spy.store),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false });
      expect(spy.readCalls()).toEqual([]);
    },
  );
});

describe("profile member gate", () => {
  it.each(MALFORMED)(
    "malformed bearer bounces to OAuth with no store read: %s",
    async (_label, value) => {
      const spy = spyStore();
      const res = await profileHarness(spy.store).request(
        "/profile",
        { headers: { cookie: await pair(value) } },
        baseEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
      expect(spy.readCalls()).toEqual([]);
    },
  );
});

describe("admin guard", () => {
  it.each(MALFORMED)(
    "malformed bearer bounces to OAuth with no store read: %s",
    async (_label, value) => {
      const spy = spyStore();
      const res = await adminApp(spy.store).request(
        "/events",
        { headers: { cookie: await pair(value) } },
        baseEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
      expect(spy.readCalls()).toEqual([]);
    },
  );
});

describe("Hono readSession (homepage)", () => {
  it.each(MALFORMED)(
    "malformed bearer renders as guest with no store read or rotation: %s",
    async (_label, value) => {
      mockDiscord();
      const spy = spyStore();
      const res = await app.request(
        "/",
        { headers: { cookie: await pair(value) } },
        envWith(spy.store),
      );
      expect(res.status).toBe(200);
      expect(spy.readCalls()).toEqual([]);
    },
  );
});

describe("fresh login prior-token revoke (issueSession)", () => {
  it.each(MALFORMED)(
    "malformed presented bearer is a no-op: login creates fresh, never replaces by its hash: %s",
    async (_label, value) => {
      mockDiscord();
      const spy = spyStore();
      const env = envWith(spy.store);
      const login = await discordLogin(env, await pair(value));
      expect(login.status).toBe(302);
      expect(spy.callsTo("replace")).toEqual([]);
      expect(spy.callsTo("create")).toHaveLength(1);
      const malformedHash = await hashToken(value);
      expect(spy.calls.filter((c) => c.args.includes(malformedHash))).toEqual([]);
    },
  );
});

describe("controls: well-formed bearers behave exactly as before", () => {
  it("Kit: a valid live token authenticates and reads the store by its hash", async () => {
    const spy = spyStore();
    const { token, tokenHash } = await seedLive(spy.inner, { moderator: true });
    spy.reset();
    const request = new Request("https://next.example.test/events/past", {
      headers: { cookie: await pair(token) },
    });
    const decision = await resolveRequestSession(request, {
      sessionSecret: SECRET,
      store: spy.store,
    });
    expect(decision.status).toBe("authenticated");
    expect(spy.callsTo("get").map((c) => c.args)).toEqual([[tokenHash]]);
  });

  it("Kit: a well-formed but unknown token still reaches the store lookup", async () => {
    const spy = spyStore();
    const unknown = `two_${"A".repeat(43)}`;
    const request = new Request("https://next.example.test/events/past", {
      headers: { cookie: await pair(unknown) },
    });
    const decision = await resolveRequestSession(request, {
      sessionSecret: SECRET,
      store: spy.store,
    });
    expect(decision).toEqual({ status: "guest", session: null });
    expect(spy.callsTo("get").map((c) => c.args)).toEqual([[await hashToken(unknown)]]);
  });

  it("auth-status: a valid live token answers authenticated via the fallback read", async () => {
    const spy = spyStore();
    const { token, tokenHash } = await seedLive(spy.inner);
    spy.reset();
    const res = await app.request(
      "/auth/status",
      { headers: { cookie: await pair(token) } },
      envWith(spy.store),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(spy.callsTo("get").map((c) => c.args)).toContainEqual([tokenHash]);
  });

  it("auth-status: a tampered signed cookie is unauthenticated and never reads the store", async () => {
    const spy = spyStore();
    const { token } = await seedLive(spy.inner);
    spy.reset();
    const good = await pair(token);
    const tampered = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    const res = await app.request(
      "/auth/status",
      { headers: { cookie: tampered } },
      envWith(spy.store),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
    expect(spy.readCalls()).toEqual([]);
  });

  it("profiles: a valid member token passes the gate", async () => {
    const spy = spyStore();
    const { token, tokenHash } = await seedLive(spy.inner);
    spy.reset();
    const res = await profileHarness(spy.store).request(
      "/profile",
      { headers: { cookie: await pair(token) } },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(spy.callsTo("get").map((c) => c.args)).toContainEqual([tokenHash]);
  });

  it("admin: a valid moderator token passes the guard", async () => {
    const spy = spyStore();
    const { token, tokenHash } = await seedLive(spy.inner, { moderator: true });
    spy.reset();
    const res = await adminApp(spy.store).request(
      "/",
      { headers: { cookie: await pair(token) } },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(spy.callsTo("get").map((c) => c.args)).toContainEqual([tokenHash]);
  });

  it("homepage: a valid live token is read and rotated as before", async () => {
    mockDiscord();
    const spy = spyStore();
    const { token, tokenHash } = await seedLive(spy.inner);
    spy.reset();
    const res = await app.request(
      "/",
      { headers: { cookie: await pair(token) } },
      envWith(spy.store),
    );
    expect(res.status).toBe(200);
    expect(spy.callsTo("get").map((c) => c.args)).toContainEqual([tokenHash]);
    expect(spy.callsTo("rotate")).toHaveLength(1);
  });

  it("fresh login: a valid presented prior token is still replaced (revoked) on sign-in", async () => {
    mockDiscord();
    const spy = spyStore();
    const prior = await seedLive(spy.inner, { userId: "100000000000000043" });
    spy.reset();
    const login = await discordLogin(envWith(spy.store), await pair(prior.token));
    expect(login.status).toBe(302);
    expect(spy.callsTo("replace")).toHaveLength(1);
    expect(spy.callsTo("replace")[0]!.args[0]).toBe(prior.tokenHash);
    expect(await spy.inner.get(prior.tokenHash)).toBeNull();
  });
});
