// Admin gate matrix (TOG-12445): pins src/admin/guard.ts's four outcomes
// through the documented override seams — proof first, no guard edits,
// memory store only, no DB. Guest → bounceToLogin with url.intended
// preserved; signed non-moderator → 403 (never a login loop); resolve
// failure → 503 fail-closed; moderator → handler with `private, no-store`.
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { LOGIN_INTENDED_COOKIE } from "../src/return-journey";
import type { Env } from "../src/env";
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

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const MEMBER = { userId: "100000000000000222", username: "pleb", moderator: false };

/** The signed intended cookie pair a response set, if any. */
function intendedPair(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(`${LOGIN_INTENDED_COOKIE}=`)) return c.split(";")[0]!;
  }
  return null;
}

/** Verify-decode a bounce's intended cookie through the same secret. */
async function intendedValue(pair: string): Promise<string | false> {
  const decoded = await parseSigned(pair, SESSION_SECRET, LOGIN_INTENDED_COOKIE);
  return decoded[LOGIN_INTENDED_COOKIE] ?? "MISSING";
}

/** A store that fails resolution, so the guard must refuse to decide. */
function failingStore(): SessionStore {
  return {
    ...createMemorySessionStore(),
    get: async () => {
      throw new Error("session store down");
    },
  };
}

describe("admin guard matrix (override seams, no DB)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guest bounces to OAuth with the intended page preserved", async () => {
    const res = await adminApp(createMemorySessionStore()).request("/events?status=draft", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    const pair = intendedPair(res);
    expect(pair).toBeTruthy();
    expect(await intendedValue(pair!)).toBe("/events?status=draft");
  });

  it("signed non-moderator gets 403, never a login loop", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    const res = await adminApp(store).request("/events", { headers: { cookie } }, env);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Forbidden");
    expect(res.headers.get("location")).toBeNull();
    expect(intendedPair(res)).toBeNull();
  });

  it("session resolve failure fails closed to 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = createMemorySessionStore();
    const cookie = await cookieFor(seed, MOD);
    const res = await adminApp({ sessionStore: failingStore() }).request(
      "/events",
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Admin temporarily unavailable");
  });

  it("moderator passes with private, no-store", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain("mod");
  });
});
