import { parseSigned } from "hono/utils/cookie";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken, type SessionStore } from "../sessions";

const MAX_COOKIE_LENGTH = 8192;
const SESSION_PAIR_PREFIX = `${SESSION_COOKIE}=`;
const MAX_ADMISSION_REFUSALS = 1024;
const ADMISSION_REFUSAL_MS = 60_000;

type SocketSession =
  | { kind: "guest" }
  | { kind: "session"; ref: string; validUntil: number }
  | { kind: "refused"; status: 401 | 503 };

/** Reuse definitive store refusals between upgrades for the same verified ref.
 * Keep this out of established socket authorization. Each live or indeterminate
 * read and each new bearer still goes through the authority. */
export function cacheSocketAdmissionRefusals(
  getLive: SessionStore["getLive"],
  now: () => number = Date.now,
): SessionStore["getLive"] {
  const refusals = new Map<string, number>();
  return async (ref) => {
    const time = now();
    const refusedAt = refusals.get(ref);
    if (refusedAt !== undefined) {
      if (refusedAt <= time && time - refusedAt < ADMISSION_REFUSAL_MS) return null;
      refusals.delete(ref);
    }

    const live = await getLive(ref);
    // Cache only a completed negative lookup. Worker I/O stays in the request
    // that started it, even when concurrent upgrades miss the same entry.
    if (live === null && !refusals.has(ref)) {
      if (refusals.size === MAX_ADMISSION_REFUSALS) {
        const oldest = refusals.keys().next().value;
        if (oldest !== undefined) refusals.delete(oldest);
      }
      refusals.set(ref, time);
    }
    return live;
  };
}

/** Bound the lifetime from an exact session lookup. validUntil is a
 * conservative Worker-local epoch deadline for expiry alarms, not a DB stamp
 * or a substitute for a fresh row read. Throws if the read is indeterminate. */
export async function readTimedSocketSession(
  ref: string,
  getLive: SessionStore["getLive"],
  now: () => number = Date.now,
  elapsedNow: () => number = () => performance.now(),
): Promise<{ userId: string; member: boolean; validUntil: number } | null> {
  const wallStarted = now();
  const started = elapsedNow();
  const live = await getLive(ref);
  if (!live) return null;
  const elapsed = elapsedNow() - started;
  const wallNow = now();
  const wallElapsed = wallNow - wallStarted;
  // The store sampled between request and response. Debit the entire round
  // trip; wall-clock rollback must not erase monotonic elapsed time.
  const debit = Math.ceil(Math.max(elapsed, wallElapsed));
  const validUntil = Math.floor(wallNow + (live.remainingMs - debit));
  if (elapsed < 0 || !Number.isFinite(wallElapsed) || !Number.isFinite(validUntil)) {
    throw new Error("Invalid live session clock or lifetime");
  }
  return validUntil > wallNow ? { userId: live.userId, member: live.member, validUntil } : null;
}

/** A missing session may get the public feed; a present but invalid one may not. */
export async function resolveLiveSocketSession(
  cookie: string,
  secret: string | undefined,
  getLive: SessionStore["getLive"],
  now?: () => number,
  elapsedNow?: () => number,
): Promise<SocketSession> {
  if (cookie.length > MAX_COOKIE_LENGTH || cookie.includes(",")) {
    return { kind: "refused", status: 401 };
  }
  let session: string | undefined;
  for (const raw of cookie.split(";")) {
    const pair = raw.replace(/^[ \t]+/, "");
    // Recognize the name even in malformed segments; only SP/HTAB before
    // the pair is permitted. Do not confuse a longer cookie name with ours.
    const name = /^[\w!#$%&'*+.^`|~-]+/.exec(pair.trimStart())?.[0];
    if (name !== SESSION_COOKIE) continue;
    if (
      session !== undefined ||
      !pair.startsWith(SESSION_PAIR_PREFIX) ||
      pair.length === SESSION_PAIR_PREFIX.length ||
      /\s/.test(pair)
    ) {
      return { kind: "refused", status: 401 };
    }
    session = pair;
  }
  if (session === undefined) return { kind: "guest" };
  if (!secret) return { kind: "refused", status: 503 };
  try {
    const cookies = await parseSigned(session, secret, SESSION_COOKIE);
    const token = cookies[SESSION_COOKIE];
    if (!isValidSessionToken(token)) return { kind: "refused", status: 401 };
    // Internal lookup key only. Neither the bearer nor any identity or role
    // proof belongs in the result or a hibernating socket attachment.
    const ref = await hashToken(token);
    const live = await readTimedSocketSession(ref, getLive, now, elapsedNow);
    if (!live) return { kind: "refused", status: 401 };
    return { kind: "session", ref, validUntil: live.validUntil };
  } catch {
    return { kind: "refused", status: 503 };
  }
}
