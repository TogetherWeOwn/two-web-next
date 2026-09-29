// Admin DB seam (W11). The worker bundle must not import `postgres-js`
// ( Workers have no TCP; production reads through the Hyperdrive binding in
// S1/W1). Routes get a Db through this seam:
//
// - Tests inject a drizzle Db on the env (`{...env, ADMIN_DB: db}`).
// - Staging/dev builds one per request from DATABASE_URL (agent-testdb),
//   mirroring the W5 storeFor pattern, until the Hyperdrive binding lands.
// - CI (no DATABASE_URL) has no Db: the guard fails closed to 503.
//
// Nothing here imports `postgres` at module top level, so the worker bundle
// stays light; the driver import is lazy and only runs outside the worker.

import { drizzle } from "drizzle-orm/postgres-js";
import type { Db } from "../db/index";
import * as adminSchema from "../db/admin-schema";
import * as baseSchema from "../db/schema";
import type { Env } from "../env";

export type EnvWithAdminDb = Env & { ADMIN_DB?: Db };

// Takes { env } rather than a hono Context so route contexts with extra
// Variables stay assignable (hono's Context is invariant over Variables).
export async function dbFor(c: { env: Env }): Promise<Db | null> {
  const injected = (c.env as EnvWithAdminDb).ADMIN_DB;
  if (injected) return injected;
  const url = c.env.DATABASE_URL;
  if (!url) return null;
  const { default: postgres } = await import("postgres");
  const client = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  return drizzle(client, { schema: { ...baseSchema, ...adminSchema } });
}
