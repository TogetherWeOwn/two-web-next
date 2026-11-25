import {
  runServingIsolation,
  ServingIsolationCleanupError,
} from "./db-serving-ledger-isolation.mjs";

export async function runServingIsolationCli(operation, end, env, options) {
  try {
    const result = await runServingIsolation(operation, end, env, options);
    return { committed: 0, before: 10, after: 11 }[result] ?? 1;
  } catch (error) {
    if (error instanceof ServingIsolationCleanupError && error.outcome === "committed") return 12;
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runServingIsolationCli(process.argv[2], process.argv[3], process.env);
}
