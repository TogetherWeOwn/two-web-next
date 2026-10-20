// Test-Author-owned acceptance contract. The Builder changes production code,
// not these expectations. Real gates, signed cookies and an in-memory session
// store exercise renewal without a database, Discord or network transport.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { bufferedMemberHtml } from "../src/member-reads";
import { memberGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
} from "../src/sessions";

const COOKIE_NAME = "__Host-two_session";
const LOGIN_AT = Date.parse("2026-10-19T10:00:00.000Z");
const TTL_MS = SESSION_TTL_SECONDS * 1000;
const REQUEST_AT = Date.parse("2026-10-19T11:15:30.125Z");
const env: Env = {
  APP_URL: "https://app.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};
const MEMBER: DbSessionRow = {
  userId: "100000000000000001",
  username: "window-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = {
  ...MEMBER,
  userId: "100000000000000002",
  username: "window-moderator",
  moderator: true,
};

// The terminal handlers return only the authenticated viewer's identity. They
// do no member-data reads, so the real admin read boundary needs no audit DB.
function memberApp(store: SessionStore) {
  const app: ProfileApp = new Hono();
  app.use("/*", memberGate({ sessionStore: store }));
  app.get("/profile", (c) => c.html(`<p>${c.get("viewer").id}</p>`));
  return app;
}

function moderatorApp(store: SessionStore) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  app.use("/*", adminGuard({ sessionStore: store }));
  app.get("/admin", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-window" });
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  return app;
}

async function sessionFor(store: SessionStore, viewer: DbSessionRow) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({ ...viewer, tokenHash, expiresAt: new Date(LOGIN_AT + TTL_MS) });
  const signed = await serializeSigned(COOKIE_NAME, token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { tokenHash, cookie: signed.split(";")[0]! };
}

function sessionCookies(response: Response) {
  // The status-probe and journey cookies are not the authenticating bearer.
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
}

const gates = [
  { name: "memberGate", viewer: MEMBER, path: "/profile", app: memberApp },
  { name: "adminGuard", viewer: MODERATOR, path: "/admin", app: moderatorApp },
] as const;

beforeEach(() => {
  // Only Date is fake: cryptography and the read boundary's deadlines stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LOGIN_AT);
  vi.stubGlobal("fetch", () => {
    throw new Error("The gate acceptance suite must not use network transport");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(gates)("$name sliding session window (hermetic)", (gate) => {
  it.each([
    { when: "partway through the window", at: REQUEST_AT },
    { when: "one millisecond before expiry", at: LOGIN_AT + TTL_MS - 1 },
  ])("extends the existing row from request time $when", async ({ at }) => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(at);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`<p>${gate.viewer.userId}</p>`);

    // Observe the stored expires_at through its actual authentication boundary,
    // not a guessed new store method or a spy that pretends the write happened.
    // A cookie-only refresh, no-op renewal or extension from the old expiry all
    // fail these checks. No HTTP request here can accidentally renew it again.
    vi.setSystemTime(LOGIN_AT + TTL_MS + 1);
    expect
      .soft(await store.get(tokenHash), "row must outlive its original expiry")
      .toEqual(gate.viewer);
    vi.setSystemTime(at + TTL_MS - 1);
    expect
      .soft(await store.get(tokenHash), "row must survive until request time + TTL - 1ms")
      .toEqual(gate.viewer);
    vi.setSystemTime(at + TTL_MS);
    expect(await store.get(tokenHash), "row must expire exactly at request time + TTL").toBeNull();
  });

  it("refreshes the signed session cookie with a full Max-Age and the same bearer", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    const renewed = sessionCookies(response);
    expect(
      renewed,
      "authenticated GET must refresh the session cookie, not just the probe",
    ).toHaveLength(1);
    const [bearer, ...attributes] = renewed[0]!.split(";").map((part) => part.trim());
    expect(bearer).toBe(cookie);
    expect(attributes).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("Secure");
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the original bearer usable in another tab (admin must not rotate)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    const rotate = vi.spyOn(store, "rotate");
    const replace = vi.spyOn(store, "replace");
    const app = gate.app(store);
    for (const at of [REQUEST_AT, REQUEST_AT + 60_000]) {
      vi.setSystemTime(at);
      const response = await app.request(gate.path, { headers: { cookie } }, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`<p>${gate.viewer.userId}</p>`);
      expect(await store.get(tokenHash)).toEqual(gate.viewer);
      for (const refreshed of sessionCookies(response)) {
        expect(refreshed.split(";")[0]).toBe(cookie);
      }
    }
    // Admin's explicit no-rotation rule also excludes same-hash rotation.
    if (gate.name === "adminGuard") {
      expect(rotate).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    }
  });

  it("still bounces a bearer left idle for the full window, including the expiry instant", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(LOGIN_AT + TTL_MS);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(await response.text()).not.toContain(gate.viewer.userId);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await store.get(tokenHash)).toBeNull();
  });

  it("refuses the page with 503 if the renewal cannot be persisted", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, gate.viewer);
    // Fail writes at the store seam without prescribing a new renewal method.
    // Existing authentication/probe reads still use the real memory store.
    const reads = new Set<PropertyKey>(["get", "statusHash", "isActive"]);
    const failingWrites = new Proxy(store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function" || reads.has(key)) return value;
        return async () => {
          throw new Error("fixture session write unavailable");
        };
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(failingWrites).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(sessionCookies(response)).toHaveLength(0);
    const body = await response.text();
    expect(body).not.toContain(gate.viewer.userId);
    expect(body).not.toContain("fixture session write unavailable");
  });

  it("returns 503, not a guest redirect, when the session store fails", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, gate.viewer);
    vi.spyOn(store, "get").mockRejectedValue(new Error("fixture session store unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(sessionCookies(response)).toHaveLength(0);
    const body = await response.text();
    expect(body).not.toContain(gate.viewer.userId);
    expect(body).not.toContain("fixture session store unavailable");
  });
});
