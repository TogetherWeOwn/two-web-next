// Read-only Kit session bridge: the shared request/session service the Kit
// hook uses while Hono retains OAuth/session authority.
//
// Read-only by construction. It verifies the signed __Host session cookie with
// the same hono primitive Hono's own readers use (parseSigned), hashes the
// bearer, and makes exactly one store.get per request — one decision per
// request, shared with Kit loads through locals (createRequestSessionCache
// shares one decision across concurrent readers of the same Request where
// several readers are wired). The bridge never rotates, revokes, or issues
// a session; the one cookie this module writes is the signed auth-status
// probe below, attached by the hook only to successful moderator admin
// responses or audited full member documents. Renewal stays route-specific:
// Hono's readSession rotates its page views (no blanket rotating layout load;
// fragments and JSON keep nonrotating reads), the Kit event detail renews
// through kitEventDetailRotationFor, and Kit admin reads slide through
// kitAdminRenewalFor, which the hook core calls only after the
// member-read boundary releases a successful GET. Logout stays the
// authoritative Hono POST /logout. This module only peeks flashes. Profile
// destinations expire the join flash in the hook core after a released
// successful HTML GET; that deletion does not run here and does not issue
// or rotate a session.
//
// Decision contract: "authenticated" (live row, bits from the row),
// "guest" (missing/tampered cookie, non-two_ token, unknown/expired/revoked
// row), "unknown" (the store failed or no secret is configured — an outage is
// never reported as a logout, so Kit renders "unknown" instead of flipping a
// member to logged-out). The auth-status probe cookie is deliberately never
// accepted here: it proves liveness only and is not a login token.
import { generateSignedCookie } from "hono/cookie";
import { parseSigned } from "hono/utils/cookie";
import { exceptionClass } from "./alerts";
import { AUTH_STATUS_COOKIE } from "./auth-status";
import type { Env } from "./env";
import { storeForEnv } from "./index";
import { safeNext } from "./join/service";
import {
  JOIN_RESULT_COOKIE,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
  type JoinResult,
} from "./return-journey";
import type { HookEventLike } from "./route-ownership";
import { SESSION_COOKIE } from "./session-cookie";
import {
  hashToken,
  isValidSessionToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from "./sessions";
import { EXPIRED_WRITE_COOKIE } from "./write-recovery";

export type KitSession = {
  userId: string;
  username: string;
  avatar: string | null;
  member: boolean;
  moderator: boolean;
};

export type KitSessionStatus = "authenticated" | "guest" | "unknown";

export type KitRequestSession = {
  status: KitSessionStatus;
  session: KitSession | null;
};

export type KitReturnJourney = {
  returnTo: string | null;
  joinResult: JoinResult | null;
  expiredWrite: string | null;
};

/** Everything the Kit hook merges into locals on a Kit-owned request. */
export type KitLocals = KitRequestSession & KitReturnJourney;

export type RequestSessionDeps = {
  sessionSecret: string;
  store: SessionStore;
};

const GUEST: KitRequestSession = { status: "guest", session: null };
const UNKNOWN: KitRequestSession = { status: "unknown", session: null };
const NO_JOURNEY: KitReturnJourney = { returnTo: null, joinResult: null, expiredWrite: null };

async function verifiedCookies(
  request: Request,
  sessionSecret: string,
): Promise<Record<string, string | false> | null> {
  if (!sessionSecret) return null;
  try {
    return await parseSigned(request.headers.get("cookie") ?? "", sessionSecret);
  } catch {
    // A malformed Cookie header must not 500 a Kit render; without verified
    // cookies there is simply no session and no journey to report.
    return null;
  }
}

/**
 * One request's one session decision. Pure read: no rotation, no revocation,
 * no Set-Cookie — a concurrent or abandoned read cannot strand the session.
 */
export async function resolveRequestSession(
  request: Request,
  deps: RequestSessionDeps,
): Promise<KitRequestSession> {
  const cookies = await verifiedCookies(request, deps.sessionSecret);
  if (!cookies) return UNKNOWN;
  const raw = cookies[SESSION_COOKIE];
  if (!isValidSessionToken(raw)) return GUEST;
  let row;
  try {
    row = await deps.store.get(await hashToken(raw));
  } catch (err) {
    // Fail closed to "unknown", never to a false logout: callers render the
    // session state as indeterminate (like Hono's sessionUnavailable guest
    // fallback) instead of telling a member they are logged out.
    // One class-only warn (no Hono context here); callers must not re-warn it.
    console.warn("kit session store unavailable", { exception: exceptionClass(err) });
    return UNKNOWN;
  }
  if (!row) return GUEST;
  return {
    status: "authenticated",
    session: {
      userId: row.userId,
      username: row.username,
      avatar: row.avatar,
      member: row.member,
      moderator: row.moderator,
    },
  };
}

/**
 * Memoize the decision per Request object: the hook resolves once and every
 * Kit load reuses the same promise, so parallel reads share one store.get.
 * Keyed by object identity — never shared across requests, so a Discord role
 * recompute on the next request is always picked up fresh.
 */
export function createRequestSessionCache(): (
  request: Request,
  deps: RequestSessionDeps,
) => Promise<KitRequestSession> {
  const memo = new WeakMap<Request, Promise<KitRequestSession>>();
  return (request, deps) => {
    const hit = memo.get(request);
    if (hit) return hit;
    // resolveRequestSession never rejects (every failure maps to a decision),
    // so the memoized promise cannot poison later readers.
    const pending = resolveRequestSession(request, deps);
    memo.set(request, pending);
    return pending;
  };
}

function joinResultOf(value: string | false | undefined): JoinResult | null {
  return value === "added" || value === "already_member" ? value : null;
}

// Mirrors consumeExpiredWrite: only a pending notice resolves; a restored one
// belongs to Hono's banner render, never to a Kit destination.
function expiredWriteOf(value: string | false | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("pending|")) return null;
  return safeNext(value.slice("pending|".length));
}

