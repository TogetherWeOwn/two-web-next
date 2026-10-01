#!/usr/bin/env node
// Direct-`postgres` acceptance probe for the shared Neon staging branch
// (S1: TOG-9679 acceptance item 1, second half). The first half is the
// Hyperdrive-bound Worker queue read (GET /up); this script proves the same
// branch serves a direct client with the repo's `postgres` driver (the path
// the bot Container uses without Hyperdrive). DATABASE_URL env only (e.g.
// NEON_STAGING_DATABASE_URL) — never argv, never logs. Prints the row on
// success, exits non-zero otherwise.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db-ping: refusing: DATABASE_URL is unset.");
  process.exit(2);
}

const sql = postgres(url, { max: 1, fetch_types: false, prepare: false });
try {
  const rows = await sql.unsafe("SELECT version() AS version, now()::text AS now");
  console.log(JSON.stringify({ ok: true, version: rows[0].version, now: rows[0].now }));
} catch (err) {
  console.error(`db-ping: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
