// Pin: a released Kit admin 404 ROTATES the session like Hono (the guard
// attaches its replacement on 404s when the bearer survives rendering;
// src/admin/guard.ts). Companion to the Test Author acceptance in
// test/kit-admin-session-renewal.test.ts, which pins the 200, bounce,
// refusal, redirect and non-HTML outcomes. This file supersedes the slide
// pin that preceded it: the 404 renewal signs a NEW bearer through
// rotate(), never renew(), and the presented bearer becomes
// predecessor-only. Failing-first on the slide head, where the cookie
// re-signs the presented bearer.
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
  isValidSessionToken,
  newSessionToken,
  SESSION_PREDECESSOR_GRACE_SECONDS,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from "../src/sessions";
import { env as baseEnv } from "./helpers/member-data";

const APP_URL = "https://next.example.test";
const HOST = "next.example.test";
const SECRET = "kit-admin-renewal-404-test-secret!";
const MOD_ID = "100000000000000111";
const MEMBER_ID = "100000000000000222";
const DETAIL_PATH = "/admin/join-attempts/42";

async function mint(
  store: SessionStore,
  actor: { userId: string; username: string; moderator: boolean },
): Promise<{ cookie: string; token: string }> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: true,
    moderator: actor.moderator,
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

function harness404() {
  // Controllable clock so the replay test can cross the grace deadline.
  let now = Date.now();
  const store = createMemorySessionStore(() => now);
  const env = { ...baseEnv, SESSION_SECRET: SECRET, SESSION_STORE: store } as Env;
  const entries: AccessEntry[] = [];
  const rotateCalls: {
    oldHash: string;
    replacement: Parameters<SessionStore["rotate"]>[1];
  }[] = [];
  const rawRotate = store.rotate.bind(store);
  store.rotate = (async (oldHash: string, replacement: Parameters<SessionStore["rotate"]>[1]) => {
    rotateCalls.push({ oldHash, replacement });
    return rawRotate(oldHash, replacement);
  }) as SessionStore["rotate"];
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
    // no audit row, but the released document still rotates the bearer.
    resolve: async () =>
      new Response("<main><h1>Join attempt not found</h1></main>", {
        status: 404,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
  };
  const eventFor = (cookie: string | null): HookEventLike => {
    const request = new Request(new URL(DETAIL_PATH, APP_URL).href, {
      headers: { host: HOST, ...(cookie ? { cookie } : {}) },
    });
    return { request, url: new URL(request.url), route: { id: "/admin/join-attempts/[id]" } };
  };
  return {
    advanceTime: (ms: number) => {
      now += ms;
    },
    deps,
    entries,
    eventFor,
    renewCalls,
    rotateCalls,
    store,
  };
}

const sessionSets = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));

function bearerOfSetCookie(setCookie: string): string {
  const value = setCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
  return value.slice(0, value.lastIndexOf("."));
}

