// route-inventory: GET /admin/events/create
// route-inventory: GET /admin/events/:key/edit
// route-inventory: GET /admin/featured-contents
// route-inventory: GET /admin/featured-contents/create
// route-inventory: GET /admin/featured-contents/:id/edit
// route-inventory: GET /auth/discord/redirect

import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const aliases = [
  ["/admin/events/create", "/admin/events/new"],
  ["/admin/events/game-night/edit", "/admin/events/game-night"],
  ["/admin/featured-contents", "/admin/featured"],
  ["/admin/featured-contents/create", "/admin/featured/new"],
  ["/admin/featured-contents/42/edit", "/admin/featured/42"],
] as const;

function fixture() {
  const store = createMemorySessionStore();
  const dbRead = vi.fn(() => { throw new Error("redirect must not read a database binding"); });
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
    get DB() { return dbRead(); },
    get DATABASE_URL() { return dbRead(); },
    get ADMIN_DB() { return dbRead(); },
  } satisfies Env & { SESSION_STORE: SessionStore; ADMIN_DB: never };
  return { store, env, dbRead };
}

async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "111",
    username: "fixture-member",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

const request = (path: string, env: Env, init: RequestInit = {}) => app.request(`${APP_URL}${path}`, init, env);

describe("legacy admin redirects (local fixtures, no DB)", () => {
  it.each(aliases)("301s %s after the moderator guard and drops every query", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const res = await request(`${alias}?next=%2Fevents&filter=published&token=discard`, env, { headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(target);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases)("keeps HEAD %s guarded with the same redirect", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const res = await request(alias, env, { method: "HEAD", headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(target);
    expect(await res.text()).toBe("");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases)("sends guests at %s to the same OAuth target as the canonical URL", async (alias, target) => {
    const { env, dbRead } = fixture();
    for (const path of [alias, target]) {
      const res = await request(`${path}?next=%2F%2Fevil`, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    }
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases)("403s a non-moderator at %s and at its canonical URL", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, false);
    for (const path of [alias, target]) {
      const res = await request(path, env, { headers: { cookie } });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(res.headers.get("location")).toBeNull();
    }
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["events", "featured-contents"])("keeps encoded %s parameters in one target segment", async (resource) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const segment = "odd%2Fkey%3Fquery%23fragment%25";
    const res = await request(`/admin/${resource}/${segment}/edit?drop=1`, env, { headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/admin/${resource === "events" ? "events" : "featured"}/${segment}`);
    expect(dbRead).not.toHaveBeenCalled();
  });
});

describe("legacy login redirect (local fixtures, no DB)", () => {
  it.each(["GET", "HEAD"])("%s defaults to /auth/discord, dropping arbitrary OAuth/query input", async (method) => {
    const { env, dbRead } = fixture();
    const res = await request("/auth/discord/redirect?state=untrusted&code=discard&redirect_uri=https%3A%2F%2Fevil", env, { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["/", "/events", "/e/game-night?source=discord&tab=details#rsvp"])("preserves only the guarded next %s", async (next) => {
    const { env, dbRead } = fixture();
    const query = new URLSearchParams({ next, state: "discard", source: "discard" });
    const res = await request(`/auth/discord/redirect?${query}`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/discord?${new URLSearchParams({ next })}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["//evil", "https://evil.test", "javascript:alert(1)", "/\\evil", "relative", "/events\r\nLocation:https://evil.test", "/ events", ""])("drops invalid next %j and lands on the default target", async (next) => {
    const { env, dbRead } = fixture();
    const res = await request(`/auth/discord/redirect?${new URLSearchParams({ next })}`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });
});
