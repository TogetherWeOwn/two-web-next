// Anonymous event-card response cache (N6, follow-up to the R12 decision).
//
// R12 keeps timed expiry on the anonymous `/events` (`public, max-age=60`)
// and `/events/past` (`public, max-age=300`) cards with home staying
// `private, no-store`. This module adds the missing retire: one settled HTML
// entry per anonymous URL, served only to cookieless anonymous rendering (no
// session, no search, no one-shot join flash), cleared on every committed
// event or RSVP mutation. Expiry still bounds the worst case; the retire is
// the fast path so the next guest fetch after a publish, edit or RSVP
// land/leave shows the new title and going count.
//
// Entries are isolate-local, like `src/counts.ts` and
// `src/not-found-suggestions.ts`: the mutating isolate retires immediately,
// every other isolate converges on expiry (at most 60 s on `/events`, 300 s
// on `/events/past` — the R12 bound, unchanged). The Worker Cache API would
// share entries across isolates, but retire-by-enumeration needs `keys()`
// and the pinned Miniflare/workerd build neither implements it nor persists
// synthetic keys deterministically (probed 2026-10-10), so a shared retire
// is not provable here. Only the anonymous calendar and past-archive
// entries live here — home never does.
import { databaseUrl } from "../db/connection";
import type { Env } from "../env";

export const ANON_EVENTS_TTL_MS = 60_000;
export const ANON_PAST_TTL_MS = 300_000;

// Junk query values render distinct `?next=` sign-in targets, so `/events`
// keys stay on the raw URL. The cap (FIFO eviction) is the only bound those
// keys need; `/events/past` keys on the normalized page and only data pages
// are stored, so its keys stay within the page count.
const ANON_CACHE_MAX_ENTRIES = 64;

export interface AnonCacheSource {
  db: unknown;
  discord: unknown;
  appUrl: unknown;
}

interface AnonEntry {
  source: AnonCacheSource;
  status: number;
  cacheControl: string;
  vary: string | null;
  body: string;
  expiresAt: number;
}

const entries = new Map<string, AnonEntry>();

type EnvWithSeams = Env & { ADMIN_DB?: unknown; DISCORD_EVENTS?: unknown };

/**
 * The sharing scope for one request. Identity-scoped to the database and
 * Discord source the request resolves (injected fakes isolate hermetic
 * tests; the configured URL shares production, where per-request clients
 * still resolve the same connection string), with the app URL as the
 * value-compared discriminator.
 */
export function anonCacheSource(env: Env): AnonCacheSource {
  const seams = env as EnvWithSeams;
  let db: unknown = null;
  try {
    db = seams.ADMIN_DB ?? databaseUrl(env) ?? null;
  } catch {
    db = null;
  }
  return { db, discord: seams.DISCORD_EVENTS ?? null, appUrl: env.APP_URL ?? null };
}

function sameSource(a: AnonCacheSource, b: AnonCacheSource): boolean {
  return (
    a.db === b.db &&
    a.discord === b.discord &&
    (typeof a.appUrl === "string" ? a.appUrl : "") ===
      (typeof b.appUrl === "string" ? b.appUrl : "")
  );
}

export function anonEventsKey(method: string, pathAndSearch: string, island: boolean): string {
  return `${method} /events${pathAndSearch} island=${island ? "1" : "0"}`;
}

export function anonPastKey(method: string, page: number): string {
  return `${method} /events/past page=${page}`;
}

export interface AnonEligibility {
  method: string;
  hasCookie: boolean;
  hasSession: boolean;
  searching: boolean;
  flashed: boolean;
}

/**
 * Only a cookieless anonymous render may serve or settle shared bytes. Any
 * cookie at all bypasses — session, flash and stray OAuth cookies alike —
 * so viewer state can never be stored or served as shared.
 */
export function isAnonCacheEligible(e: AnonEligibility): boolean {
  return (
    (e.method === "GET" || e.method === "HEAD") &&
    !e.hasCookie &&
    !e.hasSession &&
    !e.searching &&
    !e.flashed
  );
}

export function readAnonCache(
  key: string,
  source: AnonCacheSource,
  now: number = Date.now(),
): Omit<AnonEntry, "source" | "expiresAt"> | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (now >= hit.expiresAt) {
    entries.delete(key);
    return null;
  }
  if (!sameSource(hit.source, source)) return null;
  return {
    status: hit.status,
    cacheControl: hit.cacheControl,
    vary: hit.vary,
    body: hit.body,
  };
}

export function writeAnonCache(
  key: string,
  source: AnonCacheSource,
  res: { status: number; cacheControl: string; vary: string | null; body: string },
  ttlMs: number,
  now: number = Date.now(),
): void {
  if (!entries.has(key) && entries.size >= ANON_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { ...res, source, expiresAt: now + ttlMs });
}

/**
 * Retire every anonymous calendar/archive entry. Called after a committed
 * event or RSVP mutation (never on a refusal or a rollback), so the next
 * guest fetch re-reads the new title and going count. Home has no entry
 * here, so its `private, no-store` posture is untouched.
 */
export function retireAnonEventCaches(): void {
  entries.clear();
}

/** Hermetic-test reset: same effect as a retire, without a mutation. */
export function __resetAnonEventCacheForTests(): void {
  entries.clear();
}
