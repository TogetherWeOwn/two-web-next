// Acceptance contract: a released successful Kit admin GET document slides the
// moderator's session — the post-release twin of Hono's admin-guard re-stamp
// (src/admin/guard.ts: a current bearer re-stamps the 120-minute window,
// grace reads never refresh cookies, and bounces/refusals/redirects omit the
// cookie), wired at the same post-response position as the event-detail
// renewal in dispatchHookRequest. The Kit guard itself stays read-only
// (src/admin/kit-guard.ts: never rotates, never sets cookies); renewal runs
// only after the member-read boundary releases the response, never inside it.
//
// Slide, not rotate. Hono admin reads rotate since the profile/admin re-stamp;
// this Kit twin still slides until its own rotation lands. The event-detail
// helper is the precedent for position and failure posture only (post-release,
// class-only warn, lost race resolves to no cookie), not for minting a
// replacement bearer: the renewal cookie re-signs the PRESENTED bearer with a
// fresh Max-Age, and the store call is renew(), never rotate().
//
// Seam the Builder adds (names are the contract; this file compiles before
// they land and fails granularly until they do):
// - src/kit-session.ts: kitAdminRenewalFor(env) -> (event) => Promise<string | null>
//   (same shape as kitEventDetailRotationFor: re-verify the bearer, gate on a
//   current bearer via statusHash, renew() the row, re-sign the SAME token
//   with inline `maxAge: SESSION_TTL_SECONDS` so the pinned-lifetime guard
//   keeps reading it from the call).
// - src/route-ownership.ts: HookDispatchDeps.adminRenewalFor plus a released
//   successful-GET-document gate (admin family, GET, 200, text/html,
//   authenticated moderator), applied post-release like the event-detail gate.
// - docs/moderator-admin-guide.md: the session/expiry section ("A moderator
//   lost their role") states Kit admin renewal parity.
//
// These tests drive the real boundaries a fix must sit behind — the real
// session bridge (kitSessionBridge), the real probe helper
// (kitAuthStatusCookieFor) and the real hook core (dispatchHookRequest) —
// with the shipped join-attempts pair (already Kit-enabled) plus an
// override-enabled future admin path. Hermetic: synthetic signed cookies, a
// memory session store, fake admin resolves, no DB/OAuth.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import * as KitSession from "../src/kit-session";
import {
  kitAuthStatusCookieFor,
  kitSessionBridge,
  type KitLocals,
  type KitRequestSession,
} from "../src/kit-session";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
  type OwnedRoute,
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
const SECRET = "kit-admin-renewal-test-secret-32bytes!";
const MOD_ID = "100000000000000111";
const MEMBER_ID = "100000000000000222";
const SUBJECT = "100000000000000333";
const REFUSAL = "Member data is temporarily unavailable.";
const LIST_PATH = "/admin/join-attempts";
const DETAIL_PATH = "/admin/join-attempts/42";
const ADMIN_MARKER = "join-attempts-audit-list";

const MODERATOR = { userId: MOD_ID, username: "mod", member: true, moderator: true };
const MEMBER = { userId: MEMBER_ID, username: "member", member: true, moderator: false };

type AdminRenewalFactory = (env: Env) => (event: HookEventLike) => Promise<string | null>;
// Omit keeps this compiling both before the Builder lands the dep field and
// after (no intersection with a same-named field either way).
type RenewalDeps = Omit<HookDispatchDeps, "adminRenewalFor"> & {
  adminRenewalFor?: (event: HookEventLike) => Promise<string | null>;
};

/**
 * The Builder's seam: kitAdminRenewalFor(env) in src/kit-session.ts. Read
 * through the module namespace (typed locally, like
 * test/session-renew-acceptance.ts) so this file compiles before the export
 * lands; every renewal test then fails with this named message until it does.
 */
function adminRenewalFor(env: Env): (event: HookEventLike) => Promise<string | null> {
  const factory = (KitSession as unknown as { kitAdminRenewalFor?: unknown }).kitAdminRenewalFor;
  expect(
    factory,
    "seam missing: Builder adds kitAdminRenewalFor(env) to src/kit-session.ts (see file header)",
  ).toBeTypeOf("function");
  return (factory as AdminRenewalFactory)(env);
}

