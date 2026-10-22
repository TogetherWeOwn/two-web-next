// Ensures the two_web_app role exists before drizzle-kit migrate runs.
// New-table migrations carry per-migration GRANTs to two_web_app
// (ci/migration-runtime-rights.mjs), and PostgreSQL refuses a GRANT to a
// missing role — including on disposable test databases, where the role
// does not exist. This runs first in `npm run db:migrate` (test-only
// flows; the live db-migrate workflow uses ci/db-migrate.mjs and never
// calls this). The role is NOLOGIN with no privileges: creating it grants
// nothing, and an existing role is left untouched. Concurrent runs race
// safely on duplicate_object. Never prints the database URL.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:ensure-runtime-role: DATABASE_URL is required.");
  process.exit(2);
}

let endpoint;
try {
  endpoint = new URL(url);
} catch {
  console.error("db:ensure-runtime-role: DATABASE_URL is not a valid URL; value withheld.");
  process.exit(2);
}

const sql = postgres(url, {
  max: 1,
  connect_timeout: 10,
  // postgres.js treats password: "" as absent and falls back to PGPASSWORD.
  // A callback pins the URL's own (possibly empty) test password instead.
  password: () => decodeURIComponent(endpoint.password),
  onnotice: () => {},
});

try {
  const [row] = await sql`select 1 as one from pg_roles where rolname = 'two_web_app'`;
  if (!row) {
    try {
      await sql.unsafe("CREATE ROLE two_web_app NOLOGIN");
    } catch (error) {
      // Lost a concurrent creation race: re-check instead of failing.
      if (error?.code !== "42710") throw error;
      const [again] = await sql`select 1 as one from pg_roles where rolname = 'two_web_app'`;
      if (!again) throw error;
    }
    console.log("db:ensure-runtime-role: created NOLOGIN role two_web_app.");
  }
} catch (error) {
  console.error(
    "db:ensure-runtime-role: cannot ensure role two_web_app.",
    error instanceof Error ? error.message : String(error),
  );
  console.error(
    "Run this once as a privileged user on the target database, then retry: CREATE ROLE two_web_app NOLOGIN;",
  );
  process.exit(1);
} finally {
  await sql.end();
}
