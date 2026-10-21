// Local smoke QA-login budget guard (MAIN-RED FIX).
//
// POST /auth/qa/:identity shares the `qa-login` throttle
// (AUTH_THROTTLE_PER_MINUTE per runner IP, src/throttle.ts) across the whole
// sequential browser smoke, and every QA login spends it — good, bad, or
// otherwise. The 11th login inside one 60-second window reddened main twice
// (browser-smoke, profile moderator 429), and a Retry-After wait long enough
// to cross the window boundary does not fit the 30 s test timeout, so the
// suite must stay at or under the budget. The first test counts the per-test
// qaLogin call sites; the second pins every login OUTSIDE the journey specs
// (the DB-gated teardown sweep plus the parity step, which once hid enough
// spends to red fast runs on their own). Both fail loudly when a new login
// would push the run over, pointing at the fix direction (fewer logins, not
// retries). Staging, watch and explore specs run in other jobs against other
// buckets and are out of this window's scope; the authenticated perf step's
// pair lands a full parity run later and carries its own header pin
// (ci/check-auth-perf.mjs).

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

// Journey-spec enumeration mirrors playwright.config.ts: testMatch
// **/*.spec.ts under e2e/, minus testIgnore **/{staging,watch,explore,
// kit-parity}/**. Staging/watch/explore run in other jobs against other
// buckets; kit-parity is pinned separately below. A non-recursive read here
// would miss a journey spec added in a subdirectory while Playwright runs it.
const PLAYWRIGHT_IGNORED_DIRS = new Set(["staging", "watch", "explore", "kit-parity"]);

function journeySpecFiles() {
  const files = [];
  const visit = (relativeDir) => {
    const entries = readdirSync(new URL(relativeDir, e2eDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!PLAYWRIGHT_IGNORED_DIRS.has(entry.name)) {
          visit(`${relativeDir}${entry.name}/`);
        }
      } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        files.push(`${relativeDir}${entry.name}`);
      }
    }
  };
  visit("./");
  return files.sort();
}

function countLogins() {
  const files = journeySpecFiles();
  assert.ok(files.length > 0, "no e2e spec files found");
  return files.map((file) => {
    const source = readFileSync(new URL(file, e2eDir), "utf8");
    const calls = source.match(/await\s+qaLogin\s*\(/g) ?? [];
    return { file: file.slice("./".length), count: calls.length };
  });
}

test("the sequential smoke holds at most one throttle window of QA logins", () => {
  const budget = readBudget();
  const perFile = countLogins();
  const total = perFile.reduce((sum, row) => sum + row.count, 0);
  const breakdown = perFile
    .filter((row) => row.count > 0)
    .map((row) => `${row.file}: ${row.count}`)
    .join(", ");
  assert.ok(
    total <= budget,
    `local smoke journey specs perform ${total} QA logins against the shared qa-login throttle ` +
      `(${budget}/min per runner IP): ${breakdown}. The full window (journeys + ` +
      `DB-gated teardown + parity) is pinned by the sibling test below. Merge ` +
      `journeys onto fewer logins (one login per file where the flow allows) ` +
      `rather than retrying across the window — the wait does not fit the 30 s ` +
      `test timeout.`,
  );
});

// Every QA login outside the journey specs, pinned. The teardown sweep and
// the parity step once hid three spends from the guard above and reddened
// fast runs with a 429 deep inside parity — so this test counts their POST
// call sites directly and pins the green-run window total (journeys + parity,
// with the DB-gated teardown spending 0 on clean runs) at the tightened
// ceiling below. A new login anywhere in this window fails here instead of
// reddening a fast run: cut a login elsewhere first. Parity coverage is Test
// Author acceptance — reshape it with them, never by editing their spec to
// satisfy this pin.
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
// throttle invisibly to both tests. Parity logs in through its one counted
// POST call site instead (the renewal session is DB-minted).
function countQaLoginCalls(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/qaLogin\s*\(/g) ?? []).length;
}

test("teardown and parity QA logins stay pinned inside the throttle window", () => {
  const journeys = countLogins().reduce((sum, row) => sum + row.count, 0);
  const teardownSites = countQaLoginPosts("./local-global-teardown.ts");
  const parityDir = new URL("./kit-parity/", e2eDir);
  const parityFiles = readdirSync(parityDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(parityFiles.length > 0, "no kit-parity spec files found");
  const parityPerFile = parityFiles.map((file) => ({
    file: `kit-parity/${file}`,
    count: countQaLoginPosts(`./kit-parity/${file}`),
  }));
  const paritySites = parityPerFile.reduce((sum, row) => sum + row.count, 0);
  const parityBreakdown = parityPerFile
    .filter((row) => row.count > 0)
    .map((row) => `${row.file}: ${row.count}`)
    .join(", ");
  const directSites = countLogins()
    .map((row) => ({ file: row.file, count: countQaLoginPosts(`./${row.file}`) }))
    .filter((row) => row.count > 0);
  const nonInlineSites = [
    "./local-global-teardown.ts",
    ...countLogins().map((row) => `./${row.file}`),
    ...parityPerFile.map((row) => `./${row.file}`),
  ]
    .map((file) => ({ file, count: countNonInlineQaLoginPosts(file) }))
    .filter((row) => row.count > 0);
  const parityHelperLogins = parityPerFile
    .map((row) => ({ file: row.file, count: countQaLoginCalls(`./${row.file}`) }))
    .filter((row) => row.count > 0);

  assert.equal(
    teardownSites,
    1,
    `local-global-teardown.ts must keep exactly one QA-login POST call site (found ${teardownSites}): ` +
      `it is DB-gated to 0 spends on clean runs and at most 1 when orphans exist. ` +
      `A second teardown login spends the window parity shares — cut a login elsewhere first.`,
  );
  assert.equal(
    paritySites,
    1,
    `kit-parity specs must keep exactly one QA-login POST call site (found ${paritySites}: ${parityBreakdown || "none"}): ` +
      `the shared member login only — the isolated renewal session is minted directly ` +
      `in Postgres (the login was never under test) and spends no throttle budget. ` +
      `A second parity login reddened fast runs before — cut a login elsewhere first, ` +
      `and reshape renewal coverage with the Test Author rather than editing their ` +
      `spec to satisfy this pin.`,
  );
  assert.deepEqual(
    directSites,
    [],
    `journey specs must log in through qaLogin (counted by the sibling test), not direct POSTs: ` +
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
    `kit-parity specs must log in through the one counted POST call site above, not the qaLogin helper: ` +
      `${parityHelperLogins.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `A helper login here spends the shared throttle invisibly to both budget tests.`,
  );
  // Green-run window: journeys + parity, with the DB-gated teardown at 0.
  // 11 is the tightened ceiling against the 10/min sliding window: the
  // isolated parity renewal login was replaced by a DB-minted session with
  // identical renewal coverage (the login was never under test), cutting one
  // spend from the restored 12. The journeys spread across a minute-plus step
  // so the trailing window at the last spend holds fewer, but every login
  // past 11 erases that margin and reds the fastest runs.
  const greenTotal = journeys + paritySites;
  assert.ok(
    greenTotal <= 11,
    `green-run QA logins total ${greenTotal} (journeys ${journeys} + parity ${paritySites}), ` +
      `past the tightened 11 ceiling against the 10/min sliding window. Cut a login ` +
      `elsewhere first — fewer logins, not retries.`,
  );
});
