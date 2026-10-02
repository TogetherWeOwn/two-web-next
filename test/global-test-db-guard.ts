// TOG-12549: global test-database guard.
//
// Vitest loads this via `globalSetup` in vitest.config.ts, which runs in a
// separate process before any test file loads — so it aborts the whole run on
// a stray production-looking DATABASE_URL (or audit/legacy import URL) before
// any suite constructs a driver, without sharing a module registry with suites
// (a setupFiles import of the helper would bind the real `postgres` driver
// before `test/member-data-fixture.test.ts`'s vi.mock can intercept it).
// Unset or empty variables stay allowed because DB suites already skip via
// `skipIf(!process.env.X)` when their URL is absent.
import { testDatabaseUrl } from "./helpers/member-data-db";

export const GUARDED_TEST_DB_VARS = [
  "DATABASE_URL",
  "AUDIT_IMPORT_TEST_DATABASE_URL",
  "LEGACY_DATABASE_URL",
] as const;

export default function globalTestDbGuard() {
  for (const name of GUARDED_TEST_DB_VARS) {
    const raw = process.env[name];
    if (!raw) continue;
    try {
      testDatabaseUrl(raw);
    } catch {
      // Never echo the URL: it may contain credentials.
      throw new Error(
        `${name} is not an authorized test database URL; ` +
          "tests only run against agent-testdb or the GitHub CI Postgres service; " +
          "refusing before connecting",
      );
    }
  }
}
