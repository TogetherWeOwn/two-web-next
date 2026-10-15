// Access-log leaves of the admin store (W11). Pure move out of `./store`:
// the member-data access recorder plus its GIN index provision. `./store`
// re-exports every name below, so all existing importers keep working
// untouched.

import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { memberDataAccessLogs } from "../db/admin-schema";

/**
 * Access-log recorder (M5, ports AccessRecorder::flush). One row per request
 * that read member data — never per record. The viewer is excluded from the
 * subjects; an empty subject set writes no row; the write throws when the log
 * is down so the middleware can fail closed (503 under enforce).
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
  await db.insert(memberDataAccessLogs).values({
    viewerDiscordId: opts.viewerDiscordId,
    viewerUserId: opts.viewerUserId,
    resource: opts.resource,
    action: opts.action,
    subjectUserIds: subjects,
    subjectCount: subjects.length,
    route: opts.route,
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
