// Reset volitional throttle counters between smoke suites (QA-LOGIN FIX).
//
// POST /auth/qa/:identity shares the `qa-login` throttle (10/min per runner
// IP, src/throttle.ts) through the rolling-60s web_throttle_hits table on the
// disposable CI Postgres. The critical journeys spend the whole budget — 10
// spec logins (pinned by e2e/qa-login-budget.test.mjs) plus the teardown
// login (e2e/local-global-teardown.ts) — so the parity run's own QA login
// 429s whenever the trailing window still holds them (browser-smoke run
// 39516960302: 2x Expected 204 Received 429). A Retry-After wait long enough
// to cross the window does not fit the 30 s test timeout, and the parity
// login cannot go below one, so the harness clears the counters between the
// suites instead: each suite then starts with a clean window, as if it ran
// on its own runner. No product behavior changes — the table holds only
// rate-limit counters, and no suite asserts on pre-existing rows.
import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

requireGithubRunner();
const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
try {
  // A fresh service container per job; no truncate/drop against a shared DB.
  const cleared = await sql`DELETE FROM web_throttle_hits`;
  console.log(`reset-throttle: cleared ${cleared.count} throttle hit(s)`);
} finally {
  await sql.end();
}
