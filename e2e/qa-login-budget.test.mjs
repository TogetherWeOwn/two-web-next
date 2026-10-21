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
// direction (fewer logins, not retries). The parity pair is pinned exactly,
// not just bounded, and direct, non-inline, and helper-form logins are pinned
// to zero wherever they would spend the throttle invisibly to the census.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const e2eDir = new URL(".", import.meta.url);

// playwright.config.ts runs testDir ./e2e with testMatch **/*.spec.ts and
// testIgnore **/{staging,watch,explore,kit-parity}/**, while
// playwright.kit-parity.config.ts runs testDir ./e2e/kit-parity with
// testIgnore: []. Each census must walk the same tree as its own runner, or
// specs the runner executes stay invisible to the budget.
const PLAYWRIGHT_IGNORED_DIRS = new Set(["staging", "watch", "explore", "kit-parity"]);
const KIT_PARITY_IGNORED_DIRS = new Set();

function collectSpecFiles(dirUrl, prefix, ignoredDirs, out = []) {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignoredDirs.has(entry.name)) {
      collectSpecFiles(
        new URL(`./${entry.name}/`, dirUrl),
        `${prefix}${entry.name}/`,
        ignoredDirs,
        out,
      );
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
  const files = collectSpecFiles(e2eDir, "", PLAYWRIGHT_IGNORED_DIRS).sort();
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
  const files = collectSpecFiles(dir, "", KIT_PARITY_IGNORED_DIRS).sort();
  assert.ok(files.length > 0, "no kit-parity spec files found");
  return files.map((file) => {
    const source = readFileSync(new URL(`./${file}`, dir), "utf8");
    // Wide match: inline paths, absolute https URLs, and template-origin
    // `${origin}/...` forms all spend the same throttle budget, and these
    // callsites have been refactored before — so a narrow inline-only match
    // that sees zero logins must not read as a clean budget. Non-inline
    // forms are additionally pinned to zero below.
    const calls = source.match(/\.post\(\s*["'`][^"'`]*\/auth\/qa\//g) ?? [];
    return { file: `kit-parity/${file}`, count: calls.length };
  });
}

// Any .post( whose first argument contains /auth/qa/, whatever precedes it:
// inline paths, absolute https URLs, and template-origin `${origin}/...`
// forms all spend the same throttle budget. The match stays inside the first
// string literal so a following /auth/qa/ mention cannot false-positive.
function countQaLoginPosts(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/\.post\(\s*["'`][^"'`]*\/auth\/qa\//g) ?? []).length;
}

// Non-inline QA URLs (absolute `https://.../auth/qa/...` or template-origin
// `${origin}/auth/qa/...`) spend the same throttle budget while hiding which
// bucket they hit, so they are pinned to zero across this window: keep window
// QA logins inline. (A variable-held QA path still evades static counting —
// treat any new post(variable) in this window as a budget question in review.)
function countNonInlineQaLoginPosts(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/\.post\(\s*["'`](?!\/auth\/qa\/)[^"'`]*\/auth\/qa\//g) ?? []).length;
}

// The qaLogin helper is counted per journey spec above, which excludes
// kit-parity — so a helper call in a parity file would spend the shared
// throttle invisibly to the census. Parity logs in through its two counted
// POST call sites instead.
function countQaLoginCalls(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/qaLogin\s*\(/g) ?? []).length;
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
  const directSites = specs
    .map((row) => ({ file: row.file, count: countQaLoginPosts(`./${row.file}`) }))
    .filter((row) => row.count > 0);
  const nonInlineSites = [
    "./local-global-teardown.ts",
    ...specs.map((row) => `./${row.file}`),
    ...parity.map((row) => `./${row.file}`),
  ]
    .map((file) => ({ file, count: countNonInlineQaLoginPosts(file) }))
    .filter((row) => row.count > 0);
  const parityHelperLogins = parity
    .map((row) => ({ file: row.file, count: countQaLoginCalls(`./${row.file}`) }))
    .filter((row) => row.count > 0);

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
  assert.equal(
    parityTotal,
    2,
    `kit-parity specs must keep exactly two QA-login POST call sites (found ${parityTotal}: ${parityBreakdown || "none"}): ` +
      `one shared member login plus one isolated renewal login. A third parity login ` +
      `reddened fast runs before — cut a login elsewhere first, and reshape renewal ` +
      `coverage with the Test Author rather than editing their spec to satisfy this pin.`,
  );
  assert.deepEqual(
    directSites,
    [],
    `journey specs must log in through qaLogin (counted above), not direct POSTs: ` +
      `${directSites.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `Route the new login through qaLogin so the budget counts it.`,
  );
  assert.deepEqual(
    nonInlineSites,
    [],
    `QA logins in this window must use inline /auth/qa/ paths (counted above), not absolute or template-origin URLs: ` +
      `${nonInlineSites.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `A non-inline QA URL spends the same throttle budget while hiding its bucket.`,
  );
  assert.deepEqual(
    parityHelperLogins,
    [],
    `kit-parity specs must log in through the two counted POST call sites above, not the qaLogin helper: ` +
      `${parityHelperLogins.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `A helper login here spends the shared throttle invisibly to the budget census.`,
  );
  assert.ok(
    authPerf <= budget,
    `auth-perf performs ${authPerf} QA logins (one per journey in ` +
      `ci/auth-perf-budget.json) against the shared qa-login throttle ` +
      `(${budget}/min per runner IP). Reuse sessions instead of adding journeys.`,
  );
});
