// Poll pg_stat_activity until no lock waiter remains, returning whether the
// count reached zero before the stated deadline. Follows the waitForEventLock
// precedent in test/event-mutation-invariants.test.ts: performance's real
// clock bounds the wait even while the application Date is frozen, with a
// short poll interval. Call sites keep their explicit expect(...).toBe(true)
// so the zero-waiters pin stays a visible assertion.
export async function waitForNoLockWaiters(
  readCount: () => Promise<number>,
  options: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 2000 },
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
