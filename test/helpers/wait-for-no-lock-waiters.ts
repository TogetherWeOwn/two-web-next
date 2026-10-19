// Poll pg_stat_activity until no lock waiter remains, returning whether the
// count reached zero before the stated deadline. Follows the waitForEventLock
// precedent in test/event-mutation-invariants.test.ts: performance's real
// clock bounds the wait even while the application Date is frozen, with a
// short poll interval. Call sites keep their explicit expect(...).toBe(true)
// so the zero-waiters pin stays a visible assertion.
//
// Deadline is justified from the product caps, not wall-clock generosity:
// the DB-side lock/statement caps are 250ms (featured) and 400ms
// (search/board), each below its 500ms response race, so a correctly capped
// backend leaves no waiter more than ~400ms after the read returns (plus
// scheduling lag). 800ms covers that lag but still fails a mutant that
// enlarges a cap to 1400ms (which leaves a ~900ms residual waiter, caught by
// mutant proof head-pass/base-fail). Do not raise this without re-proving
// the mutant.
export async function waitForNoLockWaiters(
  readCount: () => Promise<number>,
  options: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 800 },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if ((await readCount()) === 0) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