describe("released Kit admin 404s rotate the session", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rotates the current bearer on a 404 HTML admin document: fresh token, predecessor-only old bearer", async () => {
    const h = harness404();
    const { cookie, token } = await mint(h.store, {
      userId: MOD_ID,
      username: "mod",
      moderator: true,
    });
    const tokenHash = await hashToken(token);
    const lineage = await h.store.statusHash(tokenHash);
    expect(lineage).not.toBeNull();

    const res = await dispatchHookRequest(h.eventFor(cookie), h.deps);

    expect(res.status).toBe(404);
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    expect(await res.clone().text()).toContain("Join attempt not found");
    const sets = sessionSets(res);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.toLowerCase()).toContain(`max-age=${SESSION_TTL_SECONDS}`);
    // Rotate, not slide: the 404 renewal signs a NEW bearer.
    const replacement = bearerOfSetCookie(sets[0]!);
    expect(replacement, "the 404 must mint a fresh bearer").not.toBe(token);
    expect(isValidSessionToken(replacement)).toBe(true);
    const successorHash = await hashToken(replacement);
    expect(h.rotateCalls).toHaveLength(1);
    expect(h.rotateCalls[0]!.oldHash).toBe(tokenHash);
    expect(h.rotateCalls[0]!.replacement.tokenHash).toBe(successorHash);
    expect(h.rotateCalls[0]!.replacement).toMatchObject({
      userId: MOD_ID,
      username: "mod",
      avatar: null,
      member: true,
      moderator: true,
    });
    expect(h.renewCalls, "the 404 must rotate, never slide").toEqual([]);
    // The presented bearer is predecessor-only; the successor is current
    // and keeps the lineage key. The 404 itself writes no audit row.
    expect(await h.store.statusHash(tokenHash)).toBeNull();
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.get(successorHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(successorHash)).toBe(lineage);
    expect(h.entries).toHaveLength(0);
  });

  it("replaying the bearer a 404 rotated out follows predecessor grace: in-grace renders without rotating, post-grace does not rotate", async () => {
    const h = harness404();
    const { cookie, token } = await mint(h.store, {
      userId: MOD_ID,
      username: "mod",
      moderator: true,
    });

    const first = await dispatchHookRequest(h.eventFor(cookie), h.deps);
    expect(first.status).toBe(404);
    expect(sessionSets(first)).toHaveLength(1);
    expect(bearerOfSetCookie(sessionSets(first)[0]!)).not.toBe(token);
    expect(h.rotateCalls).toHaveLength(1);

    // In-grace replay of the retired bearer: the released 404 still
    // stands, but a grace read never rotates — no second rotate call,
    // no cookie, no sibling minted for the old tab.
    h.advanceTime((SESSION_PREDECESSOR_GRACE_SECONDS - 2) * 1000);
    const replay = await dispatchHookRequest(h.eventFor(cookie), h.deps);
    expect(replay.status).toBe(404);
    expect(sessionSets(replay)).toEqual([]);
    expect(h.rotateCalls, "a grace read attempts no rotation").toHaveLength(1);
    expect(h.renewCalls).toEqual([]);

    // Past the fixed grace deadline the retired bearer is no longer
    // current, so the replay still rotates nothing and sets no cookie.
    h.advanceTime(3000);
    const late = await dispatchHookRequest(h.eventFor(cookie), h.deps);
    expect(late.status).toBe(404);
    expect(sessionSets(late)).toEqual([]);
    expect(h.rotateCalls).toHaveLength(1);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).toBeNull();
  });

  it("a lost rotation race on a 404 sets no cookie and leaves the old row live", async () => {
    const h = harness404();
    const { cookie, token } = await mint(h.store, {
      userId: MOD_ID,
      username: "mod",
      moderator: true,
    });
    const tokenHash = await hashToken(token);
    h.store.rotate = (async () => false) as SessionStore["rotate"];

    const res = await dispatchHookRequest(h.eventFor(cookie), h.deps);

    expect(res.status).toBe(404);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls, "a lost race must not fall back to sliding").toEqual([]);
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
  });

  it("a rotation store failure on a 404 sets no cookie, keeps the old row live, and warns once", async () => {
    const h = harness404();
    const { cookie, token } = await mint(h.store, {
      userId: MOD_ID,
      username: "mod",
      moderator: true,
    });
    const tokenHash = await hashToken(token);
    h.store.rotate = (async () => {
      throw new Error("rotation store down");
    }) as SessionStore["rotate"];

    const res = await dispatchHookRequest(h.eventFor(cookie), h.deps);

    expect(res.status).toBe(404);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    const warned = vi
      .mocked(console.warn)
      .mock.calls.map((args) => JSON.stringify(args))
      .join("\n");
    for (const leak of [token, cookie, SECRET]) {
      expect(warned).not.toContain(leak);
    }
  });

  it("a non-moderator and an anonymous 404 do zero store writes", async () => {
    const h = harness404();
    const member = await mint(h.store, {
      userId: MEMBER_ID,
      username: "member",
      moderator: false,
    });
    const memberHash = await hashToken(member.token);
    const writes: string[] = [];
    for (const method of ["create", "replace", "rotate", "renew"] as const) {
      const original = h.store[method].bind(h.store);
      h.store[method] = (async (...args: never[]) => {
        writes.push(method);
        return (original as (...a: never[]) => Promise<unknown>)(...args);
      }) as never;
    }

    const refused = await dispatchHookRequest(h.eventFor(member.cookie), h.deps);
    expect(refused.status).toBe(404);
    expect(sessionSets(refused)).toEqual([]);
    const anon = await dispatchHookRequest(h.eventFor(null), h.deps);
    expect(anon.status).toBe(404);
    expect(sessionSets(anon)).toEqual([]);

    expect(writes, "non-moderator/anonymous reads write nothing").toEqual([]);
    expect(h.rotateCalls).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    // The member's row is untouched as its own current bearer.
    expect(await h.store.get(memberHash)).not.toBeNull();
    expect(await h.store.statusHash(memberHash)).toBe(memberHash);
  });
});
