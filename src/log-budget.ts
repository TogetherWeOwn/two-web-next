/** Independent isolate budget: burst 20, refill one token per 3 seconds.
 * Consume synchronously just before logging. A refused token counts a drop and
 * emits at most one shed warn per 3 seconds; no request data, keys or timers. */
export function createLogBudget(shedEvent: string): () => boolean {
  let tokens = 20;
  let lastRefill = 0;
  let dropped = 0;
  let lastShed = 0;
  return () => {
    const now = Date.now();
    tokens = Math.min(20, tokens + Math.max(0, now - lastRefill) / 3_000);
    lastRefill = Math.max(lastRefill, now);
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    dropped += 1;
    const shedNow = Date.now();
    if (shedNow - lastShed >= 3_000) {
      lastShed = shedNow;
      const pending = dropped;
      console.warn(shedEvent, { dropped: pending });
      dropped -= pending;
    }
    return false;
  };
}
