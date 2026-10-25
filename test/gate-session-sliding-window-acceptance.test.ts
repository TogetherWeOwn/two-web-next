// Session-window acceptance contract, revised for the profile/admin re-stamp:
// authenticated gate views rotate (fresh bearer + fresh window + Set-Cookie),
// mirroring readSession. Real gates, signed cookies and an in-memory session
// store exercise rotation without a database, Discord or network transport.
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

/** The bearer inside a `name=signed` cookie pair (unsigned half). */
function bearerOf(pair: string): string {
  const signed = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(";")[0]!);
  return signed.slice(0, signed.lastIndexOf("."));
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
  ])("re-stamps the window on a fresh successor from request time $when", async ({ at }) => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    const presented = bearerOf(cookie);
    const rotate = vi.spyOn(store, "rotate");
    const renew = vi.spyOn(store, "renew");
    vi.setSystemTime(at);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`<p>${gate.viewer.userId}</p>`);
    expect(renew, "the re-stamp must rotate, not renew").not.toHaveBeenCalled();
    expect(rotate, "an authenticated view must rotate exactly once").toHaveBeenCalledTimes(1);

    // The view mints a fresh bearer: the old row is deleted and survives only
    // as 10s predecessor grace, while the successor keeps the lineage key.
    const refreshed = sessionCookies(response);
    expect(refreshed, "an authenticated view must re-stamp with a session cookie").toHaveLength(1);
    const bearer = bearerOf(refreshed[0]!);
    expect(bearer, "the view must mint a fresh bearer").not.toBe(presented);
    const successorHash = await hashToken(bearer);
    expect(await store.statusHash(tokenHash), "the predecessor keeps no status key").toBeNull();
    expect(await store.get(tokenHash), "the predecessor stays grace-valid").toEqual(gate.viewer);
    expect(await store.statusHash(successorHash), "the successor keeps the lineage key").toBe(
      tokenHash,
    );

    // Observe the stored expires_at through its actual authentication boundary,
    // not a guessed new store method or a spy that pretends the write happened.
    // A cookie-only refresh, no-op rotation or extension from the old expiry
    // all fail these checks. No HTTP request here can accidentally rotate it
    // again.
    vi.setSystemTime(LOGIN_AT + TTL_MS + 1);
    expect
      .soft(await store.get(successorHash), "successor must outlive the original expiry")
      .toEqual(gate.viewer);
    expect.soft(await store.get(tokenHash), "the predecessor must read dead past grace").toBeNull();
    vi.setSystemTime(at + TTL_MS - 1);
    expect
      .soft(await store.get(successorHash), "successor must survive until request time + TTL - 1ms")
      .toEqual(gate.viewer);
    vi.setSystemTime(at + TTL_MS);
    expect(
      await store.get(successorHash),
      "successor must expire exactly at request time + TTL",
    ).toBeNull();
  });

  it("refreshes the signed session cookie with a full Max-Age and a fresh bearer", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    const refreshed = sessionCookies(response);
    expect(
      refreshed,
      "authenticated GET must refresh the session cookie, not just the probe",
    ).toHaveLength(1);
    const [bearer, ...attributes] = refreshed[0]!.split(";").map((part) => part.trim());
    expect(bearer, "the refreshed cookie must carry a fresh bearer").not.toBe(cookie);
    expect(attributes).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("Secure");
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(response.headers.get("cache-control")).toContain("no-store");
    // The fresh bearer authenticates as the same viewer; the presented bearer
    // survives only as predecessor grace.
    expect(await store.get(await hashToken(bearerOf(refreshed[0]!)))).toEqual(gate.viewer);
  });

  it("rotates every view while the predecessor stays grace-valid for the other tab", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    const rotate = vi.spyOn(store, "rotate");
    const renew = vi.spyOn(store, "renew");
    const replace = vi.spyOn(store, "replace");
    const app = gate.app(store);
    let jar = cookie;
    const seen = [tokenHash];
    for (const at of [REQUEST_AT, REQUEST_AT + 60_000]) {
      vi.setSystemTime(at);
      const response = await app.request(gate.path, { headers: { cookie: jar } }, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`<p>${gate.viewer.userId}</p>`);
      const refreshed = sessionCookies(response);
      expect(refreshed, "every authenticated view must re-stamp").toHaveLength(1);
      const bearer = bearerOf(refreshed[0]!);
      expect(bearer, "every view must mint a fresh bearer").not.toBe(bearerOf(jar));
      const successorHash = await hashToken(bearer);
      expect(await store.get(successorHash)).toEqual(gate.viewer);
      seen.push(successorHash);
      jar = refreshed[0]!.split(";")[0]!;
    }
    expect(renew, "views must rotate, never renew").not.toHaveBeenCalled();
    expect(replace, "views must not mint fresh lineages").not.toHaveBeenCalled();
    expect(rotate, "each view rotates exactly once").toHaveBeenCalledTimes(2);
    // The other tab's bearer stays grace-valid for 10s, then reads dead while
    // the latest successor lives: one live row, one immediate grace.
    expect(await store.get(seen[1]!), "the immediate predecessor stays grace-valid").toEqual(
      gate.viewer,
    );
    expect(await store.get(seen[0]!), "the grandparent is pruned on the next win").toBeNull();
    expect(await store.statusHash(seen[2]!), "the lineage key never forks").toBe(seen[0]!);
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
