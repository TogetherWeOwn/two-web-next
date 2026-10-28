// Homepage guest-invariant short-TTL cache (isolate-local). Counts, upcoming
// events and the published featured base are identical for guests and members,
// so one shared entry serves every viewer; the response stays
// `private, no-store` because it also embeds the per-viewer session and the
// one-shot join flash, which are never cached here. The featured window
// ([startsAt, endsAt)) is evaluated per request against the cached base, so
// boundary instants stay exact.
// Outage fallbacks are preserved: a cache miss or a cache failure falls
// through to the direct read, and an unavailable upcoming read is never
// stored (a stored outage would hide recovery behind the TTL). A
// Discord-degraded upcoming read is never stored either: with canonical rows
// present but Discord failed or timed out, storing the degraded list would
// hide Discord recovery for the full TTL on top of the snapshot store's own
// failure hold. Committed featured and event mutations retire every entry
// (retireHomeGuestCache), so the next homepage fetch re-reads instead of
// serving retired rows.
//
// Entries are isolate-local, like `src/events/anon-cache.ts` and `src/counts.ts`:
// the mutating isolate retires immediately, every other isolate converges on
// expiry (at most HOME_GUEST_CACHE_TTL_MS from the last write). Hits never
// extend the entry's expiry. A read already in flight when a retire lands
// never settles its pre-retire bytes: each read captures the retire
// generation before its DB lookup and stores only when the generation is
// unchanged. The Worker Cache API would share entries across isolates, but a
// shared retire is not provable here (retire-by-enumeration needs `keys()`,
// and a retire from an isolate that never stored a key would leave the shared
// entry in place to re-seed memory), so there is no edge layer — memory only.
import { databaseUrl } from "./db/connection";
import type { Db } from "./db/index";
import type { Env } from "./env";
import { listPublishedFeatured, type PublishedFeatured, type VisibleFeatured } from "./featured";
import { currentlyVisible } from "./featured-status";
import { loadHomeUpcomingMerged, type HomeUpcomingMerged } from "./events/reads";
import type { DiscordEventsSource } from "./events/discord-transients-types";
import { safeRequestId } from "./request-log";

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
 * fetch in this isolate re-reads the new rows. Other isolates converge when
 * their in-memory TTL (at most HOME_GUEST_CACHE_TTL_MS) lapses, the same
 * bound `src/events/anon-cache.ts` accepts. Callers must await this so the
 * generation bump lands before the write's redirect goes out.
 */
export async function retireHomeGuestCache(): Promise<void> {
  clearMemory();
}

/**
 * Hermetic-test reset: drops the isolate-local entries without a mutation.
 */
export function __resetHomeGuestCacheForTests(): void {
  clearMemory();
}

function readUpcomingMemory(key: string, injected: Db | undefined): HomeUpcomingMerged | undefined {
  const now = Date.now();
  const memory = injected ? upcomingByDb.get(injected) : upcomingByUrl.get(key);
  if (memory && memory.gen === generation && now < memory.expiresAt) return memory.value;
  return undefined;
}

function storeUpcomingMemory(
  key: string,
  injected: Db | undefined,
  value: HomeUpcomingMerged,
  genAtStart?: number,
): void {
  // A degraded or unavailable read is never stored: a stored outage or a
  // stored Discord failure would hide recovery behind the TTL (the browser
  // suite caught a created slot invisible to the guest under load, and a slow
  // Discord read would hide Discord events the same way).
  if (value.unavailable || value.discordFailed) return;
  // A retire that landed while the DB read was in flight makes this value
  // stale already: dropping it keeps the retired rows retired instead of
  // re-seeding memory with pre-write bytes.
  if (genAtStart !== undefined && genAtStart !== generation) return;
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS, gen: generation };
  if (injected) upcomingByDb.set(injected, entry);
  else upcomingByUrl.set(key, entry);
}

function readFeaturedMemory(
  key: string,
  injected: Db | undefined,
): PublishedFeatured[] | undefined {
  const now = Date.now();
  const memory = injected ? featuredByDb.get(injected) : featuredByUrl.get(key);
  if (memory && memory.gen === generation && now < memory.expiresAt) return memory.value;
  return undefined;
}

