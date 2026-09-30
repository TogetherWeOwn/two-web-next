// The reader names web_v1 explicitly, so search_path cannot isolate this
// fixture. Own the schema inside a single reserved connection's transaction
// instead: rollback removes only our uncommitted objects. CREATE (without
// IF NOT EXISTS) refuses an existing schema; never replace a caller's view.
import postgres from "postgres";
import { testDatabaseUrl } from "./member-data-db";

export async function createWebV1Fixture(raw: string) {
  const url = testDatabaseUrl(raw); // Refuse before constructing a client or DDL.
  const pool = postgres(url.href, {
    max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {},
    connection: { lock_timeout: 2_000, statement_timeout: 5_000 },
  });
  let sql: postgres.ReservedSql;
  try { sql = await pool.reserve(); }
  catch (error) {
    await pool.end({ timeout: 1 });
    throw error;
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await sql.unsafe("ROLLBACK"); }
    finally {
      sql.release();
      await pool.end({ timeout: 1 });
    }
  };
  try {
    await sql.unsafe("BEGIN");
    await sql`CREATE SCHEMA web_v1`;
    await sql`
      CREATE TABLE web_v1.live_counts (
        human_member_count bigint,
        online_count bigint,
        counts_updated_at timestamptz
      )
    `;
    await sql`
      CREATE TABLE web_v1.rank_counts (
        rank_key text NOT NULL,
        rank_label text NOT NULL,
        member_count bigint,
        rank_order integer NOT NULL
      )
    `;
  } catch (error) {
    await dispose();
    throw error;
  }
  return { sql, dispose };
}

export type WebV1Fixture = Awaited<ReturnType<typeof createWebV1Fixture>>;
