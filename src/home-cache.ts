// Homepage guest-invariant short-TTL cache. Counts, upcoming events and
// featured content are identical for guests and members, so one shared entry
// serves every viewer; the response stays `private, no-store` because it also
// embeds the per-viewer session and the one-shot join flash, which are never
// cached here. Outage fallbacks are preserved: a cache miss or a cache failure
// falls through to the direct read, and an unavailable upcoming read is never
// stored (a stored outage would hide recovery behind the TTL).
import { databaseUrl } from "./db/connection";
import type { Db } from "./db/index";
import type { Env } from "./env";
import { listVisibleFeatured, type VisibleFeatured } from "./featured";
import { loadHomeUpcomingMerged, type HomeUpcomingMerged } from "./events/reads";
import type { DiscordEventsSource } from "./events/discord-transients-types";

export const HOME_GUEST_CACHE_TTL_MS = 60_000;

type WaitUntilCtx = { waitUntil?: (promise: Promise<unknown>) => void };

type UpcomingEntry = { value: HomeUpcomingMerged; expiresAt: number };
type FeaturedEntry = { value: VisibleFeatured[]; expiresAt: number };

// Cross-request sharing in staging is keyed by the web-DB URL (one Hyperdrive
// binding, stable per environment). Test/dev fixtures inject ADMIN_DB instead:
// each injected object gets its own entry so hermetic fixtures never share.
const upcomingByUrl = new Map<string, UpcomingEntry>();
const featuredByUrl = new Map<string, FeaturedEntry>();
const upcomingByDb = new WeakMap<object, UpcomingEntry>();
const featuredByDb = new WeakMap<object, FeaturedEntry>();

type EnvWithAdminDb = Env & { ADMIN_DB?: Db };

function injectedDb(env: Env): Db | undefined {
  return (env as EnvWithAdminDb).ADMIN_DB;
}

function urlKey(env: Env): string {
  return databaseUrl(env) ?? "no-db";
}

/** Test/dev seam: clear the URL-keyed in-memory entries (Cache API entries are per-test absent; injected-Db WeakMap entries are keyed by fixture object and expire by TTL). */
export function __resetHomeGuestCacheForTests(): void {
  upcomingByUrl.clear();
  featuredByUrl.clear();
}

// FNV-1a over the key so the Cache API request URL never carries credentials
// (the Hyperdrive connection string) in plaintext.
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function cacheApi(env: Env): Promise<Cache | undefined> {
  try {
    // Hermetic fixtures inject ADMIN_DB with request-scoped doubles (the
    // Lighthouse fixture worker builds request-relative event dates per
    // request): a cross-request edge entry would serve one request's fixture
    // to the next. Those environments keep isolate-local reuse through the
    // injected-object WeakMap above; the edge layer is production-only.
    if (injectedDb(env)) return Promise.resolve(undefined);
    if (typeof caches === "undefined" || !caches.default) return Promise.resolve(undefined);
    return Promise.resolve(caches.default);
  } catch {
    return Promise.resolve(undefined);
  }
}

function cacheRequest(kind: "upcoming" | "featured", key: string): Request {
  return new Request(`https://home-guest-cache.internal/${kind}/${fingerprint(key)}`);
}

function reviveUpcoming(raw: unknown): HomeUpcomingMerged | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as HomeUpcomingMerged;
  if (!Array.isArray(value.items) || typeof value.unavailable !== "boolean") return undefined;
  const reviveDate = (input: unknown): Date | undefined => {
    if (input instanceof Date && Number.isFinite(input.getTime())) return input;
    if (typeof input === "string") {
      const parsed = new Date(input);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
    return undefined;
  };
  const items: HomeUpcomingMerged["items"] = [];
  for (const row of value.items) {
    if (!row || typeof row !== "object") return undefined;
    const startsAt = reviveDate((row as { startsAt?: unknown }).startsAt);
    if (!startsAt) return undefined;
    items.push({ ...(row as object), startsAt } as HomeUpcomingMerged["items"][number]);
  }
  return {
    items,
    unavailable: value.unavailable,
    discordFailed: value.discordFailed === true,
  };
}

async function readUpcomingCache(
  env: Env,
  key: string,
  injected: Db | undefined,
): Promise<HomeUpcomingMerged | undefined> {
  const now = Date.now();
  const memory = injected ? upcomingByDb.get(injected) : upcomingByUrl.get(key);
  if (memory && now < memory.expiresAt) return memory.value;
  const cache = await cacheApi(env);
  if (!cache) return undefined;
  try {
    const hit = await cache.match(cacheRequest("upcoming", key));
    if (!hit) return undefined;
    const revived = reviveUpcoming(await hit.json());
    if (!revived || revived.unavailable) return undefined;
    const entry = { value: revived, expiresAt: now + HOME_GUEST_CACHE_TTL_MS };
    if (injected) upcomingByDb.set(injected, entry);
    else upcomingByUrl.set(key, entry);
    return revived;
  } catch {
    return undefined;
  }
}

