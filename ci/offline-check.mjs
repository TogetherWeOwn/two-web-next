import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) {
  console.error("check:offline does not accept arguments; its fixture-only exclusion is fixed.");
  process.exit(1);
}

const cwd = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === "DATABASE_URL" || key === "AUDIT_IMPORT_TEST_DATABASE_URL" || key === "W1_AGENT_TESTDB" || key.startsWith("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_") || key.startsWith("PG")) {
    delete env[key];
  }
}
const a11yTests = readdirSync(new URL("./", import.meta.url))
  .filter(file => file.startsWith("a11y-") && file.endsWith(".test.mjs"))
  .sort()
  .map(file => `ci/${file}`);
const commands = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "config:check"]],
  // This suite opens SQL even without DATABASE_URL; the other SQL suites skip.
  ["npm", ["run", "test", "--", "--exclude", "test/review-p1-verify.test.ts"]],
  [process.execPath, ["--test", ...a11yTests]],
  ["npm", ["run", "test:cutover"]],
  // Smoke self-tests answer a stubbed local HTTP server; they never reach a Worker or database.
  ["npm", ["run", "test:smoke"]],
];

console.log("Fixture-only check: SQL suites skipped/excluded; limited evidence, not database acceptance.");
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`Fixture-only check stopped at ${args[1] ?? command}.`);
    process.exit(result.status ?? 1);
  }
}
console.log("Fixture-only checks passed: limited evidence, not a substitute for exact-head CI with service-container DB coverage.");
