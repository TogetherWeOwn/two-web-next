import {
  runServingIsolation,
  ServingIsolationCleanupError,
} from "./db-serving-ledger-isolation.mjs";

try {
  const result = await runServingIsolation(process.argv[2], process.argv[3], process.env);
  process.exitCode = { committed: 0, before: 10, after: 11 }[result] ?? 1;
} catch (error) {
  process.exitCode =
    error instanceof ServingIsolationCleanupError && error.outcome === "committed" ? 12 : 1;
}
