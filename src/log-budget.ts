type LogBudgetOptions = {
  shedLine: string;
  burst?: number;
  refillMs?: number;
};

/** Independent isolate budget: default burst 20, refill one token per 3 seconds.
 * Consume synchronously just before logging. A refused token counts a drop and
 * emits at most one shed warn per refill window; no request data, keys or timers. */
function createBudget({ shedLine, burst = 20, refillMs = 3_000 }: LogBudgetOptions): () => boolean {
  let tokens = burst;
  let lastRefill = 0;
  let pending = 0;
  let lastShed = 0;
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + Math.max(0, now - lastRefill) / refillMs);
    lastRefill = Math.max(lastRefill, now);
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    pending += 1;
    const shedNow = Date.now();
    if (shedNow - lastShed >= refillMs) {
      lastShed = shedNow;
      const dropped = pending;
      console.warn(shedLine, { dropped });
      pending -= dropped;
    }
    return false;
  };
}

export function createLogBudget(shedEvent: string): () => boolean {
  return createBudget({ shedLine: shedEvent });
}

export type RateLimitedWarn = {
  /** Warn when the bucket admits, else count a drop toward the shed signal. */
  warn: (line: string, fields: Record<string, string | number | boolean | null>) => void;
};

/** Fields must stay scalar-or-null: never body, token, secret or member identity.
 * Each instance owns its bucket; it never spends another telemetry leg's tokens. */
export function createRateLimitedWarn(opts: LogBudgetOptions): RateLimitedWarn {
  const take = createBudget(opts);
  return {
    warn: (line, fields) => {
      if (take()) console.warn(line, fields);
    },
  };
}
