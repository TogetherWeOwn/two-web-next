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

function countLogins() {
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
// with the DB-gated teardown spending 0 on clean runs) at the restored
// pre-marginal-login ceiling. A new login anywhere in this window fails here
// instead of reddening a fast run: cut a login elsewhere first. Parity
// coverage is Test Author acceptance — reshape it with them, never by editing
// their spec to satisfy this pin.
function countQaLoginPosts(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/\.post\(\s*["`]\/auth\/qa\//g) ?? []).length;
}

// Absolute QA URLs (staging-style `${origin}/auth/qa/...`) would evade the
// inline counter above while spending the same throttle budget, so they are
// pinned to zero across this window: keep window QA logins inline or behind
// the qaLogin helper. (A variable-held QA path still evades static counting —
// treat any new post(variable) in this window as a budget question in review.)
function countAbsoluteQaLoginPosts(relativePath) {
  const source = readFileSync(new URL(relativePath, e2eDir), "utf8");
  return (source.match(/\.post\(\s*["`]https?:\/\/[^"`]*\/auth\/qa\//g) ?? []).length;
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
  const absoluteSites = [
    "./local-global-teardown.ts",
    ...countLogins().map((row) => `./${row.file}`),
    ...parityPerFile.map((row) => `./${row.file}`),
  ]
    .map((file) => ({ file, count: countAbsoluteQaLoginPosts(file) }))
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
    2,
    `kit-parity specs must keep exactly two QA-login POST call sites (found ${paritySites}: ${parityBreakdown || "none"}): ` +
      `one shared member login plus one isolated renewal login. A third parity login ` +
      `reddened fast runs before — cut a login elsewhere first, and reshape renewal ` +
      `coverage with the Test Author rather than editing their spec to satisfy this pin.`,
  );
  assert.deepEqual(
    directSites,
    [],
    `journey specs must log in through qaLogin (counted by the sibling test), not direct POSTs: ` +
      `${directSites.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `Route the new login through qaLogin so the budget counts it.`,
  );
  assert.deepEqual(
    absoluteSites,
    [],
    `QA logins in this window must use inline /auth/qa/ paths (counted above), not absolute URLs: ` +
      `${absoluteSites.map((row) => `${row.file}: ${row.count}`).join(", ")}. ` +
      `An absolute QA URL spends the same throttle budget invisibly.`,
  );
  // Green-run window: journeys + parity, with the DB-gated teardown at 0.
  // 12 is the restored pre-marginal-login ceiling against the 10/min sliding
  // window — the journeys spread across a minute-plus step so the trailing
  // window at the last spend holds fewer, but every login past 12 erases that
  // margin and reds the fastest runs.
  const greenTotal = journeys + paritySites;
  assert.ok(
    greenTotal <= 12,
    `green-run QA logins total ${greenTotal} (journeys ${journeys} + parity ${paritySites}), ` +
      `past the restored 12 ceiling against the 10/min sliding window. Cut a login ` +
      `elsewhere first — fewer logins, not retries.`,
  );
});