/**
 * Kit-visible return state, read-only: the safe destination the OAuth
 * callback would honor, the one-shot join flash, and the pending
 * expired-write notice. This peek never deletes. A profile destination
 * expires a valid flash only after the member-read boundary releases a
 * successful HTML GET; every other Kit read still leaves consumption to the
 * route that renders the banner. HEAD/POST reads leave the join flash
 * pending, matching Hono's GET-only readJoinResult, so a peek cannot
 * double-spend it.
 */
export async function readReturnJourney(
  request: Request,
  sessionSecret: string,
): Promise<KitReturnJourney> {
  const cookies = await verifiedCookies(request, sessionSecret);
  if (!cookies) return NO_JOURNEY;
  const next = cookies[LOGIN_NEXT_COOKIE];
  const intended = cookies[LOGIN_INTENDED_COOKIE];
  return {
    // Re-guarded at read time (consumeLoginReturn parity): even a
    // signed-but-hostile value can never become a destination.
    returnTo:
      safeNext(typeof next === "string" ? next : null) ??
      safeNext(typeof intended === "string" ? intended : null),
    joinResult: request.method === "GET" ? joinResultOf(cookies[JOIN_RESULT_COOKIE]) : null,
    expiredWrite: expiredWriteOf(cookies[EXPIRED_WRITE_COOKIE]),
  };
}

/**
 * Production session-bridge composition for the Kit hook: the exact secret,
 * store and merge wiring every Kit-owned request uses. Lives here (not in
 * web/src/hooks.server.ts) so the root suite pins it — the hook passes
 * `sessionFor: kitSessionBridge(env)` and carries no session logic of its own.
 *
 * Fails closed twice: a storeForEnv failure (no store to read) resolves to
 * "unknown" with whatever journey the cookies carry, and
 * resolveRequestSession maps every read failure to a decision — so the bridge
 * never throws, a Kit render never 500s on a session outage, and an outage
 * never reads as a logout.
 */
/**
 * Read-only viewer bits for the native Kit events list (src/kit-events.ts).
 * Same decision as the bridge's session half, projected to the member bits
 * the list load needs: an outage resolves to null (guest render with no
 * drafts), never to a false logout, and nothing here rotates or revokes.
 */
