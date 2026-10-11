// Local smoke QA-login budget guard (MAIN-RED FIX).
//
// POST /auth/qa/:identity shares the `qa-login` throttle
// (AUTH_THROTTLE_PER_MINUTE per runner IP, src/throttle.ts) across the whole
// sequential browser smoke, and every qaLogin call spends it — good, bad, or
// otherwise. The 11th login reddened main twice (browser-smoke, profile
// moderator 429), and a Retry-After wait long enough to cross the window
// boundary does not fit the 30 s test timeout, so the suite must stay at or
// under the budget. This static test counts the per-test qaLogin call sites
// and fails loudly when a new login-bearing spec would push the run over,
// pointing at the fix direction (fewer logins, not retries).

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
    `local smoke performs ${total} QA logins against the shared qa-login throttle ` +
      `(${budget}/min per runner IP): ${breakdown}. Merge journeys onto fewer ` +
      `logins (one login per file where the flow allows) rather than retrying ` +
      `across the window — the wait does not fit the 30 s test timeout.`,
  );
});