function storeFeaturedMemory(
  key: string,
  injected: Db | undefined,
  value: PublishedFeatured[],
  genAtStart?: number,
): void {
  // An empty base is never stored: a deadline fallback reads as [] exactly
  // like a genuinely empty table, and a stored outage would hide recovery
  // behind the TTL (same principle as the upcoming `unavailable` guard; the
  // browser suite caught a created slot invisible to the guest under load).
  // A genuinely empty table simply re-reads until a retire-then-write adds
  // the first row.
  if (value.length === 0) return;
  // Same in-flight retire guard as the upcoming store: a value read before
  // the write committed must never overwrite the retire.
  if (genAtStart !== undefined && genAtStart !== generation) return;
  const entry = { value, expiresAt: Date.now() + HOME_GUEST_CACHE_TTL_MS, gen: generation };
  if (injected) featuredByDb.set(injected, entry);
  else featuredByUrl.set(key, entry);
}

/**
 * Guest-invariant homepage teaser with a short-TTL isolate-local layer. The
 * merged read keeps its own deadline/degrade contract; this wrapper only adds
 * cross-request reuse and never throws.
 */
export async function cachedHomeUpcoming(
  env: Env,
  openDb: () => Promise<Db | null>,
  getDiscordSource: () => DiscordEventsSource,
  now = new Date(),
  ctx?: WaitUntilCtx,
  requestId?: string,
): Promise<HomeUpcomingMerged> {
  void ctx;
  const injected = injectedDb(env);
  const key = urlKey(env);
  try {
    const hit = readUpcomingMemory(key, injected);
    if (hit) return hit;
  } catch {
    // Fall through to the direct read.
  }
  const genAtStart = generation;
  let value: HomeUpcomingMerged;
  try {
    value = await loadHomeUpcomingMerged(openDb, getDiscordSource, now, requestId);
  } catch {
    return { items: [], unavailable: true, discordFailed: false };
  }
  try {
    storeUpcomingMemory(key, injected, value, genAtStart);
  } catch {
    // Cache failures never fail the request.
  }
  return value;
}

/**
 * Guest-invariant featured list with the same short-TTL isolate-local layer.
 * The cached base is the published list; the window is evaluated per request,
 * so consecutive reads at different instants each see their own visibility.
 * Never throws.
 */
export async function cachedFeatured(
  env: Env,
  openDb: () => Promise<Db | null>,
  now = new Date(),
  ctx?: WaitUntilCtx,
  requestId?: string,
): Promise<VisibleFeatured[]> {
  void ctx;
  // Filter the published base to the live window, then project back to the
  // six VisibleFeatured display fields: the Kit load serializes this return
  // value (served at __data.json even with csr=false), so the scheduling
  // bounds must stay in the cached base and never reach the load data.
  const visibleAt = (rows: PublishedFeatured[]): VisibleFeatured[] =>
    rows
      .filter((row) =>
        currentlyVisible({ isPublished: true, startsAt: row.startsAt, endsAt: row.endsAt }, now),
      )
      .map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        url: row.url,
        imageUrl: row.imageUrl,
        imageAlt: row.imageAlt,
      }));
  const injected = injectedDb(env);
  const key = urlKey(env);
  try {
    const hit = readFeaturedMemory(key, injected);
    if (hit) return visibleAt(hit);
  } catch {
    // Fall through to the direct read.
  }
  const genAtStart = generation;
  let value: PublishedFeatured[];
  try {
    const db = await openDb();
    // The fill passes the request time so already-ended published rows are
    // excluded before the row cap instead of crowding live rows out of the
    // base; the per-request window below still judges every cached row, so
    // boundary instants stay exact.
    value = db ? await listPublishedFeatured(db, now) : [];
  } catch {
    // Mirror warnHomeFallback (src/events/reads.ts): the bounded exception
    // class plus the validated request id, never driver text, SQL or
    // identities. A null handle or a genuinely empty table stays silent;
    // only a failed read warns, and the empty-list fallback is unchanged.
    console.warn("Home featured unavailable; serving the fallback.", {
      request_id: safeRequestId(requestId),
      exception: "ReadFailure",
    });
    return [];
  }
  try {
    storeFeaturedMemory(key, injected, value, genAtStart);
  } catch {
    // Cache failures never fail the request.
  }
  return visibleAt(value);
}
