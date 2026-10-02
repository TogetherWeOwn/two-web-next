import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { QA_HEADER, QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, hashToken, type SessionStore } from "../src/sessions";
import { isModerator, parseModeratorRoleIds } from "../src/roles";

// W15: legacy Auth/* and SessionCookieFlagsTest (file mapping in docs/w15-auth-tests.md).
// Fixtures are synthetic. These tests never read a deployment binding or contact Discord.
const env: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_INVITE_URL: "https://discord.gg/test-invite",
  SESSION_SECRET: "test-session-signing-key-at-least-32-bytes",
  DISCORD_MODERATOR_ROLE_IDS: "",
  QA_AUTH_TOKEN: "test-only-qa-token",
};
const TTL = 30 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-two_session";
const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
const bearer = (res: Response) => decodeURIComponent(sessionCookie(res).split(";")[0]!.slice(SESSION_COOKIE.length + 1)).split(".")[0]!;

function isolated() {
  const store = createMemorySessionStore(() => Date.now());
  return { store, env: { ...env, SESSION_STORE: store } as Env };
}
const qaLogin = (e: Env, identity = "qa-member", headers: Record<string, string> = {}) =>
  app.request(`/auth/qa/${identity}`, { method: "POST", headers: { origin: new URL(e.APP_URL).origin, [QA_HEADER]: env.QA_AUTH_TOKEN!, ...headers } }, e);

