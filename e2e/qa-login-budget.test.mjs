// Local smoke QA-login budget guard (MAIN-RED FIX).
//
// POST /auth/qa/:identity shares the `qa-login` throttle
// (AUTH_THROTTLE_PER_MINUTE per runner IP, src/throttle.ts) across the whole
// sequential browser-smoke job, and every login call spends it — good, bad, or
// otherwise. A Retry-After wait long enough to cross the window boundary does
// not fit the 30 s test timeout, so each step must stay at or under the
// budget. The job runs three login-bearing steps behind 70 s workflow sleeps
// (.github/workflows/e2e.yml) so each 60 s rolling window holds only its own
// step's logins; this static test counts every login site in every step and
// fails loudly when a new site would push any step over, pointing at the fix
// direction (fewer logins, not retries).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const e2eDir = new URL(".", import.meta.url);

function readBudget() {
  const source = readFileSync(new URL("../src/throttle.ts", import.meta.url), "utf8");
  const match = source.match(/AUTH_THROTTLE_PER_MINUTE\s*=\s*(\d+)/);
  assert.ok(match, "AUTH_THROTTLE_PER_MINUTE not found in src/throttle.ts");
  return Number.parseInt(match[1], 10);
}

function countSpecLogins() {
  const files = readdirSync(e2eDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(files.length > 0, "no e2e spec files found");
  return files.map((file) => {
    const source = readFileSync(new URL(`./${file}`, e2eDir), "utf8");
    const calls = source.match(/await\s+qaLogin\s*\(/g) ?? [];
    return { file, count: calls.length };
  });
}

function countTeardownLogins() {
  const source = readFileSync(new URL("./local-global-teardown.ts", e2eDir), "utf8");
  return (source.match(/\/auth\/qa\//g) ?? []).length;
}

function countParityLogins() {
  const dir = new URL("./kit-parity/", e2eDir);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(files.length > 0, "no kit-parity spec files found");
  return files.map((file) => {
    const source = readFileSync(new URL(`./${file}`, dir), "utf8");
    const calls = source.match(/\.post\(\s*["']\/auth\/qa\//g) ?? [];
    return { file: `kit-parity/${file}`, count: calls.length };
  });
}

function countAuthPerfLogins() {
  const raw = readFileSync(new URL("../ci/auth-perf-budget.json", import.meta.url), "utf8");
  const budget = JSON.parse(raw);
  assert.ok(
    budget.journeys && typeof budget.journeys === "object",
    "auth-perf budget has no journeys",
  );
  // ci/check-auth-perf.mjs mints one QA session per journey identity.
  return Object.keys(budget.journeys).length;
}

function countPacingSleeps() {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  return (workflow.match(/run: sleep 70/g) ?? []).length;
}

test("every browser-smoke step holds its own QA logins under the throttle budget", () => {
  const budget = readBudget();
  const specs = countSpecLogins();
  const specTotal = specs.reduce((sum, row) => sum + row.count, 0);
  const specBreakdown = specs
    .filter((row) => row.count > 0)
    .map((row) => `${row.file}: ${row.count}`)
    .join(", ");
  const teardown = countTeardownLogins();
  const parity = countParityLogins();
  const parityTotal = parity.reduce((sum, row) => sum + row.count, 0);
  const parityBreakdown = parity
    .filter((row) => row.count > 0)
    .map((row) => `${row.file}: ${row.count}`)
    .join(", ");
  const authPerf = countAuthPerfLogins();
  const sleeps = countPacingSleeps();

  assert.equal(
    teardown,
    0,
    `local teardown performs ${teardown} QA login(s): the sweep is DB-direct ` +
      `and must spend none of the shared qa-login budget.`,
  );
  assert.ok(
    sleeps >= 2,
    `e2e.yml holds ${sleeps} throttle pacing sleep(s), need at least 2 (after ` +
      `the browser suite and after parity): without them the steps share one ` +
      `60 s window and their combined logins 429.`,
  );
  assert.ok(
    specTotal <= budget,
    `browser suite performs ${specTotal} QA logins against the shared qa-login ` +
      `throttle (${budget}/min per runner IP): ${specBreakdown}. Merge journeys ` +
      `onto fewer logins (one login per file where the flow allows) rather ` +
      `than retrying across the window — the wait does not fit the 30 s test ` +
      `timeout.`,
  );
  assert.ok(
    parityTotal <= budget,
    `kit-parity performs ${parityTotal} QA logins against the shared qa-login ` +
      `throttle (${budget}/min per runner IP): ${parityBreakdown}. Reuse the ` +
      `shared bearer instead of minting new sessions.`,
  );
  assert.ok(
    authPerf <= budget,
    `auth-perf performs ${authPerf} QA logins (one per journey in ` +
      `ci/auth-perf-budget.json) against the shared qa-login throttle ` +
      `(${budget}/min per runner IP). Reuse sessions instead of adding journeys.`,
  );
});
