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

export function writeApiPublicCache(
  key: string,
  value: Omit<ApiPublicCacheEntry, "expiresAt">,
  now = Date.now(),
): void {
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { ...value, expiresAt: now + API_PUBLIC_CACHE_TTL_MS });
}

/** Test seam only: clears every entry, mirroring __resetAnonEventCacheForTests. */
export function __resetApiPublicCacheForTests(): void {
  entries.clear();
}