function mockDiscord(failAt?: "exchange" | "user" | "join", globalName: string | null = "Display Name") {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/token")) {
      if (failAt === "exchange") return new Response("untrusted-upstream-body", { status: 401 });
      return Response.json({ access_token: "test-member-access-token" });
    }
    if (url.endsWith("/users/@me")) {
      if (failAt === "user") return new Response("untrusted-upstream-body", { status: 503 });
      return Response.json({ id: "42", username: "handle", global_name: globalName, avatar: "avatar-hash" });
    }
    if (url.includes("/members/42") && init?.method === "PUT") {
      if (failAt === "join") throw new Error("network unavailable");
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected mocked Discord route: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function signIn(e: Env) {
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return app.request(`/auth/discord/callback?code=test-code&state=${state}`, { headers: { cookie: cookies(start) } }, e);
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("W15 Discord login and callback boundaries", () => {
  it("requests the Next auto-join scope, a fresh state and a 10-minute host-only cookie", async () => {
    const { env: e } = isolated();
    const first = await app.request("/auth/discord", {}, e);
    const second = await app.request("/auth/discord", {}, e);
    const url = new URL(first.headers.get("location")!);
    expect(url.searchParams.get("scope")).toBe("identify guilds.join");
    expect(url.searchParams.get("client_id")).toBe(env.DISCORD_CLIENT_ID);
    expect(url.searchParams.get("state")).not.toBe(new URL(second.headers.get("location")!).searchParams.get("state"));
    // A bare /auth/discord emits the state cookie plus the stale-clear
    // deletion for the explicit next (TOG-10356 finding 6): find by name,
    // never by position.
    const stateCookie = first.headers.getSetCookie().find((c) => c.startsWith("__Host-two_oauth_state="))!;
    for (const flag of ["__Host-two_oauth_state=", "Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) {
      expect(stateCookie).toContain(flag);
    }
    expect(stateCookie).not.toMatch(/Domain=/i);
  });

  it.each(["", "?code=x", "?state=x", "?error=access_denied&error_description=do-not-echo", "?code=x&state=forged"])(
    "rejects an incomplete/denied/forged callback %s before any exchange", async (query) => {
      const { env: e } = isolated();
      const fetch = mockDiscord();
      const start = await app.request("/auth/discord", {}, e);
      const result = await app.request(`/auth/discord/callback${query}`, { headers: { cookie: cookies(start) } }, e);
      expect(result.status).toBe(302);
      // A consent refusal (error=access_denied) gets its own user-visible
      // meaning — "you cancelled" — distinct from the generic failure banner
      // (TOG-10355, legacy DiscordLoginTest denial row). None of these rows
      // may reach Discord.
      const notice = query.includes("error=access_denied") ? "signin_denied" : "signin_failed";
      expect(result.headers.get("location")).toBe(`/?n=${notice}`);
      expect(fetch).not.toHaveBeenCalled();
      expect(result.headers.getSetCookie().join("\n")).toContain("__Host-two_oauth_state=; Max-Age=0");
      expect(result.headers.getSetCookie().join("\n")).not.toContain(`${SESSION_COOKIE}=`);
    },
  );

  it.each(["exchange", "user"] as const)("fails closed when Discord %s fails without echoing the response", async (step) => {
    const { env: e } = isolated();
    mockDiscord(step);
    const res = await signIn(e);
    expect(res.status).toBe(302);
    // Classification, not a blanket banner (TOG-10355): a 401 on the token
    // endpoint is OUR credentials being rejected (generic failure copy); a
    // 503 from the user endpoint is a Discord outage ("on Discord, not you").
    const notice = step === "exchange" ? "signin_failed" : "signin_unavailable";
    expect(res.headers.get("location")).toBe(`/?n=${notice}`);
    expect(await res.text()).not.toContain("untrusted-upstream-body");
    expect(res.headers.getSetCookie().join("\n")).not.toContain(`${SESSION_COOKIE}=`);
  });

  it.each([null, "Display Name"])("persists the Discord identity with display name %s", async (name) => {
    const { store, env: e } = isolated();
    mockDiscord(undefined, name);
    const res = await signIn(e);
    expect(await store.get(await hashToken(bearer(res)))).toEqual({
      userId: "42", username: name ?? "handle", avatar: "avatar-hash", member: true, moderator: false,
    });
  });

  it("still creates a non-member session when the auto-join transport fails", async () => {
    const { store, env: e } = isolated();
    mockDiscord("join");
    const res = await signIn(e);
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    expect(await store.get(await hashToken(bearer(res)))).toMatchObject({ member: false, moderator: false });
  });
});

describe("W15 moderator role configuration", () => {
  it.each([undefined, "", "SySOp", "123", "not-a-snowflake"])("fails closed for %s", (raw) => {
    expect(parseModeratorRoleIds(raw)).toEqual([]);
    expect(isModerator(["508654771276873729"], parseModeratorRoleIds(raw))).toBe(false);
  });

  it("parses multiple snowflakes with padding and a trailing comma, never granting by role name", () => {
    const ids = parseModeratorRoleIds(" 508654771276873729, 1078757544169848933, SySOp, ");
    expect(ids).toEqual(["508654771276873729", "1078757544169848933"]);
    expect(isModerator(["1078757544169848933"], ids)).toBe(true);
    expect(isModerator(["SySOp"], ids)).toBe(false);
  });
});

describe("W15 session lifetime, rotation and logout", () => {
  it("uses a host-only, HttpOnly, Lax, Secure opaque cookie for the recorded 30-day TTL divergence", async () => {
    const { env: e } = isolated();
    const res = await qaLogin(e);
    const cookie = sessionCookie(res);
    for (const flag of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL}`]) expect(cookie).toContain(flag);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(bearer(res)).toMatch(/^two_[A-Za-z0-9_-]{43}$/);
    expect(cookie).not.toContain("QA Member");
  });

  it("refreshes the full 30-day DB expiry on a read, invalidates the old token and expires at the exact boundary", async () => {
    let now = Date.parse("2026-09-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { store, env: e } = isolated();
    const writes: Date[] = [];
    const instrumented: SessionStore = {
      ...store,
      create: async (s) => { writes.push(s.expiresAt); await store.create(s); },
      rotate: async (old, s) => { writes.push(s.expiresAt); return store.rotate(old, s); },
    };
    const testEnv = { ...e, SESSION_STORE: instrumented } as Env;
    const login = await qaLogin(testEnv);
    expect(writes[0]!.getTime()).toBe(now + TTL * 1000);
    now += 29 * 24 * 60 * 60 * 1000;
    const view = await app.request("/", { headers: { cookie: cookies(login) } }, testEnv);
    expect(await view.text()).toContain("QA Member");
    expect(writes[1]!.getTime()).toBe(now + TTL * 1000);
    expect(await store.get(await hashToken(bearer(login)))).toBeNull();
    expect(sessionCookie(view)).toContain(`Max-Age=${TTL}`);
    now += TTL * 1000;
    const expired = await app.request("/", { headers: { cookie: cookies(view) } }, testEnv);
    expect(await expired.text()).toContain("Sign in with Discord");
    expect(expired.headers.getSetCookie()).toHaveLength(0);
  });

  it("a failed rotation returns a guest and never sets a replacement cookie", async () => {
    const { store, env: e } = isolated();
    const login = await qaLogin(e);
    const failing: SessionStore = { ...store, rotate: async () => { throw new Error("test store unavailable"); } };
    const res = await app.request("/", { headers: { cookie: cookies(login) } }, { ...e, SESSION_STORE: failing } as Env);
    expect(await res.text()).toContain("Sign in with Discord");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("two simultaneous reads have only one successful rotation of the same token", async () => {
    const { env: e } = isolated();
    const login = await qaLogin(e);
    const views = await Promise.all([0, 1].map(() => app.request("/", { headers: { cookie: cookies(login) } }, e)));
    expect(views.filter((r) => r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)))).toHaveLength(1);
    const html = await Promise.all(views.map((r) => r.text()));
    expect(html.filter((s) => s.includes("Sign in with Discord"))).toHaveLength(1);
  });

  it("GET logout cannot revoke; same-origin POST revokes and the old cookie cannot replay", async () => {
    const { store, env: e } = isolated();
    const login = await qaLogin(e);
    const hash = await hashToken(bearer(login));
    const get = await app.request("/logout", { headers: { cookie: cookies(login) } }, e);
    expect(get.status).toBe(404);
    expect(await store.get(hash)).not.toBeNull();
    const post = await app.request("/logout", { method: "POST", headers: { cookie: cookies(login), origin: e.APP_URL } }, e);
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/");
    expect(sessionCookie(post)).toContain("Max-Age=0");
    expect(await store.get(hash)).toBeNull();
    expect(await (await app.request("/", { headers: { cookie: cookies(login) } }, e)).text()).toContain("Sign in with Discord");
  });

  it("a foreign-origin POST refuses without revoking the valid row", async () => {
    const { store, env: e } = isolated();
    const login = await qaLogin(e);
    const result = await app.request("/logout", { method: "POST", headers: { cookie: cookies(login), origin: "https://foreign.test" } }, e);
    expect(result.status).toBe(403);
    expect(await store.get(await hashToken(bearer(login)))).not.toBeNull();
  });

  it("guest logout is idempotent", async () => {
    const { env: e } = isolated();
    for (let i = 0; i < 2; i++) expect((await app.request("/logout", { method: "POST", headers: { origin: e.APP_URL } }, e)).status).toBe(303);
  });
});

describe("W15 staging-only QA login (deliberate POST divergence)", () => {
  it.each([undefined, ""])("fails closed for a missing/blank configured token %s", async (token) => {
    const { env: e } = isolated();
    expect((await qaLogin({ ...e, QA_AUTH_TOKEN: token })).status).toBe(404);
  });

  it.each(["https://togetherweown.com", "https://next.togetherweown.com.attacker.test", "http://next.togetherweown.com"])(
    "is absent for APP_URL %s", async (url) => {
      const { env: e } = isolated();
      const res = await qaLogin({ ...e, APP_URL: url });
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    },
  );

  it("rejects the legacy GET without issuing a session", async () => {
    const { env: e } = isolated();
    const res = await app.request("/auth/qa/qa-member", { headers: { [QA_HEADER]: env.QA_AUTH_TOKEN! } }, e);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("missing token, wrong token and unknown identity return the same 404 with no session or Discord call", async () => {
    const { env: e } = isolated();
    const fetch = mockDiscord();
    const responses = await Promise.all([
      app.request("/auth/qa/qa-member", { method: "POST", headers: { origin: e.APP_URL } }, e),
      qaLogin(e, "qa-member", { [QA_HEADER]: "wrong-test-token" }),
      qaLogin(e, "not-a-fixture"),
    ]);
    for (const res of responses) { expect(res.status).toBe(404); expect(res.headers.getSetCookie()).toHaveLength(0); }
    expect(new Set(await Promise.all(responses.map((r) => r.text()))).size).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(Object.entries(QA_IDENTITIES))("issues a normal member session for %s without contacting Discord", async (identity, fixture) => {
    const { store, env: e } = isolated();
    const fetch = mockDiscord();
    const res = await qaLogin(e, identity);
    expect(res.status).toBe(204);
    expect(await store.get(await hashToken(bearer(res)))).toEqual({
      userId: fixture.discordId, username: fixture.username, avatar: null, member: true, moderator: fixture.moderator,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
