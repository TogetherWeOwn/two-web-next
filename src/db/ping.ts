// Shared-Postgres acceptance ping (S1: TOG-9679).
//
// The web reads Neon through a Hyperdrive binding, which exposes a
// `connectionString` passed to the `postgres` driver per request — the same
// shape as the W14 agent-events route (max 1, no prepared statements, always
// ended; Hyperdrive pools underneath). The bot Container connects directly
// with `pg` (no Hyperdrive); bin/db-ping.mjs proves that half.
// version/now are low-sensitivity diagnostics; failures surface as throws so
// the route maps them to a 503 with no internals.
//
// Docs: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/

import postgres, { type Sql } from "postgres";

export type DbRow = Record<string, unknown>;

// One SQL round-trip. params are driver-bound ($1, $2, …) — never interpolated.
export type QueryRunner = (sql: string, params?: unknown[]) => Promise<{ rows: DbRow[] }>;

// Injectable for tests: production passes the `postgres` module itself, tests
// pass a stub with the same (url, options) call shape.
export type SqlFactory = (url: string, options?: Record<string, unknown>) => Sql;

export function hyperdriveQuery(connectionString: string, makeSql: SqlFactory = postgres): QueryRunner {
  return async (sql, params) => {
    const client = makeSql(connectionString, { max: 1, fetch_types: false, prepare: false });
    try {
      const rows = await client.unsafe(sql, (params ?? []) as never[]);
      return { rows: rows as DbRow[] };
    } finally {
      await client.end({ timeout: 2 });
    }
  };
}

export type DbPing = { ok: true; version: string; now: string };

// Proves the staging branch serves this Worker through Hyperdrive (and, via
// bin/db-ping.mjs, a direct `pg` client).
export async function dbPing(run: QueryRunner): Promise<DbPing> {
  const { rows } = await run("SELECT version() AS version, now()::text AS now");
  const row = rows[0];
  if (!row || typeof row.version !== "string" || typeof row.now !== "string") {
    throw new Error("db ping: unexpected row shape");
  }
  return { ok: true, version: row.version, now: row.now };
}
