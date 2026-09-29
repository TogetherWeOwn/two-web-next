import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Script/test helper only: nothing in the worker bundle imports this.
// Local/dev passes DATABASE_URL (agent-testdb). Production will use a
// Hyperdrive binding instead (later slice), not this helper.
export function createDb(url: string) {
  const client = postgres(url, { max: 1 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
