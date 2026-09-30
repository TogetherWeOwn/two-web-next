// GET /up (N3: TOG-9895) — ports two-web `HealthCheckController` +
// `QueueHealth` (routes/funnel.php, empty middleware stack) onto the W13 queue
// backend. The contract the deploy poll and monitors rely on, verbatim:
//
//   - healthy or degraded both answer 200. A backlog is RSVP lag, not an
//     outage, and `curl -f` must keep passing through one — /up distinguishes
//     shapes in the body, never the status code.
//   - `degraded` at or above WARN_AT pending jobs; still `degraded`, never
//     down, past CRITICAL_AT.
//   - the queue read can never sink the endpoint. A ledger that will not
//     answer (or is not configured) reports `queue.status: unknown` and the
//     endpoint stays on the last known application health.
//
// The measured object is the Postgres queue ledger (`queue_jobs` /
// `queue_failed_jobs`): Cloudflare Queues carries the messages but exposes no
// depth API, so the ledger is the `jobs`/`failed_jobs` pair of this port.

import type { QueueDepth } from "./jobs/postgres";

export const QUEUE_WARN_AT = 20;
export const QUEUE_CRITICAL_AT = 100;

/** A hung ledger must not hang the probe: past this the read reports `unknown`. */
export const QUEUE_READ_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("queue depth read timed out")), ms);
  });
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export type QueuePayload = {
  status: "healthy" | "degraded" | "unknown";
  pending: number | null;
  delayed: number | null;
  reserved: number | null;
  total: number | null;
  failed: number | null;
  oldest_pending_age_seconds: number | null;
  warn_at: number;
  critical_at: number;
  detail: string | null;
};

export type UpBody = { status: "healthy" | "degraded"; queue: QueuePayload };

function unknownQueue(detail: string | null): QueuePayload {
  return {
    status: "unknown",
    pending: null,
    delayed: null,
    reserved: null,
    total: null,
    failed: null,
    oldest_pending_age_seconds: null,
    warn_at: QUEUE_WARN_AT,
    critical_at: QUEUE_CRITICAL_AT,
    detail,
  };
}

/**
 * Build the response body. `measure` is the ledger read (`pgQueueDepth`); a
 * missing backend means uncountable depth, and a throwing measure is a reported
 * `unknown` — never a throw to the route.
 */
export async function upBody(measure: (() => Promise<QueueDepth>) | null): Promise<UpBody> {
  // Legacy: `queue driver 'x' has no countable depth.` — here: no ledger to read.
  if (!measure) return { status: "healthy", queue: unknownQueue("queue ledger is not configured.") };

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
    return { status: "healthy", queue: unknownQueue(null) };
  }

  const queue: QueuePayload = {
    status: depth.pending >= QUEUE_WARN_AT ? "degraded" : "healthy",
    pending: depth.pending,
    delayed: depth.delayed,
    reserved: depth.reserved,
    total: depth.total,
    failed: depth.failed,
    oldest_pending_age_seconds: depth.oldestPendingAgeSeconds,
    warn_at: QUEUE_WARN_AT,
    critical_at: QUEUE_CRITICAL_AT,
    detail: null,
  };
  return { status: queue.status === "degraded" ? "degraded" : "healthy", queue };
}
