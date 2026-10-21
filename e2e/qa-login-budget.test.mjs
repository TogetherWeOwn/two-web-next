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

// playwright.config.ts runs testDir ./e2e with testMatch **/*.spec.ts and
// testIgnore **/{staging,watch,explore,kit-parity}/**: the census must walk
// the same tree, or specs the runner executes stay invisible to the budget.
const PLAYWRIGHT_IGNORED_DIRS = new Set(["staging", "watch", "explore", "kit-parity"]);

function collectSpecFiles(dirUrl, prefix, out = []) {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory() && !PLAYWRIGHT_IGNORED_DIRS.has(entry.name)) {
      collectSpecFiles(new URL(`./${entry.name}/`, dirUrl), `${prefix}${entry.name}/`, out);
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

function readBudget() {
  const source = readFileSync(new URL("../src/throttle.ts", import.meta.url), "utf8");
  const match = source.match(/AUTH_THROTTLE_PER_MINUTE\s*=\s*(\d+)/);
  assert.ok(match, "AUTH_THROTTLE_PER_MINUTE not found in src/throttle.ts");
  return Number.parseInt(match[1], 10);
}

function countSpecLogins() {
  const files = collectSpecFiles(e2eDir, "").sort();
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
  const files = collectSpecFiles(dir, "").sort();
  assert.ok(files.length > 0, "no kit-parity spec files found");
  return files.map((file) => {
    const source = readFileSync(new URL(`./${file}`, dir), "utf8");
    // Quote-agnostic: fixtures post template literals (`/auth/qa/${id}`) and
    // these callsites have been refactored before, so a quote-only match that
    // sees zero logins must not read as a clean budget.
    const calls = source.match(/\.post\(\s*["'`]\/auth\/qa\//g) ?? [];
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

function pacingPositions() {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const journeys = workflow.indexOf("name: Critical browser journeys");
  const parity = workflow.indexOf("playwright.kit-parity.config.ts");
  const authPerf = workflow.indexOf("name: Authenticated perf budgets");
  // Anchored to real `run:` lines so a comment mentioning the sleep cannot
  // stand in for one, and located relative to the login-bearing steps: a
  // sleep only paces the window it sits between, so position — not a total
  // count — is what keeps each 60 s window to its own step's logins.
  const sleeps = [...workflow.matchAll(/^\s*run: sleep 70\s*$/gm)].map((m) => m.index ?? -1);
  return { journeys, parity, authPerf, sleeps };
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
  const pacing = pacingPositions();

  assert.equal(
    teardown,
    0,
    `local teardown performs ${teardown} QA login(s): the sweep is DB-direct ` +
      `and must spend none of the shared qa-login budget.`,
  );
  assert.ok(
    pacing.journeys !== -1 && pacing.parity !== -1 && pacing.authPerf !== -1,
    `e2e.yml pacing markers moved (journeys=${pacing.journeys}, parity=${pacing.parity}, ` +
      `auth-perf=${pacing.authPerf}): if a login-bearing step was renamed on ` +
      `purpose, teach pacingPositions the new marker; otherwise the guard is ` +
      `blind to the step order.`,
  );
  const sleepAfterJourneys = pacing.sleeps.find((pos) => pos > pacing.journeys) ?? -1;
  const sleepAfterParity = pacing.sleeps.find((pos) => pos > pacing.parity) ?? -1;
  assert.ok(
    sleepAfterJourneys !== -1 &&
      sleepAfterJourneys < pacing.parity &&
      sleepAfterParity !== -1 &&
      sleepAfterParity < pacing.authPerf,
    `e2e.yml must hold a 70 s throttle pacing sleep between the browser suite ` +
      `and parity, and another between parity and auth-perf: without them the ` +
      `steps share one 60 s window and their combined logins 429. A sleep ` +
      `moved elsewhere in the job paces nothing.`,
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
    parityTotal > 0,
    `kit-parity census found no QA logins: the guard inspected nothing and ` +
      `passed vacuously. If the parity login callsites moved or changed ` +
      `shape, teach countParityLogins the new shape instead of shipping a ` +
      `blind guard.`,
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