type AdminVariant = "auto" | "outage503" | "redirect" | "json";

/** SvelteKit-converted admin outcomes, branching on the bridged locals. */
async function adminResolve(event: HookEventLike, variant: AdminVariant): Promise<Response> {
  const locals = event.locals as Partial<KitLocals> | undefined;
  const signedIn = locals?.status === "authenticated";
  const moderator = signedIn && locals?.session?.moderator === true;
  if (variant === "redirect" && signedIn) {
    return new Response(null, {
      status: 302,
      headers: { location: "/admin/join-attempts?page=2" },
    });
  }
  if (variant === "outage503") {
    return new Response("Admin temporarily unavailable", {
      status: 503,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  }
  if (variant === "json" && moderator) {
    return Response.json({ attempts: [] });
  }
  if (!signedIn) {
    if (locals?.status === "unknown") {
      return new Response(REFUSAL, {
        status: 503,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { location: `/auth/discord?next=${encodeURIComponent(event.url.pathname)}` },
    });
  }
  if (!moderator) {
    return new Response("Forbidden", { status: 403 });
  }
  // Moderator document: the keyed audit-list read the member-read boundary
  // classifies and audits, like listJoinAttempts in the real load.
  await keyedMemberRead(async () => {
    memberQueryPermit();
    declareMemberResult([SUBJECT]);
    return [{ id: 42 }];
  });
  const html = `<main><h1>${ADMIN_MARKER}</h1></main>`;
  return new Response(event.request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
}

type HarnessOptions = {
  path?: string;
  routeId?: string;
  variant?: AdminVariant;
  manifest?: OwnedRoute[];
  probe?: boolean;
  renewal?: boolean;
  sink?: (entry: AccessEntry) => Promise<boolean>;
};

function harness(options: HarnessOptions = {}) {
  const {
    path = LIST_PATH,
    routeId = "/admin/join-attempts",
    variant = "auto",
    probe = false,
    renewal = true,
  } = options;
  // Controllable clock: the store reads grace and expiry through it, so tests
  // advance past SESSION_PREDECESSOR_GRACE_SECONDS without real waiting.
  let now = Date.now();
  const store = createMemorySessionStore(() => now);
  const advanceTime = (ms: number) => {
    now += ms;
  };
  const nowMs = () => now;
  const env = { ...baseEnv, SESSION_SECRET: SECRET, SESSION_STORE: store } as Env;
  const entries: AccessEntry[] = [];
  const events: string[] = [];
  const renewCalls: { tokenHash: string; expiresAt: Date }[] = [];
  const rawRenew = store.renew.bind(store);
  store.renew = (async (tokenHash: string, expiresAt: Date) => {
    events.push("renew");
    renewCalls.push({ tokenHash, expiresAt });
    return rawRenew(tokenHash, expiresAt);
  }) as SessionStore["renew"];
  const honoFetch = vi.fn(async () => new Response("hono"));
  const deps: RenewalDeps = {
    appUrl: APP_URL,
    honoFetch,
    manifest: options.manifest,
    sessionFor: kitSessionBridge(env),
    ...(renewal ? { adminRenewalFor: adminRenewalFor(env) } : {}),
    ...(probe ? { authStatusCookieFor: kitAuthStatusCookieFor(env) } : {}),
    accessSink: async () =>
      options.sink ??
      (async (entry: AccessEntry) => {
        entries.push(entry);
        events.push("audit");
        return true;
      }),
    resolve: async (event) => {
      const response = await adminResolve(event, variant);
      events.push("resolve");
      return response;
    },
  };
  return {
    advanceTime,
    nowMs,
    deps,
    entries,
    env,
    events,
    honoFetch,
    renewCalls,
    store,
    path,
    routeId,
  };
}

const eventFor = (
  path: string,
  routeId: string,
  cookie: string | null,
  method = "GET",
  extraHeaders: Record<string, string> = {},
): HookEventLike => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...extraHeaders },
  });
  return { request, url: new URL(request.url), route: { id: routeId } };
};