function storeUpcomingCache(
  env: Env,
  key: string,
  injected: Db | undefined,
  value: HomeUpcomingMerged,
  ctx?: WaitUntilCtx,
): void {
  if (value.unavailable) return;
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS };
  if (injected) upcomingByDb.set(injected, entry);
  else upcomingByUrl.set(key, entry);
  void cacheApi(env).then((cache) => {
    if (!cache) return;
    const request = cacheRequest("upcoming", key);
    const response = new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${Math.floor(HOME_GUEST_CACHE_TTL_MS / 1000)}`,
      },
    });
    try {
      const put = cache.put(request, response);
      if (ctx?.waitUntil) ctx.waitUntil(put);
      // A late Cache API failure must not even warn: the read already returned.
      else put.then(undefined, () => {});
    } catch {
      // Cache failures never fail the request.
    }
  });
}

async function readFeaturedCache(
  env: Env,
  key: string,
  injected: Db | undefined,
): Promise<VisibleFeatured[] | undefined> {
  const now = Date.now();
  const memory = injected ? featuredByDb.get(injected) : featuredByUrl.get(key);
  if (memory && now < memory.expiresAt) return memory.value;
  const cache = await cacheApi(env);
  if (!cache) return undefined;
  try {
    const hit = await cache.match(cacheRequest("featured", key));
    if (!hit) return undefined;
    const raw = (await hit.json()) as { items?: unknown };
    if (!raw || !Array.isArray(raw.items)) return undefined;
    const value = raw.items as VisibleFeatured[];
    const entry = { value, expiresAt: now + HOME_GUEST_CACHE_TTL_MS };
    if (injected) featuredByDb.set(injected, entry);
    else featuredByUrl.set(key, entry);
    return value;
  } catch {
    return undefined;
  }
}

function storeFeaturedCache(
  env: Env,
  key: string,
  injected: Db | undefined,
  value: VisibleFeatured[],
  ctx?: WaitUntilCtx,
): void {
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS };
  if (injected) featuredByDb.set(injected, entry);
  else featuredByUrl.set(key, entry);
  void cacheApi(env).then((cache) => {
    if (!cache) return;
    const request = cacheRequest("featured", key);
    const response = new Response(JSON.stringify({ items: value }), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${Math.floor(HOME_GUEST_CACHE_TTL_MS / 1000)}`,
      },
    });
    try {
      const put = cache.put(request, response);
      if (ctx?.waitUntil) ctx.waitUntil(put);
      // A late Cache API failure must not even warn: the read already returned.
      else put.then(undefined, () => {});
    } catch {
      // Cache failures never fail the request.
    }
  });
}

/**
 * Guest-invariant homepage teaser with a short-TTL edge layer. The merged
 * read keeps its own deadline/degrade contract; this wrapper only adds
 * cross-request reuse and never throws.
 */
export async function cachedHomeUpcoming(
  env: Env,
  openDb: () => Promise<Db | null>,
  getDiscordSource: () => DiscordEventsSource,
  now = new Date(),
  ctx?: WaitUntilCtx,
): Promise<HomeUpcomingMerged> {
  const injected = injectedDb(env);
  const key = urlKey(env);
  try {
    const hit = await readUpcomingCache(env, key, injected);
    if (hit) return hit;
  } catch {
    // Fall through to the direct read.
  }
  let value: HomeUpcomingMerged;
  try {
    value = await loadHomeUpcomingMerged(openDb, getDiscordSource, now);
  } catch {
    return { items: [], unavailable: true, discordFailed: false };
  }
  try {
    storeUpcomingCache(env, key, injected, value, ctx);
  } catch {
    // Cache failures never fail the request.
  }
  return value;
}

/** Guest-invariant featured list with the same short-TTL edge layer. Never throws. */
export async function cachedFeatured(
  env: Env,
  openDb: () => Promise<Db | null>,
  now = new Date(),
  ctx?: WaitUntilCtx,
): Promise<VisibleFeatured[]> {
  const injected = injectedDb(env);
  const key = urlKey(env);
  try {
    const hit = await readFeaturedCache(env, key, injected);
    if (hit) return hit;
  } catch {
    // Fall through to the direct read.
  }
  let value: VisibleFeatured[];
  try {
    const db = await openDb();
    value = db ? await listVisibleFeatured(db, now) : [];
  } catch {
    return [];
  }
  try {
    storeFeaturedCache(env, key, injected, value, ctx);
  } catch {
    // Cache failures never fail the request.
  }
  return value;
}
