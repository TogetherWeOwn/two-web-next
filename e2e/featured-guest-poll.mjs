// Guest-convergence poll budget for the staging featured journey.
//
// The homepage guest cache (src/home-cache.ts) is isolate-local: a featured
// mutation retires the entry in the mutating isolate immediately, but every
// other isolate keeps serving its stored entry until expiry. A guest read
// can therefore miss a fresh (or freshly renamed/deleted) featured slot for
// up to the cache TTL after the write. The journey asserts authoritative
// guest visibility, so its poll must outlast that convergence bound instead
// of racing it. Pure helpers only: no browser, safe to unit-test with
// node:test.

/** Documented worst case for a non-mutating isolate to converge: mirrors HOME_GUEST_CACHE_TTL_MS in src/home-cache.ts. */
export const GUEST_CACHE_CONVERGENCE_BOUND_MS = 60_000;

/** Margin past the bound for the homepage's own read deadline and runner jitter. */
const CONVERGENCE_MARGIN_MS = 15_000;

/** Longest one guest-visibility poll may run: the convergence bound plus margin. */
export const FEATURED_GUEST_POLL_TIMEOUT_MS =
  GUEST_CACHE_CONVERGENCE_BOUND_MS + CONVERGENCE_MARGIN_MS;

/** Poll cadence, unchanged from the original journey. */
export const FEATURED_GUEST_POLL_INTERVALS_MS = Object.freeze([1_000, 2_000, 3_000]);

/** The journey's non-poll work (moderator create/edit/delete plus assertions). */
const FEATURED_JOURNEY_BASE_MS = 60_000;

/** expect.poll options for one guest-visibility check. */
export function featuredGuestPoll() {
  return {
    timeout: FEATURED_GUEST_POLL_TIMEOUT_MS,
    intervals: [...FEATURED_GUEST_POLL_INTERVALS_MS],
  };
}

/** Worst case for the whole journey: its own work plus three full guest polls. */
export function featuredJourneyTimeoutMs() {
  return FEATURED_JOURNEY_BASE_MS + 3 * FEATURED_GUEST_POLL_TIMEOUT_MS;
}
