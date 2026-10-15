// Guest-convergence poll budget for the staging featured journey.
//
// Pure helpers only (no browser): the poll must outlast the documented
// guest-cache convergence bound, and the journey timeout must cover
// every poll it can spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURED_GUEST_POLL_INTERVALS_MS,
  FEATURED_GUEST_POLL_TIMEOUT_MS,
  GUEST_CACHE_CONVERGENCE_BOUND_MS,
  featuredGuestPoll,
  featuredJourneyTimeoutMs,
} from "./featured-guest-poll.mjs";

test("the guest poll outlasts the cache convergence bound", () => {
  assert.ok(
    FEATURED_GUEST_POLL_TIMEOUT_MS > GUEST_CACHE_CONVERGENCE_BOUND_MS,
    "a poll at or under the bound can expire before a non-mutating isolate converges",
  );
});

test("the convergence bound mirrors the homepage guest-cache TTL", () => {
  // src/home-cache.ts: HOME_GUEST_CACHE_TTL_MS = 60_000. If that TTL
  // changes, this bound (and the poll above it) must change with it.
  assert.equal(GUEST_CACHE_CONVERGENCE_BOUND_MS, 60_000);
});

test("the poll keeps the existing cadence and is frozen", () => {
  assert.deepEqual([...FEATURED_GUEST_POLL_INTERVALS_MS], [1_000, 2_000, 3_000]);
  assert.ok(Object.isFrozen(FEATURED_GUEST_POLL_INTERVALS_MS));
  assert.deepEqual(featuredGuestPoll(), {
    timeout: FEATURED_GUEST_POLL_TIMEOUT_MS,
    intervals: FEATURED_GUEST_POLL_INTERVALS_MS,
  });
});

test("the journey timeout covers three full guest polls plus the journey itself", () => {
  assert.ok(featuredJourneyTimeoutMs() > 3 * FEATURED_GUEST_POLL_TIMEOUT_MS);
  assert.equal(featuredJourneyTimeoutMs(), 60_000 + 3 * FEATURED_GUEST_POLL_TIMEOUT_MS);
});
