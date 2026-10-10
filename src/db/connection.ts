import type { Env } from "../env";

// Explicit local/dev configuration wins. Hyperdrive is used only when that
// configuration is absent, never as a retry after a connection failure.
export function databaseUrl(env: Pick<Env, "DATABASE_URL" | "DB">): string | undefined {
  return env.DATABASE_URL || env.DB?.connectionString;
}

// Homepage bot counts read the bot-owned `web_v1` views, which live in the
// bot database — never in the web database above. Same selection rule, own
// binding: an explicit local/dev URL wins, else the BOT_DB Hyperdrive
// binding. Absent both, counts degrade to hidden; the web DB is never a
// fallback because it holds no `web_v1` views.
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
