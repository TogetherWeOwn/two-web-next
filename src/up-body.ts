import type { Sql } from "postgres";
import type { QueueDepth } from "./jobs/postgres";
import type { ConfigReadiness } from "./up-config";
import { type DatabaseReadiness, databaseReadiness } from "./up-database";
import { type QueueHealth, queueBody } from "./up-queue";

export function upHttpStatus(body: DatabaseReadiness & ConfigReadiness): 200 | 503 {
  return body.config === undefined && body.db === "ok" && body.pending_migrations === 0 ? 200 : 503;
}

// Member-access-log enforcement signal: informational like
// `revision`, never part of the readiness verdict. `upHttpStatus` ignores it
// on purpose — degraded log-only serving is a supported config, not an
// outage. The value mirrors `enforceOn` in ./access-log exactly; the route
// computes it from env and passes it in so this builder stays env-free like
// `config`. Defaults to enforcing, matching an unset enforce flag.
// Security note: the two-state label is intentionally public on the
// unauthenticated /up body. The control and its degraded meaning are already
// public in the operator runbooks, dashboards poll /up without credentials,
// and exploiting a log-only window still needs an authenticated read plus a
// failed audit write. No raw setting value or variable name is echoed.
export type MemberAccessLogEnforcement = "enforcing" | "log_only";

export type UpBody = QueueHealth &
  DatabaseReadiness &
  ConfigReadiness & { member_access_log_enforcement: MemberAccessLogEnforcement };

export async function upBody(
  measure: (() => Promise<QueueDepth>) | null,
  sql: Sql | null = null,
  config: ConfigReadiness = {},
  memberAccessLogEnforcement: MemberAccessLogEnforcement = "enforcing",
): Promise<UpBody> {
  // Parallel deadlines keep a hung DB + hung queue inside one 3 s window.
  const [queue, database] = await Promise.all([queueBody(measure), databaseReadiness(sql)]);
  const ready = { ...database, ...config };
  return {
    ...queue,
    ...ready,
    status: upHttpStatus(ready) === 503 ? "degraded" : queue.status,
    member_access_log_enforcement: memberAccessLogEnforcement,
  };
}