async function mint(
  store: SessionStore,
  actor: { userId: string; username: string; member: boolean; moderator: boolean },
  secret: string = SECRET,
  expiresAt: Date = new Date(Date.now() + 3600_000),
): Promise<{ cookie: string; token: string }> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt,
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { cookie, token };
}

const sessionSets = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
const probeSets = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${AUTH_STATUS_COOKIE}=`));

function bearerOfSetCookie(setCookie: string): string {
  const value = setCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
  return value.slice(0, value.lastIndexOf("."));
}

/** The slide pin: the renewal cookie re-signs the PRESENTED bearer — never a replacement. */
function expectSlideCookie(res: Response, priorToken: string): void {
  const sets = sessionSets(res);
  expect(sets).toHaveLength(1);
  const parts = sets[0]!.split(";").map((p) => p.trim().toLowerCase());
  expect(parts).toContain("path=/");
  expect(parts).toContain("secure");
  expect(parts).toContain("httponly");
  expect(parts).toContain("samesite=lax");
  expect(parts).toContain(`max-age=${SESSION_TTL_SECONDS}`);
  expect(bearerOfSetCookie(sets[0]!)).toBe(priorToken);
  expect(isValidSessionToken(bearerOfSetCookie(sets[0]!))).toBe(true);
}

function spyWrites(store: SessionStore) {
  const calls: string[] = [];
  for (const method of ["create", "replace", "rotate", "renew"] as const) {
    const original = store[method].bind(store);
    store[method] = (async (...args: never[]) => {
      calls.push(method);
      return (original as (...a: never[]) => Promise<unknown>)(...args);
    }) as never;
  }
  return calls;
}

function moderatorLocals(): KitRequestSession {
  return {
    status: "authenticated",
    session: { userId: MOD_ID, username: "mod", avatar: null, member: true, moderator: true },
  };
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("released Kit admin GET documents slide the session", () => {
  it.each([
    { path: LIST_PATH, routeId: "/admin/join-attempts" },
    { path: DETAIL_PATH, routeId: "/admin/join-attempts/[id]" },
  ])(
    "renews the current bearer on GET $path: same cookie re-signed, window re-stamped",
    async ({ path, routeId }) => {
      const h = harness({ path, routeId });
      const { cookie, token } = await mint(h.store, MODERATOR);
      const tokenHash = await hashToken(token);
      const statusBefore = await h.store.statusHash(tokenHash);
      expect(statusBefore).not.toBeNull();
      const rotate = vi.spyOn(h.store, "rotate");
      const replace = vi.spyOn(h.store, "replace");
      const create = vi.spyOn(h.store, "create");

      const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-two-renderer")).toBe("kit");
      expect(await res.clone().text()).toContain(ADMIN_MARKER);
      expectSlideCookie(res, token);
      // Renewal runs after the boundary releases: resolve, then audit, then renew.
      expect(h.events).toEqual(["resolve", "audit", "renew"]);
      expect(h.renewCalls).toHaveLength(1);
      const call = h.renewCalls[0]!;
      expect(call.tokenHash).toBe(tokenHash);
      // Re-stamped from request time with the full 120-minute window.
      const now = Date.now();
      expect(call.expiresAt.getTime()).toBeGreaterThanOrEqual(
        now + SESSION_TTL_SECONDS * 1000 - 60_000,
      );
      expect(call.expiresAt.getTime()).toBeLessThanOrEqual(
        now + SESSION_TTL_SECONDS * 1000 + 60_000,
      );
      // Slide, not rotate: lineage kept, no replacement minted.
      expect(await h.store.statusHash(tokenHash)).toBe(statusBefore);
      expect(rotate).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      // The audit still ran: one row naming the moderator viewer and the subject.
      expect(h.entries).toHaveLength(1);
      const entry = h.entries[0]!;
      expect(entry).toMatchObject({ viewerDiscordId: MOD_ID });
      expect(JSON.stringify(entry)).toContain(SUBJECT);
      // The slid row outlives its original 1-hour mint, then dies at the new stamp.
      h.advanceTime(3600_000 + 5000);
      expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
      h.advanceTime(3600_000 + 5000);
      expect(await h.store.get(tokenHash)).toBeNull();
    },
  );

  it("signs the slid cookie with the session secret Hono verifies", async () => {
    const h = harness();
    const { cookie } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    const verified = await parseSigned(sessionSets(res)[0]!, SECRET);
    expect(isValidSessionToken(verified[SESSION_COOKIE])).toBe(true);
  });

  it("grace then bounce: an in-grace replay renders without renewal, a post-grace replay bounces", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);

    const first = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(first.status).toBe(200);
    expectSlideCookie(first, token);
    expect(h.renewCalls).toHaveLength(1);

    // Another tab rotates: the presented bearer is now a predecessor in grace.
    const successor = newSessionToken();
    const successorHash = await hashToken(successor);
    const rotateAt = h.nowMs();
    expect(
      await h.store.rotate(tokenHash, {
        tokenHash: successorHash,
        userId: MOD_ID,
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(rotateAt + SESSION_TTL_SECONDS * 1000),
      }),
    ).toBe(true);
    expect(await h.store.statusHash(tokenHash)).toBeNull();
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });

    // Inside grace the retired bearer still renders the moderator document,
    // but the replay itself renews nothing: no renew call at all (Hono gates
    // on statusHash first), no cookie, no sibling.
    const replay = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(replay.status).toBe(200);
    expect(await replay.clone().text()).toContain(ADMIN_MARKER);
    expect(sessionSets(replay)).toEqual([]);
    expect(h.renewCalls).toHaveLength(1);

    h.advanceTime((SESSION_PREDECESSOR_GRACE_SECONDS + 1) * 1000);
    const bounced = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toContain("/auth/discord");
    expect(sessionSets(bounced)).toEqual([]);
    expect(h.renewCalls).toHaveLength(1);

    // The grace read must not renew the live successor on the old tab's behalf.
    h.advanceTime(rotateAt + SESSION_TTL_SECONDS * 1000 - 1000 - h.nowMs());
    expect(await h.store.get(successorHash)).toMatchObject({ userId: MOD_ID });
    h.advanceTime(1000);
    expect(await h.store.get(successorHash)).toBeNull();
  });

  it("a signed-in non-moderator 403 never renews (unlike the event-detail draft 403)", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MEMBER);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(403);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("anonymous, refused and non-document reads never renew", () => {
  it("anonymous reads bounce without cookies or session writes", async () => {
    const h = harness();
    const writes = spyWrites(h.store);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, null), h.deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
    expect(sessionSets(res)).toEqual([]);
    expect(writes).toEqual([]);
    expect(h.renewCalls).toEqual([]);
  });

  it.each(["tampered signature", "unknown token", "expired row"] as const)(
    "a %s bounces without renewal",
    async (kind) => {
      const h = harness();
      let cookie: string;
      if (kind === "tampered signature") {
        cookie = (await mint(h.store, MODERATOR, "wrong-secret")).cookie;
      } else if (kind === "unknown token") {
        const token = newSessionToken();
        cookie = (
          await serializeSigned(SESSION_COOKIE, token, SECRET, { path: "/", secure: true })
        ).split(";")[0]!;
      } else {
        cookie = (await mint(h.store, MODERATOR, SECRET, new Date(Date.now() - 1000))).cookie;
      }
      // Installed after setup: minting above is the fixture, not the read.
      const writes = spyWrites(h.store);
      const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
      expect(res.status).toBe(302);
      expect(sessionSets(res)).toEqual([]);
      expect(writes).toEqual([]);
      expect(h.renewCalls).toEqual([]);
    },
  );

  it("a refused audit keeps the 503 refusal and the live bearer: renewal never runs inside the boundary", async () => {
    const h = harness({ sink: async () => false });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toBe(REFUSAL);
    expect(sessionSets(res)).toEqual([]);
    // The boundary refused before any renewal could run: zero renew calls,
    // and the presented bearer is still live for the retry.
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a load outage 503 never renews", async () => {
    const h = harness({ variant: "outage503" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toBe("Admin temporarily unavailable");
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a session-store outage 503 never renews", async () => {
    const h = harness();
    const { cookie } = await mint(h.store, MODERATOR);
    h.store.get = (async () => {
      throw new Error("session store down");
    }) as SessionStore["get"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
  });

  it("a redirect never renews", async () => {
    const h = harness({ variant: "redirect" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/join-attempts?page=2");
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("HEAD reads do not renew", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie, "HEAD"), h.deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a non-HTML 200 does not renew", async () => {
    const h = harness({ variant: "json" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("POST stays Hono-owned: the Kit renewal path never sees it", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const writes = spyWrites(h.store);
    const res = await dispatchHookRequest(
      eventFor(h.path, h.routeId, cookie, "POST", { origin: APP_URL }),
      h.deps,
    );
    expect(h.honoFetch).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("hono");
    expect(sessionSets(res)).toEqual([]);
    expect(writes).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("renewal races stay safe", () => {
  it("a lost renewal race still delivers the released 200 without a cookie", async () => {
    const h = harness();
    const { cookie } = await mint(h.store, MODERATOR);
    h.store.renew = (async () => false) as SessionStore["renew"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain(ADMIN_MARKER);
    expect(sessionSets(res)).toEqual([]);
  });

  it("a renewal store error delivers the released 200 without renewal: fail-open with a class-only warn", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    h.store.renew = (async () => {
      throw new Error("renewal store down");
    }) as SessionStore["renew"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain(ADMIN_MARKER);
    expect(sessionSets(res)).toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    const warned = vi
      .mocked(console.warn)
      .mock.calls.map((args) => JSON.stringify(args))
      .join("\n");
    expect(warned).toContain("Error");
    for (const leak of [token, cookie, SECRET]) {
      expect(warned).not.toContain(leak);
    }
  });
});

describe("route ownership", () => {
  it("the shipped manifest keeps the join-attempts pair Kit-served", () => {
    const list = ROUTE_MANIFEST.find(
      (e) => e.method === "GET" && e.path === "/admin/join-attempts",
    );
    const detail = ROUTE_MANIFEST.find(
      (e) => e.method === "GET" && e.path === "/admin/join-attempts/:id",
    );
    expect(list).toMatchObject({
      enabled: true,
      reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
    });
    expect(detail).toMatchObject({
      enabled: true,
      reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" },
    });
  });

  it("a shipped Hono-owned admin path never renews", async () => {
    const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin");
    expect(shipped?.enabled).toBe(false);
    // No manifest override: the shipped manifest owns the decision, so the
    // renewal dep is unwired — Hono answers before any Kit renewal exists.
    const h = harness({ path: "/admin", routeId: "/admin", renewal: false });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(h.honoFetch).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("hono");
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a manifest-enabled future admin path renews", async () => {
    const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin/events");
    expect(shipped?.enabled).toBe(false);
    if (!shipped) throw new Error("shipped GET /admin/events manifest entry missing");
    // The gate follows the manifest, not a hardcoded path pair: enabling a
    // future admin route renews it with zero renewal-code changes.
    const h = harness({
      path: "/admin/events",
      routeId: "/admin/events",
      manifest: [{ ...shipped, enabled: true }],
    });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectSlideCookie(res, token);
    expect(h.renewCalls).toHaveLength(1);
  });

  it("a released non-admin member page never renews (admin-family-scoped renewal)", async () => {
    // The shipped manifest already enables the member board: an authenticated
    // moderator 200 there must leave the bearer alone. Pins the admin
    // route-family check in the renewal gate — without it, any released
    // moderator member-read would slide the session.
    const h = harness({ path: "/leaderboards/members", routeId: "/leaderboards/members" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("renewal helper guards", () => {
  const helperEvent = (cookie: string | null, locals: unknown): HookEventLike => ({
    ...eventFor(LIST_PATH, "/admin/join-attempts", cookie),
    locals,
  });

  it("returns null without an authenticated session in locals", async () => {
    const h = harness({ renewal: false });
    const renew = adminRenewalFor(h.env);
    const { cookie } = await mint(h.store, MODERATOR);
    for (const locals of [
      undefined,
      { status: "guest", session: null },
      { status: "unknown", session: null },
      { status: "authenticated", session: null },
    ]) {
      await expect(renew(helperEvent(cookie, locals))).resolves.toBeNull();
    }
    expect(h.renewCalls).toEqual([]);
  });

  it("returns null for a signed-in non-moderator: Hono never renews a refused viewer", async () => {
    const h = harness({ renewal: false });
    const renew = adminRenewalFor(h.env);
    const { cookie } = await mint(h.store, MEMBER);
    const locals: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: MEMBER_ID,
        username: "member",
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    await expect(renew(helperEvent(cookie, locals))).resolves.toBeNull();
    expect(h.renewCalls).toEqual([]);
  });

  it("re-verifies the cookie: forged locals with a tampered bearer renew nothing", async () => {
    const h = harness({ renewal: false });
    const renew = adminRenewalFor(h.env);
    const { cookie } = await mint(h.store, MODERATOR, "wrong-secret");
    await expect(renew(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expect(h.renewCalls).toEqual([]);
  });

  it("returns null when no session secret is configured", async () => {
    const h = harness({ renewal: false });
    const renew = adminRenewalFor({ ...h.env, SESSION_SECRET: "" });
    const { cookie } = await mint(h.store, MODERATOR);
    await expect(renew(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expect(h.renewCalls).toEqual([]);
  });

  it("returns null for a grace bearer without attempting renewal", async () => {
    const h = harness({ renewal: false });
    const renew = adminRenewalFor(h.env);
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    const successorHash = await hashToken(newSessionToken());
    expect(
      await h.store.rotate(tokenHash, {
        tokenHash: successorHash,
        userId: MOD_ID,
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    ).toBe(true);
    await expect(renew(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expect(h.renewCalls).toEqual([]);
  });
});

describe("auth-status probe behavior unchanged", () => {
  it("a moderator 200 still carries the signed probe cookie", async () => {
    const h = harness({ renewal: false, probe: true });
    const { cookie } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    const probes = probeSets(res);
    expect(probes).toHaveLength(1);
    for (const flag of [
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ]) {
      expect(probes[0]!).toContain(flag);
    }
    expect(probes[0]!).not.toMatch(/Domain=/i);
    // The probe value is signed (value.signature), never a bare hash.
    expect(probes[0]!.split(";")[0]!.split("=")[1]).toContain(".");
    expect(sessionSets(res)).toEqual([]);
  });

  it("renewal and probe coexist: exactly the session slide plus the probe", async () => {
    const h = harness({ probe: true });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectSlideCookie(res, token);
    expect(probeSets(res)).toHaveLength(1);
    // No third cookie: this slice adds no new cookies.
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it("a probe failure still delivers renewal", async () => {
    const h = harness();
    h.deps.authStatusCookieFor = async () => {
      throw new Error("probe store down");
    };
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectSlideCookie(res, token);
    expect(probeSets(res)).toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });

  it("a renewal failure still delivers the probe", async () => {
    const h = harness({ probe: true });
    const { cookie } = await mint(h.store, MODERATOR);
    h.store.renew = (async () => {
      throw new Error("renewal store down");
    }) as SessionStore["renew"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expect(probeSets(res)).toHaveLength(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });
});

describe("moderator guide states Kit admin renewal parity", () => {
  it("the session/expiry section states Kit admin renewal parity", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const guide = readFileSync(join(root, "docs/moderator-admin-guide.md"), "utf8");
    const section = guide.split("## A moderator lost their role")[1]?.split("\n## ")[0] ?? "";
    expect(section, "guide must keep its session/expiry section").not.toBe("");
    const sentences = section.split(/(?<=[.!?])\s+/);
    const parity = sentences.filter(
      (s) =>
        /kit/i.test(s) && /(renew|slide|refresh|extend|parity|same window|like the hono)/i.test(s),
    );
    expect(
      parity,
      "session/expiry section must state Kit admin renewal parity, e.g. " +
        "'Kit-served admin pages renew the sliding session exactly like the Hono panel.'",
    ).not.toHaveLength(0);
  });
});
