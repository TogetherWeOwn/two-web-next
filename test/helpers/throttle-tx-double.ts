import type { Sql } from "../../src/sessions";

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

// checkJoinThrottle admits inside `sql.begin` after a per-bucket advisory lock
// (TOG-11188), itself preceded by `SET LOCAL lock_timeout` through `unsafe`.
// In-memory Sql doubles are single-threaded, so give them the transaction seam
// by running the callback inline against the wrapper itself, and treat the
// lock statement as the no-op it is for a single caller. Every other statement
// still reaches the wrapped double unchanged, so its "unexpected statement"
// guards and call counts keep their meaning. The `unsafe` passthrough defaults
// to a no-op (the lock timeout is a no-op for a single caller, like the lock)
// and still forwards a recording double when one is given. Real concurrency is
// covered against Postgres in human-throttle-concurrency.test.ts.
export function withThrottleTx(double: Sql): Sql {
  const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    (strings[0] ?? "").includes("pg_advisory_xact_lock")
      ? Promise.resolve([])
      : (double as unknown as Tag)(strings, ...values)) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (wrapped as { unsafe?: unknown }).unsafe =
    (double as { unsafe?: unknown }).unsafe ?? (async () => []);
  wrapped.begin = (run) => run(wrapped);
  return wrapped;
}
