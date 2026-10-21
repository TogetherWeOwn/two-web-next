import type { Env } from "../env";

// Explicit local/dev configuration wins. Hyperdrive is used only when that
// configuration is absent, never as a retry after a connection failure.
export function databaseUrl(env: Pick<Env, "DATABASE_URL" | "DB">): string | undefined {
  return env.DATABASE_URL || env.DB?.connectionString;
}

// Homepage counts and profile stats read the bot-owned `web_v1` views, which
// live in the bot database — never in the web database above. Same selection
// rule, own binding: an explicit local/dev URL wins, else the BOT_DB
// Hyperdrive binding. Absent both, counts and stats degrade to hidden; the
// web DB is never a fallback because it holds no `web_v1` views.
export function botDatabaseUrl(env: Pick<Env, "BOT_DATABASE_URL" | "BOT_DB">): string | undefined {
  return env.BOT_DATABASE_URL || env.BOT_DB?.connectionString;
}

// Hyperdrive pools underneath the per-request client: no prepared statements
// or extra type-discovery round trips.
export const databaseOptions = {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 10,
  prepare: false,
  fetch_types: false,
};

// Per-request statement bound: fresh per-request `max:1` clients carry a
// server-side statement_timeout of 5 seconds (connection startup parameter,
// so it costs no extra round trip) and a stuck Postgres backend cancels with
// 57014 into the existing honest-outage handling instead of wedging the
// request. Normal per-request statements are millisecond-scale single-row
// work, and the fresh-login lock wait (10 s) and the connect timeout above
// both sit above this bound. Never add this to databaseOptions: that object
// stays bare so pooled and injected/shared clients are never bounded here —
// each fresh-client call site opts in through perRequestDatabaseOptions.
// Transaction paths that need a tighter bound keep using SET LOCAL /
// set_config inside the transaction, which override this session value.
export const PER_REQUEST_STATEMENT_TIMEOUT_MS = 5_000;

export function perRequestDatabaseOptions() {
  return {
    ...databaseOptions,
    connection: { statement_timeout: PER_REQUEST_STATEMENT_TIMEOUT_MS },
  };
}
