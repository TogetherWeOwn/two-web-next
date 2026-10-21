// Isolate-local response cache for the session-free public read API.
//
// Every representation here is published-only and identical for all viewers:
// no session is ever read and no cookie ever enters the cache key, so a
// cached anonymous entry is safe to serve to a moderator session and a
// moderator-warmed entry is safe to serve anonymously. That is the cache
// isolation: privileged state cannot enter the cache because it is never
// read. Same shape as src/events/anon-cache.ts (entries retire on TTL;
// callers reset the whole map on mutation in tests via the seam below).
/** Public API entries retire after 60 s, the R12 anonymous-calendar bound. */
export const API_PUBLIC_CACHE_TTL_MS = 60_000;

const MAX_ENTRIES = 64;

export interface ApiPublicCacheEntry {
  status: number;
  headers: Record<string, string>;
  body: string;
  expiresAt: number;
}

const entries = new Map<string, ApiPublicCacheEntry>();

// Retire generation: bumped on every event retirement so a collection/detail
// read that started before the retire can refuse to settle its pre-retire
// bytes after it. Same shape as src/events/anon-cache.ts.
let generation = 0;

/** The current retire generation; event reads capture it before their first read. */
export function apiPublicCacheGeneration(): number {
  return generation;
}

/**
 * Canonical key: method + path + the clamped paging the response was built
 * from. Unknown query params are dropped so junk queries cannot fragment or
 * flood the map.
 */
export function apiPublicCacheKey(method: string, path: string, canonicalQuery: string): string {
  return `${method} ${path}${canonicalQuery}`;
}

export function readApiPublicCache(key: string, now = Date.now()): ApiPublicCacheEntry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return null;
  }
  return entry;
}

/**
 * Infer the clamped page for an out-of-range raw page from an already-cached
 * entry for the same limit. Collection bodies carry `meta.last_page`, and
 * every same-limit entry agrees on it (a mutation retires all event entries
 * in the mutating isolate, so disagreement is only cross-isolate TTL
 * staleness). When the raw page exceeds that last page, the caller replays
 * the clamped entry instead of issuing another count query — so a sweep of
 * past-the-end aliases shares one entry and never evicts page 1. Returns null
 * when nothing cached proves the raw page is out of range: no same-limit
 * entry, an unparseable body, or an in-range raw page.
 */
export function findCachedClampTarget(
  limit: number,
  rawPage: number,
  now = Date.now(),
): number | null {
  const prefix = `GET /api/public/events?limit=${limit}&page=`;
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    if (entry.expiresAt <= now) continue;
    let lastPage: unknown;
    try {
      lastPage = (JSON.parse(entry.body) as { meta?: { last_page?: unknown } }).meta?.last_page;
    } catch {
      continue;
    }
    if (typeof lastPage !== "number" || !Number.isSafeInteger(lastPage) || lastPage < 1) continue;
    if (rawPage > lastPage) return lastPage;
    return null;
  }
  return null;
}

export function writeApiPublicCache(
  key: string,
  value: Omit<ApiPublicCacheEntry, "expiresAt">,
  now = Date.now(),
  expectedGeneration?: number,
): boolean {
  // Generation fence: a read that captured the generation before a retire
  // landed must not settle its pre-retire bytes afterwards. The compare runs
  // synchronously inside the write, so it is atomic within the isolate.
  // Callers without a read (community/join, probes) omit the fence. The
  // return tells the route whether the entry settled, so an overtaken read
  // can answer its own bytes without granting downstream reuse.
  if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { ...value, expiresAt: now + API_PUBLIC_CACHE_TTL_MS });
  return true;
}

function isEventEntry(key: string): boolean {
  // Collection keys carry `?limit=&page=`; detail keys carry `/<key>`.
  return (
    key === "GET /api/public/events" ||
    key.startsWith("GET /api/public/events?") ||
    key.startsWith("GET /api/public/events/")
  );
}

/**
 * Retire every cached event collection/detail entry in this isolate. Called
 * after a committed moderator or agent create/update/publish/cancel (never on
 * a refusal or a rollback), so the next fetch re-reads instead of serving
 * pre-mutation bytes. Community/join entries are untouched: their payloads do
 * not read event rows. The generation bump is unconditional — even with
 * nothing cached — so an in-flight pre-retire read still refuses to settle.
 * Same-isolate only, like retireAnonEventCaches: every other isolate
 * converges on TTL expiry.
 */
export function retireApiPublicEventCache(): void {
  for (const key of entries.keys()) {
    if (isEventEntry(key)) entries.delete(key);
  }
  generation++;
}

/** Test seam only: clears every entry and restarts the generation. */
export function __resetApiPublicCacheForTests(): void {
  entries.clear();
  generation = 0;
}
