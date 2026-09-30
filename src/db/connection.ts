import type { Env } from "../env";

// Explicit local/dev configuration wins. Hyperdrive is used only when that
// configuration is absent, never as a retry after a connection failure.
export function databaseUrl(env: Pick<Env, "DATABASE_URL" | "DB">): string | undefined {
  return env.DATABASE_URL || env.DB?.connectionString;
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
