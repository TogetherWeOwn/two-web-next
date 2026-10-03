// N3 (TOG-9895): the queue-ledger fixture owns a disposable schema, never the
// caller's tables. An earlier revision of test/jobs-ledger.test.ts ran
// `drop table queue_jobs` + `delete from queue_failed_jobs` against the shared
// DATABASE_URL database — erasing the live ledger and its failure history on
// every run (TOG-9895 review P1). This fixture instead creates a random schema,
// builds the two ledger tables inside it, pins search_path to it, and drops
// the whole schema at the end. The caller's tables are never written or
// dropped, only read for the table shapes (LIKE, no data).
//
// URL posture mirrors the W15 member-data fixture: only agent-testdb
// (agent_test, empty password) or the GitHub CI Postgres service may be used;
// anything else is refused before connecting. Never production/staging data.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "./member-data-db";

export async function createLedgerFixture(raw: string) {
  const url = testDatabaseUrl(raw); // Must run before postgres() or any DDL.
  const schemaName = `qledger_${randomUUID().replaceAll("-", "")}`;
  // postgres.js treats password: "" as absent and falls back to PGPASSWORD.
  // A callback pins the authorized empty test password without that fallback.
  const options = {
    max: 1,
    port: 5432,
    connect_timeout: 5,
    password: () => url.password,
    onnotice: () => {},
  };
  const admin = postgres(url.href, options);
  const sql = postgres(url.href, { ...options, connection: { search_path: schemaName } });
  let created = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await sql.end();
      if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await admin.end();
    }
  };
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    // Same shapes as the canonical migration (drizzle/1007_queue-ledger.sql),
    // as templated tables inside our schema. LIKE copies the shape only —
    // the caller's data stays where it is.
    await sql`create table queue_jobs (like public.queue_jobs including all)`;
    await sql`create table queue_failed_jobs (like public.queue_failed_jobs including all)`;
  } catch (error) {
    await dispose();
    throw error;
  }
  const reset = async () => {
    if (disposed) throw new Error("queue-ledger fixture is disposed");
    await sql`delete from queue_jobs`;
    await sql`delete from queue_failed_jobs`;
  };
  return { sql, schemaName, reset, dispose };
}
