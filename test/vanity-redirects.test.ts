// route-inventory: GET /login
// route-inventory: GET /community

import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

function fixture() {
  const store = createMemorySessionStore();
  const dbRead = vi.fn();
  const refuseDb = () => {
    dbRead();
    throw new Error("vanity alias must not read a database binding");
  };
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
    get DB() {
      return refuseDb();
    },
    get DATABASE_URL() {
      return refuseDb();
    },
  } satisfies Env & { SESSION_STORE: SessionStore };
  return { env, dbRead };
}

const request = (path: string, env: Env, init: RequestInit = {}) =>
  app.request(`${APP_URL}${path}`, init, env);

describe("vanity aliases (local fixtures, no DB)", () => {
  it.each(["GET", "HEAD"])("%s /login 302s to the OAuth start without cookies", async (method) => {
    const { env, dbRead } = fixture();
    const res = await request("/login", env, { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    if (method === "HEAD") expect(await res.text()).toBe("");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("preserves only a safe next on /login and drops everything else", async () => {
    const { env, dbRead } = fixture();
    const safe = await request("/login?next=%2Fevents", env);
    expect(safe.status).toBe(302);
    expect(safe.headers.get("location")).toBe("/auth/discord?next=%2Fevents");
    const hostile = await request("/login?next=%2F%2Fevil&token=discard", env);
    expect(hostile.status).toBe(302);
    expect(hostile.headers.get("location")).toBe("/auth/discord");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("%s /community 302s to the lobby and drops queries", async (method) => {
    const { env, dbRead } = fixture();
    const res = await request("/community?utm_source=old-site", env, { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    if (method === "HEAD") expect(await res.text()).toBe("");
    expect(dbRead).not.toHaveBeenCalled();
  });
});
