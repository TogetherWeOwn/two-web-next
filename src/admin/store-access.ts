// Access-log leaves of the admin store (W11). Pure move out of `./store`:
// the member-data access recorder plus its GIN index provision. `./store`
// re-exports every name below, so all existing importers keep working
// untouched.

import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { memberDataAccessLogs } from "../db/admin-schema";

/**
 * DB-side cap for the audit INSERT. Postgres cancels a lock-blocked or slow
 * statement server-side instead of the client deadline expiring while the
 * query keeps the connection. Well below the response deadline
 * (MEMBER_ACCESS_AUDIT_TIMEOUT_MS, 5 s) with room for connect, BEGIN and the
 * sibling transaction on the shared max:1 pool.
 */
export const ACCESS_LOG_DB_TIMEOUT_MS = 2000;

/**
 * Access-log recorder (M5, ports AccessRecorder::flush). One row per request
 * that read member data — never per record. The viewer is excluded from the
 * subjects; an empty subject set writes no row; the write throws when the log
 * is down so the middleware can fail closed (503 under enforce).
 *
 * Cancellation note: the INSERT runs in a transaction with transaction-scoped
 * lock_timeout/statement_timeout, so Postgres cancels a blocked INSERT
 * server-side (the cancellable bound this driver supports: postgres-js via
 * Drizzle has no per-statement AbortSignal on this path). The response
 * deadline (Promise.race in src/access-log.ts / src/member-reads.ts) does NOT
 * cancel database work: a late INSERT may still commit after the response was
 * already refused. The sink is called exactly once with no retry, so a late
 * finish cannot replay the write; it only means the row may exist even though
 * the read was refused.
 */
export async function recordAccess(
  db: Db,
  opts: {
    viewerDiscordId: string;
    viewerUserId: string | null;
    resource: string;
    action: string;
    subjectUserIds: string[];
    route: string | null;
  },
): Promise<boolean> {
  const subjects = [...new Set(opts.subjectUserIds.filter((s) => s !== opts.viewerUserId))].sort();
  if (subjects.length === 0) return false;
  // Transaction-scoped guard: cancel lock waits/slow statements in Postgres,
  // not just the HTTP wait, and never alter pooled session settings. Drizzle
  // nests via savepoints, so calling with an outer test transaction is safe.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${ACCESS_LOG_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${ACCESS_LOG_DB_TIMEOUT_MS}ms`}, true)`,
    );
    await tx.insert(memberDataAccessLogs).values({
      viewerDiscordId: opts.viewerDiscordId,
      viewerUserId: opts.viewerUserId,
      resource: opts.resource,
      action: opts.action,
      subjectUserIds: subjects,
      subjectCount: subjects.length,
      route: opts.route,
    });
  });
  return true;
}

/** GIN index the query planner needs for "who looked at *this member*?" (legacy DDL, drizzle-kit cannot emit it). */
export async function ensureAccessLogGin(db: Db): Promise<void> {
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS member_data_access_logs_subject_user_ids_gin ON member_data_access_logs USING gin (subject_user_ids jsonb_path_ops)`,
    ),
  );
}
