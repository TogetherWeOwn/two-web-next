// Bounded retry-until-miss schedule for the staging events search journey.
//
// Pure helpers only (no browser): the schedule is finite, grows, and the
// failure message names the cause without leaking anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEARCH_ATTEMPT_SETTLE_MS,
  SEARCH_RETRY_BACKOFF_MS,
  searchMaxAttempts,
  searchRetryBudgetMs,
  searchStillErroredError,
} from "./search-retry.mjs";

test("the retry schedule is bounded and non-empty", () => {
  assert.ok(SEARCH_RETRY_BACKOFF_MS.length >= 1);
  assert.ok(SEARCH_RETRY_BACKOFF_MS.length <= 6, "retries stay bounded");
  assert.equal(searchMaxAttempts(), SEARCH_RETRY_BACKOFF_MS.length + 1);
});

test("pauses never shrink, so a longer outage gets a longer wait", () => {
  for (let i = 1; i < SEARCH_RETRY_BACKOFF_MS.length; i++) {
    assert.ok(SEARCH_RETRY_BACKOFF_MS[i] >= SEARCH_RETRY_BACKOFF_MS[i - 1]);
  }
});

test("the worst-case budget is every pause plus every attempt's settle wait", () => {
  const pauses = SEARCH_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.equal(searchRetryBudgetMs(), pauses + searchMaxAttempts() * SEARCH_ATTEMPT_SETTLE_MS);
  assert.ok(searchRetryBudgetMs() < 120_000, "one project's retries stay under two minutes");
});

test("the schedule is frozen so a spec cannot mutate it mid-run", () => {
  assert.ok(Object.isFrozen(SEARCH_RETRY_BACKOFF_MS));
});

test("the persistent-failure error names the cause and the attempt count", () => {
  const message = searchStillErroredError(5, 26_400).message;
  assert.match(message, /all 5 attempt\(s\)/);
  assert.match(message, /26s/);
  assert.match(message, /persistently\s+dark collector/);
  assert.match(message, /Discord/);
});
