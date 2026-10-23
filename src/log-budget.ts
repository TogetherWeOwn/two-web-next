// Rate-limited warn with a bounded shed signal, per the CSP sink precedent.
//
// Ports the token-bucket + shed shape from src/csp-reports.ts
// (takeCspLogToken + warnCspShed): one in-memory bucket per isolate per
// instance, shared by the warn lines that use it. Sampling alone cannot bound
// log volume; a bucket lets a body-spraying prober or a broken-config deploy
// emit a bounded number of warns instead of one line per refusal, and the
// shed line tells operators a shedding leg from a quiet one.
//
// This is not a global request limit: isolates refill/reset independently.
// Callers keep their exact refusal behavior; only the telemetry is bounded.
//
// Budgets are fixed-size isolate state (no client keys, no timers). Consume
// synchronously just before logging so concurrent reads cannot overspend.

const DEFAULT_BURST = 20;
const DEFAULT_REFILL_MS = 3_000;

export type RateLimitedWarn = {
  /** Warn when the bucket admits, else count a drop toward the shed signal. */
  warn: (line: string, fields: Record<string, string | number | boolean | null>) => void;
};

/**
 * One bucket plus its shed line. `shedLine` carries only `{ dropped }`, a
 * positive integer count of log-budget drops since the previous shed emit, at
 * most one emit per refill window. Fields stay scalar-or-null: never pass a
 * body, token, cookie, secret, or member identity.
 */
export function createRateLimitedWarn(opts: {
  shedLine: string;
  burst?: number;
  refillMs?: number;
}): RateLimitedWarn {
  const burst = opts.burst ?? DEFAULT_BURST;
  const refillMs = opts.refillMs ?? DEFAULT_REFILL_MS;
  let tokens = burst;
  let lastRefill = 0;
  let shedDropped = 0;
  let lastShedEmit = 0;

  const take = (): boolean => {
    const now = Date.now();
    const elapsed = Math.max(0, now - lastRefill);
    tokens = Math.min(burst, tokens + elapsed / refillMs);
    lastRefill = Math.max(lastRefill, now);
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const shed = (): void => {
    shedDropped += 1;
    const now = Date.now();
    if (now - lastShedEmit < refillMs) return;
    lastShedEmit = now;
    const dropped = shedDropped;
    console.warn(opts.shedLine, { dropped });
    shedDropped -= dropped;
  };

  return {
    warn: (line, fields) => {
      if (take()) console.warn(line, fields);
      else shed();
    },
  };
}
