// Admin/event/profile DB seam. Tests can inject a drizzle Db through ADMIN_DB.
// Otherwise, build a per-request client from the explicit DATABASE_URL or the
// existing Hyperdrive DB binding. With neither, routes fail closed to 503.

import { drizzle } from "drizzle-orm/postgres-js";
import type { Db } from "../db/index";
import { memberReadDb } from "../db/member-reads";
import { databaseOptions, databaseUrl, installPerRequestStatementBound } from "../db/connection";
import * as adminSchema from "../db/admin-schema";
import * as baseSchema from "../db/schema";
import type { Env } from "../env";

export type EnvWithAdminDb = Env & { ADMIN_DB?: Db };

// Takes { env } rather than a hono Context so route contexts with extra
// Variables stay assignable (hono's Context is invariant over Variables).
export async function dbFor(c: { env: Env }): Promise<Db | null> {
  const injected = (c.env as EnvWithAdminDb).ADMIN_DB;
  if (injected) return memberReadDb(injected);
  const url = databaseUrl(c.env);
  if (!url) return null;
  const { default: postgres } = await import("postgres");
  // Per-request statement bound (SET LOCAL in a short transaction per
  // query): a stuck read cancels into the existing outage handling instead
  // of wedging the page. The client is fresh and exclusively owned, so the
  // bound is installed on it directly; injected DBs pass through untouched.
  const client = installPerRequestStatementBound(postgres(url, databaseOptions));
  return memberReadDb(drizzle(client, { schema: { ...baseSchema, ...adminSchema } }));
}
