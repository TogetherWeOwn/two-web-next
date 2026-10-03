import type { Sql } from "../../src/sessions";

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

// checkJoinThrottle admits inside `sql.begin` after a per-bucket advisory lock
// (TOG-11188). In-memory Sql doubles are single-threaded, so give them the
// transaction seam by running the callback inline against the wrapper itself,
// and treat the lock statement as the no-op it is for a single caller. Every
// other statement still reaches the wrapped double unchanged, so its
// "unexpected statement" guards and call counts keep their meaning. Real
// concurrency is covered against Postgres in human-throttle-concurrency.test.ts.
export function withThrottleTx(double: Sql): Sql {
  const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    (strings[0] ?? "").includes("pg_advisory_xact_lock")
      ? Promise.resolve([])
      : (double as unknown as Tag)(strings, ...values)) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  const unsafe = (double as { unsafe?: unknown }).unsafe;
  if (unsafe) (wrapped as { unsafe?: unknown }).unsafe = unsafe;
  wrapped.begin = (run) => run(wrapped);
  return wrapped;
}
