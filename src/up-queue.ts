import type { QueueDepth } from "./jobs/postgres";
import { QUEUE_READ_TIMEOUT_MS, withTimeout } from "./up-timeout";

export const QUEUE_WARN_AT = 20;
export const QUEUE_CRITICAL_AT = 100;
export const READY_WAIT_WARN_AFTER_SECONDS = 300;
export const READY_WAIT_CRITICAL_AFTER_SECONDS = 1800;

export type ReadyWaitSeverity = "healthy" | "warning" | "critical" | "unknown";

// Ledger eligibility only: not domain-claim eligibility or consumer progress.
// Retained terminal failures and creation age do not participate in this signal.
function readyWaitSeverity(age: number | null): ReadyWaitSeverity {
  if (age !== null && age > READY_WAIT_CRITICAL_AFTER_SECONDS) return "critical";
  if (age !== null && age > READY_WAIT_WARN_AFTER_SECONDS) return "warning";
  return "healthy";
}

// `failed` is the backlog-independent dead-letter count the redrive runbook
// inspects newest-first (`docs/queue-redrive-runbook.md`): the same rows
// `listFailedJobs` returns, so one confirmed `discardFailedJob` drops it by
// exactly one. Pinned against real SQL in test/up.test.ts; an unreadable
// ledger reports `unknown`/`null` here, never a 500 (queue-only stays 200).
export type QueuePayload = {
  status: "healthy" | "degraded" | "unknown";
  pending: number | null;
  delayed: number | null;
  reserved: number | null;
  total: number | null;
  failed: number | null;
  oldest_pending_age_seconds: number | null;
  oldest_ready_wait_age_seconds: number | null;
  ready_wait_severity: ReadyWaitSeverity;
  warn_at: number;
  critical_at: number;
  detail: string | null;
};

export type QueueHealth = { status: "healthy" | "degraded"; queue: QueuePayload };

function unknownQueue(detail: string | null): QueuePayload {
  return {
    status: "unknown",
    pending: null,
    delayed: null,
    reserved: null,
    total: null,
    failed: null,
    oldest_pending_age_seconds: null,
    oldest_ready_wait_age_seconds: null,
    ready_wait_severity: "unknown",
    warn_at: QUEUE_WARN_AT,
    critical_at: QUEUE_CRITICAL_AT,
    detail,
  };
}

/**
 * Build the response body. `measure` is the ledger read (`pgQueueDepth`); a
 * missing backend means uncountable depth, and a throwing measure is a reported
 * `unknown` — never a throw to the route.
 *
 * Decided: top-level `degraded` on unknown, keeping HTTP 200 (never a 500).
 * Unknown joins the existing queue-only degraded family (`pending >= 20`
 * already returns degraded + 200), so dashboards polling top-level status see
 * blindness instead of health. HTTP stays 200 because readiness (db,
 * migrations, config) is independent of queue observability; the uptime prober
 * (200 + x-two-origin) stays green, so this does not double with the direct
 * `scheduled.failing` page. The queue slice, 20/100 thresholds and the
 * class-only warn shape stay exactly as before.
 */
export async function queueBody(measure: (() => Promise<QueueDepth>) | null): Promise<QueueHealth> {
  // Legacy: `queue driver 'x' has no countable depth.` — here: no ledger to read.
  if (!measure)
    return { status: "degraded", queue: unknownQueue("queue ledger is not configured.") };

  let depth: QueueDepth;
  try {
    depth = await withTimeout(measure(), QUEUE_READ_TIMEOUT_MS);
  } catch (err) {
    // Name only, never the message: the queue tables carry job payloads and
    // the endpoint must not leak one into a log (ports Log::warning's
    // exception-class-only clause).
    console.warn("Health check could not read the queue depth; reporting unknown.", {
      exception: err instanceof Error ? err.name : typeof err,
    });
    return { status: "degraded", queue: unknownQueue(null) };
  }

  const queue: QueuePayload = {
    status: depth.pending >= QUEUE_WARN_AT ? "degraded" : "healthy",
    pending: depth.pending,
    delayed: depth.delayed,
    reserved: depth.reserved,
    total: depth.total,
    failed: depth.failed,
    oldest_pending_age_seconds: depth.oldestPendingAgeSeconds,
    oldest_ready_wait_age_seconds: depth.oldestReadyWaitAgeSeconds,
    ready_wait_severity: readyWaitSeverity(depth.oldestReadyWaitAgeSeconds),
    warn_at: QUEUE_WARN_AT,
    critical_at: QUEUE_CRITICAL_AT,
    detail: null,
  };
  return { status: queue.status === "degraded" ? "degraded" : "healthy", queue };
}
