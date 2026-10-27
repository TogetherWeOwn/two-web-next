// Acceptance contract: a released successful Kit admin GET document ROTATES
// the moderator's bearer — the post-release twin of Hono's admin-guard
// re-stamp (src/admin/guard.ts: a current bearer mints a fresh token with a
// fresh 120-minute window, grace reads never refresh cookies, and Hono
// delivers the replacement on any outcome the browser keeps; this Kit twin
// rotates only after a released successful GET document), wired at the same
// post-response position as the event-detail rotation in dispatchHookRequest.
// The Kit guard itself stays read-only (src/admin/kit-guard.ts: never
// rotates, never sets cookies); rotation runs only after the member-read
// boundary releases the response, never inside it.
//
// Rotate, not slide. This file supersedes the slide pins that preceded it:
// the renewal cookie signs a NEW token, the store call is rotate() (never
// renew()), the presented bearer becomes predecessor-only (no status key,
// authenticates only inside SESSION_PREDECESSOR_GRACE_SECONDS of grace via
// src/sessions.ts lineage), and the successor keeps the lineage key.
// Failing-first: on the slide head the rotation, replay, race and
// store-failure tests fail because the cookie re-signs the presented
// bearer and renew() is called instead of rotate() (so a stubbed rotate()
// race/failure is never even reached); the pure no-rotation controls
// (anonymous, refused, non-document and grace-helper reads) pass before
// and after, pinning the behavior rotation must preserve.
//
// Seam the Builder changes (names are the contract; the export and dep names
// do not change):
// - src/kit-session.ts: kitAdminRenewalFor(env) -> (event) => Promise<string | null>
//   (same shape as kitEventDetailRotationFor: re-verify the bearer, gate on a
//   current bearer via statusHash so grace reads never attempt a rotation,
//   mint a fresh token, rotate() the row, sign the REPLACEMENT token with
//   inline `maxAge: SESSION_TTL_SECONDS` so the pinned-lifetime guard keeps
//   reading it from the call).
// - src/route-ownership.ts: HookDispatchDeps.adminRenewalFor plus the released
//   successful-GET-document gate (admin family, GET, 200/404, text/html,
//   authenticated moderator) stay as shipped, applied post-release.
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
  // Both writers are recorded: a correct rotation lands exactly one rotate
  // call and zero renew calls; a slide leftover shows up as a renew call.
  const rotateCalls: {
    oldHash: string;
    replacement: Parameters<SessionStore["rotate"]>[1];
  }[] = [];
  const rawRotate = store.rotate.bind(store);
  store.rotate = (async (oldHash: string, replacement: Parameters<SessionStore["rotate"]>[1]) => {
    events.push("rotate");
    rotateCalls.push({ oldHash, replacement });
    return rawRotate(oldHash, replacement);
  }) as SessionStore["rotate"];
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
    rotateCalls,
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

/**
 * The rotation pin: the renewal cookie signs a NEW bearer — never the
 * presented one. Returns the replacement bearer so callers can pin its row.
 */
function expectRotationCookie(res: Response, priorToken: string): string {
  const sets = sessionSets(res);
  expect(sets).toHaveLength(1);
  const parts = sets[0]!.split(";").map((p) => p.trim().toLowerCase());
  expect(parts).toContain("path=/");
  expect(parts).toContain("secure");
  expect(parts).toContain("httponly");
  expect(parts).toContain("samesite=lax");
  expect(parts).toContain(`max-age=${SESSION_TTL_SECONDS}`);
  const replacement = bearerOfSetCookie(sets[0]!);
  expect(replacement, "rotation must mint a fresh bearer, not re-sign the presented one").not.toBe(
    priorToken,
  );
  expect(isValidSessionToken(replacement)).toBe(true);
  return replacement;
}

