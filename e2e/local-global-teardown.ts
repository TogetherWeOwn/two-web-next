import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";
import { sweepLocalFixturesDb } from "./local-fixture-sweep.mjs";

export default async function globalTeardown(): Promise<void> {
  requireGithubRunner();
  // DB-direct backstop: no QA login, so the teardown spends none of the
  // shared 10/min `qa-login` throttle. Disposable CI Postgres only — the
  // guard refuses staging, production, and every other target.
  const url = requireTestDatabase(process.env.DATABASE_URL);
  const sql = postgres(url, { max: 1 });
  try {
    const swept = await sweepLocalFixturesDb(sql);
    if (swept.length > 0)
      console.log(`local fixture sweep cancelled ${swept.length} orphaned RSVP fixture(s)`);
  } finally {
    await sql.end();
  }
}
