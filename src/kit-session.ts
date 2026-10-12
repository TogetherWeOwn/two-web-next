// Read-only Kit session bridge: the shared request/session service the Kit
// hook uses while Hono retains OAuth/session authority.
//
// Read-only by construction. It verifies the signed __Host session cookie with
// the same hono primitive Hono's own readers use (parseSigned), hashes the
// bearer, and makes exactly one store.get per request — one decision per
// request, shared with Kit loads through locals (createRequestSessionCache
// shares one decision across concurrent readers of the same Request where
// several readers are wired). It never rotates, revokes, issues,
// or sets cookies: rotation stays route-specific inside Hono's readSession
// (no blanket rotating layout load; fragments and JSON keep nonrotating
// reads), logout stays the authoritative Hono POST /logout, and flashes stay
// Hono-consumed until a Kit route needs to consume them.
//
// Decision contract: "authenticated" (live row, bits from the row),
// "guest" (missing/tampered cookie, non-two_ token, unknown/expired/revoked
// row), "unknown" (the store failed or no secret is configured — an outage is
// never reported as a logout, so Kit renders "unknown" instead of flipping a
// member to logged-out). The auth-status probe cookie is deliberately never
// accepted here: it proves liveness only and is not a login token.
import { parseSigned } from "hono/utils/cookie";
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
import { hashToken, type SessionStore } from "./sessions";
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
  if (typeof raw !== "string" || !raw.startsWith("two_")) return GUEST;
  let row;
  try {
    row = await deps.store.get(await hashToken(raw));
  } catch {
    // Fail closed to "unknown", never to a false logout: callers render the
    // session state as indeterminate (like Hono's sessionUnavailable guest
    // fallback) instead of telling a member they are logged out.
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
 * expired-write notice. Consumption (cookie deletion) stays Hono-side, so a
 * Kit read can never double-spend a flash. HEAD/POST reads leave the join
 * flash pending, matching Hono's GET-only readJoinResult.
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
export function kitSessionBridge(env: Env): (event: HookEventLike) => Promise<KitLocals> {
  return async (event) => {
    const [session, journey] = await Promise.all([
      (async (): Promise<KitRequestSession> => {
        try {
          return await resolveRequestSession(event.request, {
            sessionSecret: env.SESSION_SECRET,
            store: await storeForEnv(env),
          });
        } catch {
          return UNKNOWN;
        }
      })(),
      readReturnJourney(event.request, env.SESSION_SECRET),
    ]);
    return { ...session, ...journey };
  };
}