/** No rotation and no slide: neither writer ran on this read. */
function expectNoRotation(h: ReturnType<typeof harness>): void {
  expect(h.rotateCalls).toEqual([]);
  expect(h.renewCalls).toEqual([]);
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

describe("released Kit admin GET documents rotate the session", () => {
  it.each([
    { path: LIST_PATH, routeId: "/admin/join-attempts" },
    { path: DETAIL_PATH, routeId: "/admin/join-attempts/[id]" },
  ])(
    "rotates the current bearer on GET $path: fresh cookie signed, window re-stamped",
    async ({ path, routeId }) => {
      const h = harness({ path, routeId });
      const { cookie, token } = await mint(h.store, MODERATOR);
      const tokenHash = await hashToken(token);
      const statusBefore = await h.store.statusHash(tokenHash);
      expect(statusBefore).not.toBeNull();
      const renew = vi.spyOn(h.store, "renew");
      const replace = vi.spyOn(h.store, "replace");
      const create = vi.spyOn(h.store, "create");

      const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-two-renderer")).toBe("kit");
      expect(await res.clone().text()).toContain(ADMIN_MARKER);
      const replacement = expectRotationCookie(res, token);
      const successorHash = await hashToken(replacement);
      // Rotation runs after the boundary releases: resolve, then audit, then rotate.
      expect(h.events).toEqual(["resolve", "audit", "rotate"]);
      expect(h.rotateCalls).toHaveLength(1);
      const call = h.rotateCalls[0]!;
      expect(call.oldHash).toBe(tokenHash);
      // The minted replacement is the row the cookie carries, with the
      // moderator's identity bits copied from the verified session.
      expect(call.replacement.tokenHash).toBe(successorHash);
      expect(call.replacement).toMatchObject({
        userId: MOD_ID,
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
      });
      // Re-stamped from request time with the full 120-minute window.
      const now = Date.now();
      expect(call.replacement.expiresAt.getTime()).toBeGreaterThanOrEqual(
        now + SESSION_TTL_SECONDS * 1000 - 60_000,
      );
      expect(call.replacement.expiresAt.getTime()).toBeLessThanOrEqual(
        now + SESSION_TTL_SECONDS * 1000 + 60_000,
      );
      // Rotate, not slide: the presented bearer is predecessor-only (no
      // status key, grace authentication only), the successor is the live
      // current row, and the lineage key survives on the successor.
      expect(await h.store.statusHash(tokenHash)).toBeNull();
      expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
      expect(await h.store.get(successorHash)).toMatchObject({ userId: MOD_ID });
      expect(await h.store.statusHash(successorHash)).toBe(statusBefore);
      expect(renew, "rotation must not slide the old row").not.toHaveBeenCalled();
      expect(h.renewCalls).toEqual([]);
      expect(replace).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      // The audit still ran: one row naming the moderator viewer and the subject.
      expect(h.entries).toHaveLength(1);
      const entry = h.entries[0]!;
      expect(entry).toMatchObject({ viewerDiscordId: MOD_ID });
      expect(JSON.stringify(entry)).toContain(SUBJECT);
      // The successor outlives the original 1-hour mint, then dies at the new
      // stamp; the retired bearer is long past its grace by then.
      h.advanceTime(3600_000 + 5000);
      expect(await h.store.get(successorHash)).toMatchObject({ userId: MOD_ID });
      expect(await h.store.get(tokenHash)).toBeNull();
      h.advanceTime(3600_000 + 5000);
      expect(await h.store.get(successorHash)).toBeNull();
    },
  );

  it("signs the replacement cookie with the session secret Hono verifies", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    const verified = await parseSigned(sessionSets(res)[0]!, SECRET);
    expect(isValidSessionToken(verified[SESSION_COOKIE])).toBe(true);
    expect(verified[SESSION_COOKIE]).not.toBe(token);
  });

  it("replaying a rotated-out bearer follows predecessor grace: in-grace renders without rotating, post-grace bounces", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);

    // The first released read rotates: the presented bearer is now the
    // immediate predecessor, exactly as a replayed old tab would present it.
    const first = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(first.status).toBe(200);
    const replacement = expectRotationCookie(first, token);
    const successorHash = await hashToken(replacement);
    expect(h.rotateCalls).toHaveLength(1);
    const successorExpiry = h.rotateCalls[0]!.replacement.expiresAt.getTime();
    expect(await h.store.statusHash(tokenHash)).toBeNull();
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });

    // Inside grace the retired bearer still renders the moderator document,
    // but the replay itself rotates nothing: no rotate call at all (Hono
    // gates on statusHash first), no cookie, no sibling. Run the replay
    // near the end of grace so a grace-extending replay would be caught
    // below: the deadline stays the one planted at rotation.
    h.advanceTime((SESSION_PREDECESSOR_GRACE_SECONDS - 2) * 1000);
    for (const n of [1, 2]) {
      const replay = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
      expect(replay.status, `in-grace replay ${n} serves`).toBe(200);
      expect(await replay.clone().text()).toContain(ADMIN_MARKER);
      expect(sessionSets(replay), `in-grace replay ${n} sets no cookie`).toEqual([]);
      expect(h.rotateCalls, `in-grace replay ${n} attempts no rotation`).toHaveLength(1);
      expect(h.renewCalls).toEqual([]);
    }

    // Three more seconds puts the original grace deadline in the past,
    // even though the last replay was only moments ago: grace reads never
    // extend the fixed deadline, so the retired bearer now bounces.
    h.advanceTime(3000);
    const bounced = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toContain("/auth/discord");
    expect(sessionSets(bounced)).toEqual([]);
    expect(h.rotateCalls).toHaveLength(1);
    expect(h.renewCalls).toEqual([]);

    // The grace reads must not extend the live successor on the old tab's
    // behalf: it still dies at the stamp planted by the rotation.
    h.advanceTime(successorExpiry - 1000 - h.nowMs());
    expect(await h.store.get(successorHash)).toMatchObject({ userId: MOD_ID });
    h.advanceTime(1001);
    expect(await h.store.get(successorHash)).toBeNull();
  });

  it("the replacement bearer rotates again on the next released read, and the grandparent is pruned", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    const lineage = await h.store.statusHash(tokenHash);

    const hop1 = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(hop1.status).toBe(200);
    const second = expectRotationCookie(hop1, token);
    const secondHash = await hashToken(second);
    // The Set-Cookie pair is the cookie the browser replays on the next read.
    const secondCookie = sessionSets(hop1)[0]!.split(";")[0]!;

    const hop2 = await dispatchHookRequest(eventFor(h.path, h.routeId, secondCookie), h.deps);
    expect(hop2.status).toBe(200);
    expect(await hop2.clone().text()).toContain(ADMIN_MARKER);
    const third = expectRotationCookie(hop2, second);
    expect(third).not.toBe(token);
    const thirdHash = await hashToken(third);

    expect(h.rotateCalls).toHaveLength(2);
    expect(h.rotateCalls[0]!.oldHash).toBe(tokenHash);
    expect(h.rotateCalls[1]!.oldHash).toBe(secondHash);
    expect(h.rotateCalls[1]!.replacement.tokenHash).toBe(thirdHash);
    expect(h.renewCalls).toEqual([]);

    // Only the immediate predecessor keeps grace: hop two pruned the
    // grandparent even though its own 10-second window has not elapsed.
    expect(await h.store.get(tokenHash), "the grandparent is pruned on the next win").toBeNull();
    expect(await h.store.statusHash(tokenHash)).toBeNull();
    expect(
      await h.store.get(secondHash),
      "the immediate predecessor stays grace-valid",
    ).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(secondHash)).toBeNull();
    expect(await h.store.get(thirdHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(thirdHash)).toBe(lineage);
  });

  it("a signed-in non-moderator 403 never rotates (unlike the event-detail draft 403)", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MEMBER);
    const tokenHash = await hashToken(token);
    const writes = spyWrites(h.store);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(403);
    expect(sessionSets(res)).toEqual([]);
    expect(writes, "a refused viewer does zero store writes").toEqual([]);
    expectNoRotation(h);
    // Untouched as the current bearer, not demoted to a predecessor.
    expect(await h.store.get(tokenHash)).not.toBeNull();
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
  });
});

