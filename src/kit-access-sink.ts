import type { AccessSink } from "./access-log";
import { dbFor } from "./admin/db";
import { recordAccess } from "./admin/store-access";
import type { Env } from "./env";

// The Kit member-read sink writes the same access-log row as the Hono guards,
// so both renderers audit into one table. Null means no database: the read is refused.
export function kitAccessSink(env: Env): () => Promise<AccessSink | null> {
  return async () => {
    const db = await dbFor({ env });
    return db ? (entry) => recordAccess(db, entry) : null;
  };
}
