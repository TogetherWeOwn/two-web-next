import type postgres from "postgres";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "./admin-schema";

/** The postgres.js surface the bridge needs: a reserved client or a `begin` tx. */
export type UnsafeClient = Pick<postgres.Sql, "unsafe">;

/** Drizzle over a raw postgres.js client, so jobs and CLIs can reuse Drizzle
 * helpers inside a transaction they already own. Never begins a nested
 * transaction. pg-proxy avoids postgres-js Drizzle's global timestamp/JSON
 * parser mutation: other queries on this client still need native types. */
export function drizzleOver(sql: UnsafeClient) {
  return drizzle(
    async (query, params, _method, typings) => ({
      // Drizzle already JSON-encodes these parameters; native postgres.js
      // must receive the decoded value to avoid a JSON string audit payload.
      rows: await sql
        .unsafe(
          query,
          params.map((value, index) =>
            typings?.[index] === "json" && typeof value === "string" ? JSON.parse(value) : value,
          ) as never[],
        )
        .values(),
    }),
    { schema },
  );
}
