// Pin: a released Kit admin 404 slides the session like Hono (the guard
// attaches on 404s when the bearer survives rendering; src/admin/guard.ts).
// Companion to the Test Author acceptance in
// test/kit-admin-session-renewal.test.ts, which pins the 200, bounce,
// refusal, redirect and non-HTML outcomes.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import { kitAdminRenewalFor, kitSessionBridge } from "../src/kit-session";
import {
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from "../src/sessions";
import { env as baseEnv } from "./helpers/member-data";

const APP_URL = "https://next.example.test";
const HOST = "next.example.test";
const SECRET = "kit-admin-renewal-404-test-secret!";
const MOD_ID = "100000000000000111";
const DETAIL_PATH = "/admin/join-attempts/42";

async function mintModerator(store: SessionStore): Promise<{ cookie: string; token: string }> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: MOD_ID,
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { cookie, token };
}

describe("released Kit admin 404s slide the session", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("renews the current bearer on a 404 HTML admin document", async () => {
    const store = createMemorySessionStore();
    const env = { ...baseEnv, SESSION_SECRET: SECRET, SESSION_STORE: store } as Env;
    const entries: AccessEntry[] = [];
    const renewCalls: string[] = [];
    const rawRenew = store.renew.bind(store);
    store.renew = (async (tokenHash: string, expiresAt: Date) => {
      renewCalls.push(tokenHash);
      return rawRenew(tokenHash, expiresAt);
    }) as SessionStore["renew"];
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      sessionFor: kitSessionBridge(env),
      adminRenewalFor: kitAdminRenewalFor(env),
      accessSink: async () => async (entry: AccessEntry) => {
        entries.push(entry);
        return true;
      },
      // Missing-record 404, answered before any record lookup (like the
      // canonical-ID admission 404 in the real detail load): no member read,
      // no audit row, but the released document still slides the bearer.
      resolve: async () =>
        new Response("<main><h1>Join attempt not found</h1></main>", {
          status: 404,
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
    };
    const { cookie, token } = await mintModerator(store);
    const request = new Request(new URL(DETAIL_PATH, APP_URL).href, {
      headers: { host: HOST, cookie },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin/join-attempts/[id]" },
    };

    const res = await dispatchHookRequest(event, deps);

    expect(res.status).toBe(404);
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    const sets = res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.toLowerCase()).toContain(`max-age=${SESSION_TTL_SECONDS}`);
    // Slide, not rotate: the renewal re-signs the presented bearer.
    const value = sets[0]!.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
    expect(value.slice(0, value.lastIndexOf("."))).toBe(token);
    expect(renewCalls).toHaveLength(1);
    expect(renewCalls[0]).toBe(await hashToken(token));
    expect(entries).toHaveLength(0);
  });
});