export function kitEventsSessionFor(env: Env): (request: Request) => Promise<{
  member: boolean;
  moderator: boolean;
} | null> {
  return async (request) => {
    try {
      const decision = await resolveRequestSession(request, {
        sessionSecret: env.SESSION_SECRET,
        store: await storeForEnv(env),
      });
      return decision.status === "authenticated" && decision.session
        ? { member: decision.session.member, moderator: decision.session.moderator }
        : null;
    } catch (err) {
      // The store never materialized, so no read ran: one class-only warn.
      // A store.get failure warns inside resolveRequestSession and resolves
      // to UNKNOWN (null here), so this catch never double-warns it.
      console.warn("kit events session store unavailable", { exception: exceptionClass(err) });
      return null;
    }
  };
}

/**
 * Read-only join-flash peek for the native Kit events list. The load consumes
 * the cookie itself on full renders; this peek only decides shared-cache
 * eligibility, so it never deletes anything.
 */
export function kitEventsJourneyFor(
  env: Env,
): (request: Request) => Promise<"added" | "already_member" | null> {
  return async (request) => (await readReturnJourney(request, env.SESSION_SECRET)).joinResult;
}

export function kitSessionBridge(env: Env): (event: HookEventLike) => Promise<KitLocals> {
  return async (event) => {
    const [session, journey] = await Promise.all([
      (async (): Promise<KitRequestSession> => {
        try {
          return await resolveRequestSession(event.request, {
            sessionSecret: env.SESSION_SECRET,
            store: await storeForEnv(env),
          });
        } catch (err) {
          // The store never materialized, so no read ran: one class-only
          // warn, UNKNOWN with the journey kept. A store.get failure warns
          // inside resolveRequestSession and resolves to UNKNOWN, so this
          // catch never double-warns it.
          console.warn("kit session bridge store unavailable", {
            exception: exceptionClass(err),
          });
          return UNKNOWN;
        }
      })(),
      readReturnJourney(event.request, env.SESSION_SECRET),
    ]);
    return { ...session, ...journey };
  };
}

/**
 * Sliding renewal for the native Kit event detail (src/events/kit-detail.ts):
 * the post-release twin of Hono's readSession rotation. The hook core calls
 * this only after the member-read boundary releases a successful GET, so a
 * refused, failed, throttled or redirected read never burns the presented
 * bearer — the delivered response cannot strand a session it never issued.
 *
 * The rotation itself follows the shared Hono contract: re-verify the signed
 * bearer (locals are never trusted alone), mint a fresh token, atomically
 * replace the live row with the full 120-minute re-stamp, and sign the
 * replacement with the same cookie attributes Hono sets (Path=/, Secure,
 * HttpOnly, SameSite=Lax, Max-Age from SESSION_TTL_SECONDS). A lost race
 * (rotate resolves false
 * for a concurrently retired source) returns null like any other expected
 * non-rotation; only a store failure propagates, and the hook core renders
 * the released page without renewal then (fail-open: rotate is one atomic
 * statement, so a throw leaves the old row live and the next read retries).
 * Anonymous callers get null with zero store writes.
 */
