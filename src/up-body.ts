import type { Sql } from "postgres";
import type { QueueDepth } from "./jobs/postgres";
import type { ConfigReadiness } from "./up-config";
import { type DatabaseReadiness, databaseReadiness } from "./up-database";
import { type QueueHealth, queueBody } from "./up-queue";

export function upHttpStatus(body: DatabaseReadiness & ConfigReadiness): 200 | 503 {
  return body.config === undefined && body.db === "ok" && body.pending_migrations === 0 ? 200 : 503;
}

export type UpBody = QueueHealth & DatabaseReadiness & ConfigReadiness;

export async function upBody(
  measure: (() => Promise<QueueDepth>) | null,
  sql: Sql | null = null,
  config: ConfigReadiness = {},
): Promise<UpBody> {
  // Parallel deadlines keep a hung DB + hung queue inside one 3 s window.
  const [queue, database] = await Promise.all([queueBody(measure), databaseReadiness(sql)]);
  const ready = { ...database, ...config };
  return {
    ...queue,
    ...ready,
    status: upHttpStatus(ready) === 503 ? "degraded" : queue.status,
  };
}
