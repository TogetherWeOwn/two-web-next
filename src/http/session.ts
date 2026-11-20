import postgres from "postgres";
import { databaseOptions, databaseUrl, withPerRequestStatementBound } from "../db/connection";
import type { Env } from "../env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  type SessionStore,
  type Sql,
} from "../sessions";

// Test seam: tests carry a SessionStore on the env object (`{...env, SESSION_STORE: store}`,
// cast at the call site). Production bindings never set it, so this branch is dead in
// production. It keeps per-request store isolation without module-global state.
type EnvWithStore = Env & { SESSION_STORE?: SessionStore };

// Shared with the Kit hook: the same DB selection Hono uses, so
// Kit reads the sessions Hono writes. Same lifecycle too — a short-lived
// per-request client, Hyperdrive pooling underneath, idle_timeout reaping.
export async function storeForEnv(env: Env): Promise<SessionStore> {
  const injected = (env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = databaseUrl(env);
  // No DB configuration: a fresh memory store per request fails closed to guest.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client; Hyperdrive pools underneath in the Worker.
  // Keep it alive while the store uses it; idle_timeout closes idle sockets.
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  // Per-request statement bound (SET LOCAL in a short transaction per
  // statement): a stuck session lookup cancels into the existing outage
  // handling instead of wedging the request. Journeys share the adapter, so
  // the OAuth consume path is bounded the same way.
  return createPostgresSessionStore(withPerRequestStatementBound(sql));
}