export function kitEventDetailRotationFor(
  env: Env,
): (event: HookEventLike) => Promise<string | null> {
  return async (event) => {
    const locals = event.locals as Partial<KitLocals> | undefined;
    const bits = locals?.status === "authenticated" ? locals.session : null;
    if (!bits || !env.SESSION_SECRET) return null;
    // verifiedCookies never throws (a malformed header resolves to no
    // cookies); an unverifiable bearer simply does not rotate.
    const cookies = await verifiedCookies(event.request, env.SESSION_SECRET);
    const raw = cookies?.[SESSION_COOKIE];
    if (!isValidSessionToken(raw)) return null;
    const store = await storeForEnv(env);
    const replacement = newSessionToken();
    const rotated = await store.rotate(await hashToken(raw), {
      tokenHash: await hashToken(replacement),
      userId: bits.userId,
      username: bits.username,
      avatar: bits.avatar,
      member: bits.member,
      moderator: bits.moderator,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
    if (!rotated) return null;
    // Inline options, like Hono's setSignedCookie calls: the pinned-lifetime
    // guard (test/privacy-policy-numbers.test.ts) reads maxAge from the call.
    return generateSignedCookie(SESSION_COOKIE, replacement, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    });
  };
}

/**
 * Sliding renewal for Kit-served admin reads: the post-release twin of Hono's
 * admin-guard slide (src/admin/guard.ts: a current bearer renews the
 * 120-minute window, grace reads never refresh cookies). The hook core calls
 * this only after the member-read boundary releases a successful GET document,
 * so a refused, failed, bounced or redirected read never touches the presented
 * bearer.
 *
 * Slide, not rotate. Hono admin reads deliberately never rotate — rotation is
 * the site's concern, and an admin read must not invalidate the cookie the
 * moderator's other tab holds. The renewal cookie re-signs the PRESENTED
 * bearer with a fresh Max-Age, and the store call is renew(), never rotate().
 * Only a current bearer (statusHash present) renews; grace/predecessor reads
 * return null without a store write. A lost race (renew resolves false)
 * returns null like any other expected non-renewal; only a store failure
 * propagates, and the hook core renders the released page without renewal
 * then. Non-moderators and anonymous callers get null with zero store writes.
 */
export function kitAdminRenewalFor(env: Env): (event: HookEventLike) => Promise<string | null> {
  return async (event) => {
    const locals = event.locals as Partial<KitLocals> | undefined;
    const bits = locals?.status === "authenticated" ? locals.session : null;
    if (!bits?.moderator || !env.SESSION_SECRET) return null;
    // verifiedCookies never throws (a malformed header resolves to no
    // cookies); an unverifiable bearer simply does not renew.
    const cookies = await verifiedCookies(event.request, env.SESSION_SECRET);
    const raw = cookies?.[SESSION_COOKIE];
    if (!isValidSessionToken(raw)) return null;
    const store = await storeForEnv(env);
    const tokenHash = await hashToken(raw);
    // Only a current bearer renews: grace reads never refresh cookies (Hono
    // gates on statusHash first). A null key returns before any renew call.
    if (!(await store.statusHash(tokenHash))) return null;
    const renewed = await store.renew(tokenHash, new Date(Date.now() + SESSION_TTL_SECONDS * 1000));
    if (!renewed) return null;
    // Inline options, like Hono's setSignedCookie calls: the pinned-lifetime
    // guard (test/privacy-policy-numbers.test.ts) reads maxAge from the call.
    return generateSignedCookie(SESSION_COOKIE, raw, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    });
  };
}

const AUTH_STATUS_OPTIONS = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  maxAge: SESSION_TTL_SECONDS,
};

/** The hook alone supplies the proof of an audited, full member document. */
export function kitAuthStatusCookieFor(
  env: Env,
): (event: HookEventLike, releasedMemberDocument?: boolean) => Promise<string | null> {
  return async (event, releasedMemberDocument = false) => {
    const locals = event.locals as Partial<KitLocals> | undefined;
    const admin = /^\/admin(?:\/|$)/.test(event.url.pathname) && locals?.session?.moderator;
    const member = releasedMemberDocument && locals?.session?.member === true;
    if (
      event.request.method !== "GET" ||
      locals?.status !== "authenticated" ||
      (!admin && !member) ||
      !env.SESSION_SECRET
    )
      return null;

    try {
      const cookies = await verifiedCookies(event.request, env.SESSION_SECRET);
      const token = cookies?.[SESSION_COOKIE];
      if (!isValidSessionToken(token)) return null;
      const store = await storeForEnv(env);
      const key = await store.statusHash(await hashToken(token));
      // Assert the 64-hex shape before signing (the recorded cookie-write
      // boundary): a value outside the shape the read path accepts
      // (src/auth-status.ts) must never be signed into a probe cookie.
      if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
      return generateSignedCookie(AUTH_STATUS_COOKIE, key, env.SESSION_SECRET, AUTH_STATUS_OPTIONS);
    } catch {
      // A probe-store outage must not fail the already-authorized page render.
      return null;
    }
  };
}
