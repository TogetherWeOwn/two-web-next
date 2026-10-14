// Homepage guest-invariant short-TTL cache. Counts, upcoming events and the
// published featured base are identical for guests and members, so one shared
// entry serves every viewer; the response stays `private, no-store` because it
// also embeds the per-viewer session and the one-shot join flash, which are
// never cached here. The featured window ([startsAt, endsAt)) is evaluated
// per request against the cached base, so boundary instants stay exact.
// Outage fallbacks are preserved: a cache miss or a cache failure falls
// through to the direct read, and an unavailable upcoming read is never
// stored (a stored outage would hide recovery behind the TTL). Committed
// featured and event mutations retire every entry (retireHomeGuestCache), so
// the next homepage fetch re-reads instead of serving retired rows.
import { databaseUrl } from "./db/connection";
import type { Db } from "./db/index";
import type { Env } from "./env";
import { listPublishedFeatured, type PublishedFeatured, type VisibleFeatured } from "./featured";
import { currentlyVisible } from "./featured-status";
import { loadHomeUpcomingMerged, type HomeUpcomingMerged } from "./events/reads";
import type { DiscordEventsSource } from "./events/discord-transients-types";

export const HOME_GUEST_CACHE_TTL_MS = 60_000;

type WaitUntilCtx = { waitUntil?: (promise: Promise<unknown>) => void };

type UpcomingEntry = { value: HomeUpcomingMerged; expiresAt: number; gen: number };
type FeaturedEntry = { value: PublishedFeatured[]; expiresAt: number; gen: number };

// Cross-request sharing in staging is keyed by the web-DB URL (one Hyperdrive
// binding, stable per environment). Test/dev fixtures inject ADMIN_DB instead:
// each injected object gets its own entry so hermetic fixtures never share.
const upcomingByUrl = new Map<string, UpcomingEntry>();
const featuredByUrl = new Map<string, FeaturedEntry>();
const upcomingByDb = new WeakMap<object, UpcomingEntry>();
const featuredByDb = new WeakMap<object, FeaturedEntry>();

// A committed featured or event mutation retires every entry at once: the
// WeakMaps cannot be cleared key by key, and one fixture object is routinely
// shared across cases (beforeAll + beforeEach), so entries carry the
// generation they were stored under and older generations always miss.
let generation = 0;
// Edge keys ever stored (`<kind>/<fingerprint>`), so a retire can delete the
// shared edge entries without the request env. Deterministic per environment,
// so the set stays tiny.
const edgeKeys = new Set<string>();

type EnvWithAdminDb = Env & { ADMIN_DB?: Db };

function injectedDb(env: Env): Db | undefined {
  return (env as EnvWithAdminDb).ADMIN_DB;
}

function urlKey(env: Env): string {
  return databaseUrl(env) ?? "no-db";
}

function clearMemory(): void {
  upcomingByUrl.clear();
  featuredByUrl.clear();
  generation++;
}

/**
 * Retire every homepage guest entry. Called after a committed featured or
 * event mutation (never on a refusal or a rollback), so the next homepage
 * fetch re-reads the new rows. The edge deletes are awaited so an admin
 * write's redirect only goes out once the shared layer no longer holds
 * retired bytes; otherwise the guest fetch right after the write races the
 * delete and re-seeds memory with the stale edge hit. Cross-isolate readers
 * converge when their in-memory TTL (at most HOME_GUEST_CACHE_TTL_MS)
 * lapses. Callers must await this: a fire-and-forget retire reopens the
 * race the browser suite caught (created slot invisible to the guest).
 */
export async function retireHomeGuestCache(): Promise<void> {
  clearMemory();
  if (edgeKeys.size === 0) return;
  const keys = [...edgeKeys];
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    const cache = caches.default;
    await Promise.all(
      keys.map(async (key) => {
        try {
          await cache.delete(new Request(`https://home-guest-cache.internal/${key}`));
        } catch {
          // Cache failures never fail the caller.
        }
      }),
    );
  } catch {
    // Cache failures never fail the caller.
  }
}

/**
 * Hermetic-test reset: drops the isolate-local entries (Cache API entries are
 * per-test absent) without touching the shared edge layer, so edge round-trip
 * tests can reset memory and still hit their stubbed edge entry.
 */
