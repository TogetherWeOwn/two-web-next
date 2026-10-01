import { performance } from "node:perf_hooks";

type FixtureKind = "member-data" | "users-profiles";
type DbPhase = "create" | "migration-read" | "migrate" | "seed" | "reset" | "dispose";

// Measure in the worker, not from batched reporter hook-delivery timestamps.
// Source: https://nodejs.org/api/perf_hooks.html#performancenow
export function startDbPhase(fixture: FixtureKind, phase: DbPhase) {
  if (process.env.TEST_TIMINGS !== "1") return (_ok = true) => {};
  const start = performance.now();
  return (ok = true) => {
    // Diagnostics cannot replace a fixture result or its original exception.
    try {
      console.log(`TWO_TEST_TIMING ${JSON.stringify({
        kind: "db", fixture, phase, elapsedMs: performance.now() - start, ok,
      })}`);
    } catch {}
  };
}
