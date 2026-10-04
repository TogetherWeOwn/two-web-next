// Bounded retry-until-miss for the staging events search journey.
//
// A search with zero local matches depends on the live Discord scheduled-events
// read (1 s deadline, src/events/discord-transients.ts). When that read fails,
// the page renders the error state instead of the miss block — "error beats
// search-miss" is a pinned product contract (src/islands/contracts.ts), so the
// harness tolerates it instead of weakening it. A single immediate retry was
// not enough on staging, so the journey now retries a bounded number of times
// with growing pauses, and fails with a message that names the cause when the
// error state outlasts the whole schedule (a persistently dark collector).
// Pure helpers only: no browser, safe to unit-test with node:test.

/** Pause before each Retry click, in order. Length = retries after the first try. */
export const SEARCH_RETRY_BACKOFF_MS = Object.freeze([2_000, 4_000, 8_000, 12_000]);

/** Worst-case wait for one attempt to settle on the miss or the error block (staging answers in 1-5 s on a slow episode). */
export const SEARCH_ATTEMPT_SETTLE_MS = 10_000;

/** Total attempts: the first search plus one per scheduled retry. */
export function searchMaxAttempts() {
  return SEARCH_RETRY_BACKOFF_MS.length + 1;
}

/** Longest the whole retry schedule can take: every pause plus every attempt's settle wait. */
export function searchRetryBudgetMs() {
  const pauses = SEARCH_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
  return pauses + searchMaxAttempts() * SEARCH_ATTEMPT_SETTLE_MS;
}

/**
 * Hard failure when every attempt rendered the error state. Names the cause
 * (the Discord collector read) so a red run points at staging health, not at
 * the search form. Carries no URL, token or query text.
 *
 * @param {number} attempts searches issued, including the first
 * @param {number} elapsedMs wall time from the first search to giving up
 */
export function searchStillErroredError(attempts, elapsedMs) {
  return new Error(
    `staging events search rendered the Discord error state on all ${attempts} attempt(s) ` +
      `over ${Math.round(elapsedMs / 1000)}s (backoff ${SEARCH_RETRY_BACKOFF_MS.join("/")} ms). ` +
      `A zero-match search needs the Discord scheduled-events read; this is a persistently ` +
      `dark collector on staging, not a one-off slow episode. Check the staging Discord read path.`,
  );
}