export function __resetHomeGuestCacheForTests(): void {
  clearMemory();
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
  if (memory && memory.gen === generation && now < memory.expiresAt) return memory.value;
  const cache = await cacheApi(env);
  if (!cache) return undefined;
  try {
    const hit = await cache.match(cacheRequest("upcoming", key));
    if (!hit) return undefined;
    const revived = reviveUpcoming(await hit.json());
    if (!revived || revived.unavailable) return undefined;
    const entry = { value: revived, expiresAt: now + HOME_GUEST_CACHE_TTL_MS, gen: generation };
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
  genAtStart?: number,
): void {
  if (value.unavailable) return;
  // A retire that landed while the DB read was in flight makes this value
  // stale already: dropping it keeps the retired rows retired instead of
  // re-seeding memory and the edge with pre-write bytes.
  if (genAtStart !== undefined && genAtStart !== generation) return;
  const storedGen = generation;
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS, gen: storedGen };
  edgeKeys.add(`upcoming/${fingerprint(key)}`);
  if (injected) upcomingByDb.set(injected, entry);
  else upcomingByUrl.set(key, entry);
  void cacheApi(env).then((cache) => {
    if (!cache) return;
    if (storedGen !== generation) return;
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

function reviveBound(input: unknown): Date | null | undefined {
  if (input === null) return null;
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  if (typeof input === "string") {
    const parsed = new Date(input);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return undefined;
}

function reviveFeatured(raw: unknown): PublishedFeatured[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  const value: PublishedFeatured[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number" || typeof row.title !== "string") return undefined;
    for (const field of ["body", "url", "imageUrl", "imageAlt"] as const) {
      if (row[field] !== null && typeof row[field] !== "string") return undefined;
    }
    const startsAt = reviveBound(row.startsAt);
    const endsAt = reviveBound(row.endsAt);
    if (startsAt === undefined || endsAt === undefined) return undefined;
    value.push({
      id: row.id,
      title: row.title,
      body: row.body as string | null,
      url: row.url as string | null,
      imageUrl: row.imageUrl as string | null,
      imageAlt: row.imageAlt as string | null,
      startsAt,
      endsAt,
    });
  }
  return value;
}

async function readFeaturedCache(
  env: Env,
  key: string,
  injected: Db | undefined,
): Promise<PublishedFeatured[] | undefined> {
  const now = Date.now();
  const memory = injected ? featuredByDb.get(injected) : featuredByUrl.get(key);
  if (memory && memory.gen === generation && now < memory.expiresAt) return memory.value;
  const cache = await cacheApi(env);
  if (!cache) return undefined;
  try {
    const hit = await cache.match(cacheRequest("featured", key));
    if (!hit) return undefined;
    const value = reviveFeatured(await hit.json());
    if (!value) return undefined;
    const entry = { value, expiresAt: now + HOME_GUEST_CACHE_TTL_MS, gen: generation };
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
  value: PublishedFeatured[],
  ctx?: WaitUntilCtx,
  genAtStart?: number,
): void {
  // Same in-flight retire guard as the upcoming store: a value read before
  // the write committed must never overwrite the retire.
  if (genAtStart !== undefined && genAtStart !== generation) return;
  const storedGen = generation;
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS, gen: storedGen };
  edgeKeys.add(`featured/${fingerprint(key)}`);
  if (injected) featuredByDb.set(injected, entry);
  else featuredByUrl.set(key, entry);
  void cacheApi(env).then((cache) => {
    if (!cache) return;
    if (storedGen !== generation) return;
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
  const genAtStart = generation;
  let value: HomeUpcomingMerged;
  try {
    value = await loadHomeUpcomingMerged(openDb, getDiscordSource, now);
  } catch {
    return { items: [], unavailable: true, discordFailed: false };
  }
  try {
    storeUpcomingCache(env, key, injected, value, ctx, genAtStart);
  } catch {
    // Cache failures never fail the request.
  }
  return value;
}

/**
 * Guest-invariant featured list with the same short-TTL edge layer. The
 * cached base is the published list; the window is evaluated per request, so
 * consecutive reads at different instants each see their own visibility.
 * Never throws.
 */
export async function cachedFeatured(
  env: Env,
  openDb: () => Promise<Db | null>,
  now = new Date(),
  ctx?: WaitUntilCtx,
): Promise<VisibleFeatured[]> {
  const visibleAt = (rows: PublishedFeatured[]): VisibleFeatured[] =>
    rows.filter((row) =>
      currentlyVisible({ isPublished: true, startsAt: row.startsAt, endsAt: row.endsAt }, now),
    );
  const injected = injectedDb(env);
  const key = urlKey(env);
  try {
    const hit = await readFeaturedCache(env, key, injected);
    if (hit) return visibleAt(hit);
  } catch {
    // Fall through to the direct read.
  }
  const genAtStart = generation;
  let value: PublishedFeatured[];
  try {
    const db = await openDb();
    value = db ? await listPublishedFeatured(db) : [];
  } catch {
    return [];
  }
  try {
    storeFeaturedCache(env, key, injected, value, ctx, genAtStart);
  } catch {
    // Cache failures never fail the request.
  }
  return visibleAt(value);
}
