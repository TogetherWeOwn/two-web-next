// Anonymous event-card response cache (N6, follow-up to the R12 decision).
//
// R12 keeps timed expiry on the anonymous `/events` (`public, max-age=60`) and
// `/events/past` (`public, max-age=300`) cards with home staying
// `private, no-store`. This module adds the missing retire: one settled HTML
// entry per anonymous URL, served only to anonymous rendering (no session, no
// search, no one-shot join flash), cleared on every committed event or RSVP
// mutation. Expiry still bounds the worst case; the retire is the fast path
// so the next guest fetch after a publish, edit or RSVP land/leave shows the
// new title and going count.
//
// Isolate-local like `src/counts.ts` and `src/not-found-suggestions.ts`:
// entries are scoped to the database/discord source the request resolved
// (injected fakes isolate hermetic tests; the configured URL shares
// production), never share pending I/O, and cache 200 HTML only. Only the
// anonymous calendar and past-archive entries live here — home never does.
import { databaseUrl } from "../db/connection";
import type { Env } from "../env";

export const ANON_EVENTS_TTL_MS = 60_000;
export const ANON_PAST_TTL_MS = 300_000;

// Junk query values render distinct `?next=` sign-in targets, so `/events`
// keys stay on the raw URL. The cap (FIFO eviction) is the only bound those
// keys need; `/events/past` keys on the normalized page and only data pages
// are stored, so its keys stay within the page count.
const ANON_CACHE_MAX_ENTRIES = 64;

type AnonSource = { db: unknown; discord: unknown; appUrl: unknown };

type AnonEntry = {
  source: AnonSource;
  status: number;
  cacheControl: string;
  vary: string | null;
  body: string;
  expiresAt: number;
};

const entries = new Map<string, AnonEntry>();

type EnvWithSeams = Env & { ADMIN_DB?: unknown; DISCORD_EVENTS?: unknown };

function sameSource(a: AnonSource, b: AnonSource): boolean {
  return a.db === b.db && a.discord === b.discord && a.appUrl === b.appUrl;
}

/** The isolate-sharing scope for one request: same scope, same bytes. */
export function anonCacheSource(env: Env): AnonSource {
  let db: unknown = null;
  try {
    db = (env as EnvWithSeams).ADMIN_DB ?? databaseUrl(env) ?? null;
  } catch {
    db = null;
  }
  return {
    db,
    discord: (env as EnvWithSeams).DISCORD_EVENTS ?? null,
    appUrl: env.APP_URL ?? null,
  };
}

export function anonEventsKey(method: string, pathAndSearch: string, island: boolean): string {
  return `${method} /events${pathAndSearch} island=${island ? "1" : "0"}`;
}

export function anonPastKey(method: string, page: number): string {
  return `${method} /events/past page=${page}`;
}

export function readAnonCache(
  key: string,
  source: AnonSource,
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
  source: AnonSource,
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
