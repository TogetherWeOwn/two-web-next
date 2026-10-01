import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/**
 * One dead-letter row. Diagnostic identity only: `queue_failed_jobs` carries
 * no payload and no original bot idempotency key, so a row alone can never
 * rebuild the message — redispatch always starts from the original authorized
 * source (see docs/queue-redrive-runbook.md).
 */
export type FailedJob = {
  id: number;
  jobId: string;
  kind: string;
  key: string | null;
  reason: string;
  failedAt: Date;
};

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function toFailedJob(row: Record<string, unknown>): FailedJob {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    key: row.key == null ? null : String(row.key),
    reason: String(row.reason),
    failedAt: row.failed_at as Date,
  };
}

/**
 * Bounded newest-first inspect over `queue_failed_jobs`. Read-only: listing
 * never mutates the dead letter, so repeated inspection is safe mid-incident.
 */
export async function listFailedJobs(sql: Sql, opts?: { kind?: string; limit?: number }): Promise<FailedJob[]> {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  // Table names cannot be parameterized, but the kind value can — the two
  // static statements differ only in the filter, never in shape.
  const rows = opts?.kind
    ? await sql`select id, job_id, kind, key, reason, failed_at from queue_failed_jobs
        where kind = ${opts.kind} order by failed_at desc, id desc limit ${limit}`
    : await sql`select id, job_id, kind, key, reason, failed_at from queue_failed_jobs
        order by failed_at desc, id desc limit ${limit}`;
  return rows.map((row) => toFailedJob(row as Record<string, unknown>));
}

/**
 * Discard exactly one dead-letter row: after its recovery is confirmed, or
 * when the failure is poison that must never run again. Returns false —
 * deleting nothing — for an unknown id. Never a drain: one id, one row.
 */
export async function discardFailedJob(sql: Sql, failureId: number): Promise<boolean> {
  const rows = await sql`delete from queue_failed_jobs where id = ${failureId} returning 1`;
  return rows.length === 1;
}
