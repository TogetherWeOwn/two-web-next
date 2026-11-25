import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Route only the migration runner's driver import to a synthetic client.
const migrationModule = new URL("../db-migrate.mjs", import.meta.url).href;
const driver = encodeURIComponent(
  "export default (...args) => globalThis.isolationClient(...args)",
);
let driverReplaced = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "postgres" && context.parentURL === migrationModule) {
      driverReplaced = true;
      return { url: `data:text/javascript,${driver}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { prepareServingIsolationOutcome } = await import("./web-serving-isolation-outcome.mjs");
assert.ok(driverReplaced, "The migration driver must be replaced before supplying fixture inputs");
const { run, faults } = await prepareServingIsolationOutcome(process.env.ISOLATION_FIXTURE_STATE);
if (process.env.ISOLATION_FIXTURE_CLOSE === "fail")
  faults.close = new Error("synthetic close failure");
if (process.env.ISOLATION_FIXTURE_STATEMENT === "fail") {
  faults.statement = new Error("synthetic statement failure");
}
if (process.env.ISOLATION_FIXTURE_ACKNOWLEDGEMENT === "fail") {
  faults.acknowledgement = new Error("synthetic missing commit acknowledgement");
}
await run(process.argv[2], {
  execute(_operation, _end, env, { connect, fetchImpl }) {
    Object.assign(process.env, env);
    globalThis.fetch = fetchImpl;
    globalThis.isolationClient = (_, options) =>
      connect(null, { readOnly: options.fetch_types === false });
  },
});