describe("anonymous, refused and non-document reads never rotate", () => {
  it("anonymous reads bounce without cookies or session writes", async () => {
    const h = harness();
    const writes = spyWrites(h.store);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, null), h.deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
    expect(sessionSets(res)).toEqual([]);
    expect(writes).toEqual([]);
    expectNoRotation(h);
  });

  it.each(["tampered signature", "unknown token", "expired row"] as const)(
    "a %s bounces without rotation",
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
      expectNoRotation(h);
    },
  );

  it("a refused audit keeps the 503 refusal and the live bearer: rotation never runs inside the boundary", async () => {
    const h = harness({ sink: async () => false });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toBe(REFUSAL);
    expect(sessionSets(res)).toEqual([]);
    // The boundary refused before any rotation could run: zero rotate calls,
    // and the presented bearer is still the live current row for the retry.
    expectNoRotation(h);
    expect(await h.store.get(tokenHash)).not.toBeNull();
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
  });

  it("a load outage 503 never rotates", async () => {
    const h = harness({ variant: "outage503" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toBe("Admin temporarily unavailable");
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a session-store outage 503 never rotates", async () => {
    const h = harness();
    const { cookie } = await mint(h.store, MODERATOR);
    h.store.get = (async () => {
      throw new Error("session store down");
    }) as SessionStore["get"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(503);
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
  });

  it("a redirect never rotates", async () => {
    const h = harness({ variant: "redirect" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/join-attempts?page=2");
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("HEAD reads do not rotate", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie, "HEAD"), h.deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a non-HTML 200 does not rotate", async () => {
    const h = harness({ variant: "json" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("POST stays Hono-owned: the Kit rotation path never sees it", async () => {
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
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("rotation races stay safe", () => {
  it("a lost rotation race still delivers the released 200 without a cookie, old row live", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    // rotate() resolving false is the lost race: a concurrently retired
    // source wins, this read mints nothing and sets no cookie.
    h.store.rotate = (async () => false) as SessionStore["rotate"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain(ADMIN_MARKER);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls, "a lost race must not fall back to sliding").toEqual([]);
    // The old row is left live as the current bearer for the next read.
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
  });

  it("a rotation store error delivers the released 200 without a cookie: fail-open, old row live, class-only warn", async () => {
    const h = harness();
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    h.store.rotate = (async () => {
      throw new Error("rotation store down");
    }) as SessionStore["rotate"];
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain(ADMIN_MARKER);
    expect(sessionSets(res)).toEqual([]);
    expect(h.renewCalls, "a failed rotation must not fall back to sliding").toEqual([]);
    // Rotation is one atomic statement, so a throw leaves the old row live
    // as the current bearer: not deleted, not demoted to a predecessor.
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
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

  it("a shipped Hono-owned admin path never rotates", async () => {
    const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin");
    expect(shipped?.enabled).toBe(false);
    // No manifest override: the shipped manifest owns the decision, so the
    // renewal dep is unwired — Hono answers before any Kit rotation exists.
    const h = harness({ path: "/admin", routeId: "/admin", renewal: false });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(h.honoFetch).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("hono");
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });

  it("a manifest-enabled future admin path rotates", async () => {
    const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin/events");
    expect(shipped?.enabled).toBe(false);
    if (!shipped) throw new Error("shipped GET /admin/events manifest entry missing");
    // The gate follows the manifest, not a hardcoded path pair: enabling a
    // future admin route rotates it with zero rotation-code changes.
    const h = harness({
      path: "/admin/events",
      routeId: "/admin/events",
      manifest: [{ ...shipped, enabled: true }],
    });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectRotationCookie(res, token);
    expect(h.rotateCalls).toHaveLength(1);
    expect(h.rotateCalls[0]!.oldHash).toBe(await hashToken(token));
    expect(h.renewCalls).toEqual([]);
  });

  it("a released non-admin member page never rotates (admin-family-scoped rotation)", async () => {
    // The shipped manifest already enables the member board: an authenticated
    // moderator 200 there must leave the bearer alone. Pins the admin
    // route-family check in the rotation gate — without it, any released
    // moderator member-read would rotate the session.
    const h = harness({ path: "/leaderboards/members", routeId: "/leaderboards/members" });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    expect(sessionSets(res)).toEqual([]);
    expectNoRotation(h);
    expect(await h.store.get(await hashToken(token))).not.toBeNull();
  });
});

describe("rotation helper guards", () => {
  const helperEvent = (cookie: string | null, locals: unknown): HookEventLike => ({
    ...eventFor(LIST_PATH, "/admin/join-attempts", cookie),
    locals,
  });

  it("rotates a current moderator bearer and returns the signed replacement cookie", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    const lineage = await h.store.statusHash(tokenHash);

    const setCookie = await rotate(helperEvent(cookie, moderatorLocals()));

    expect(setCookie, "a current moderator bearer must rotate").not.toBeNull();
    const replacement = bearerOfSetCookie(setCookie!);
    expect(replacement, "the helper must sign a fresh bearer").not.toBe(token);
    expect(isValidSessionToken(replacement)).toBe(true);
    const verified = await parseSigned(setCookie!, SECRET);
    expect(verified[SESSION_COOKIE]).toBe(replacement);
    expect(setCookie!.toLowerCase()).toContain(`max-age=${SESSION_TTL_SECONDS}`);
    expect(h.rotateCalls).toHaveLength(1);
    expect(h.rotateCalls[0]!.oldHash).toBe(tokenHash);
    expect(h.rotateCalls[0]!.replacement.tokenHash).toBe(await hashToken(replacement));
    expect(h.renewCalls, "the helper must rotate, never slide").toEqual([]);
    // Predecessor-only afterwards; the successor carries the lineage.
    expect(await h.store.statusHash(tokenHash)).toBeNull();
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(await hashToken(replacement))).toBe(lineage);
  });

  it("returns null without an authenticated session in locals", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie } = await mint(h.store, MODERATOR);
    const writes = spyWrites(h.store);
    for (const locals of [
      undefined,
      { status: "guest", session: null },
      { status: "unknown", session: null },
      { status: "authenticated", session: null },
    ]) {
      await expect(rotate(helperEvent(cookie, locals))).resolves.toBeNull();
    }
    expect(writes, "anonymous callers do zero store writes").toEqual([]);
    expectNoRotation(h);
  });

  it("returns null for a signed-in non-moderator: Hono never rotates a refused viewer", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
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
    const writes = spyWrites(h.store);
    await expect(rotate(helperEvent(cookie, locals))).resolves.toBeNull();
    expect(writes, "a non-moderator does zero store writes").toEqual([]);
    expectNoRotation(h);
  });

  it("re-verifies the cookie: forged locals with a tampered bearer rotate nothing", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie } = await mint(h.store, MODERATOR, "wrong-secret");
    const writes = spyWrites(h.store);
    await expect(rotate(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expect(writes).toEqual([]);
    expectNoRotation(h);
  });

  it("returns null when no session secret is configured", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor({ ...h.env, SESSION_SECRET: "" });
    const { cookie } = await mint(h.store, MODERATOR);
    await expect(rotate(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expectNoRotation(h);
  });

  it("returns null for a grace bearer without attempting rotation", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    const successorHash = await hashToken(newSessionToken());
    // Fixture rotation: another tab already rotated, so the presented
    // bearer is a predecessor in grace. This setup call is recorded.
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
    const rotateCallsBefore = h.rotateCalls.length;
    const writes = spyWrites(h.store);
    await expect(rotate(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    // Grace reads never rotate: the statusHash gate returns before any
    // store write is attempted, so no sibling is minted for the old tab.
    expect(writes).toEqual([]);
    expect(h.rotateCalls).toHaveLength(rotateCallsBefore);
    expect(h.renewCalls).toEqual([]);
  });

  it("returns null on a lost rotation race without falling back to a slide", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    h.store.rotate = (async () => false) as SessionStore["rotate"];
    await expect(rotate(helperEvent(cookie, moderatorLocals()))).resolves.toBeNull();
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
  });

  it("propagates a rotation store error and leaves the old row live as current", async () => {
    const h = harness({ renewal: false });
    const rotate = adminRenewalFor(h.env);
    const { cookie, token } = await mint(h.store, MODERATOR);
    const tokenHash = await hashToken(token);
    h.store.rotate = (async () => {
      throw new Error("rotation store down");
    }) as SessionStore["rotate"];
    // Only a store failure propagates; the hook core turns it into the
    // released page without a cookie (pinned in the race suite above).
    await expect(rotate(helperEvent(cookie, moderatorLocals()))).rejects.toThrow(
      "rotation store down",
    );
    expect(h.renewCalls).toEqual([]);
    expect(await h.store.get(tokenHash)).toMatchObject({ userId: MOD_ID });
    expect(await h.store.statusHash(tokenHash)).toBe(tokenHash);
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

  it("rotation and probe coexist: exactly the session rotation plus the probe", async () => {
    const h = harness({ probe: true });
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectRotationCookie(res, token);
    expect(probeSets(res)).toHaveLength(1);
    // No third cookie: this slice adds no new cookies.
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it("a probe failure still delivers rotation", async () => {
    const h = harness();
    h.deps.authStatusCookieFor = async () => {
      throw new Error("probe store down");
    };
    const { cookie, token } = await mint(h.store, MODERATOR);
    const res = await dispatchHookRequest(eventFor(h.path, h.routeId, cookie), h.deps);
    expect(res.status).toBe(200);
    expectRotationCookie(res, token);
    expect(probeSets(res)).toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });

  it("a rotation failure still delivers the probe", async () => {
    const h = harness({ probe: true });
    const { cookie } = await mint(h.store, MODERATOR);
    h.store.rotate = (async () => {
      throw new Error("rotation store down");
    }) as SessionStore["rotate"];
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
        /kit/i.test(s) &&
        /(renew|rotat|slide|refresh|extend|parity|same window|like the hono)/i.test(s),
    );
    expect(
      parity,
      "session/expiry section must state Kit admin renewal parity, e.g. " +
        "'Kit-served admin pages rotate the session exactly like the Hono panel.'",
    ).not.toHaveLength(0);
  });
});
