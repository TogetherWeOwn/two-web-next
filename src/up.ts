// GET /up (N3: TOG-9895) — ports two-web `HealthCheckController` +
// `QueueHealth` (routes/funnel.php, empty middleware stack) onto the W13 queue
// backend. The contract the deploy poll and monitors rely on, verbatim:
//
//   - queue-only healthy, degraded or unknown answers 200. A backlog is RSVP
//     lag, not an outage. DB reachability/schema readiness is independent:
//     a failed DB ping or unavailable/pending migration ledger answers 503.
//   - `degraded` at or above WARN_AT pending jobs; still `degraded`, never
//     down, past CRITICAL_AT.
//   - the queue read can never sink the endpoint. A ledger that will not
//     answer (or is not configured) reports `queue.status: unknown` with
//     top-level `degraded`, keeping 200: unknown joins the queue-only
//     degraded family so blindness never reads as healthy, while readiness
//     stays independent and the uptime prober stays green.
//
// The measured object is the Postgres queue ledger (`queue_jobs` /
// `queue_failed_jobs`): Cloudflare Queues carries the messages but exposes no
// depth API, so the ledger is the `jobs`/`failed_jobs` pair of this port.
//
// Re-export barrel: migrations in ./up-migrations, database readiness in
// ./up-database, required-secret readiness in ./up-config, deployed-revision
// readiness in ./up-revision, queue depth and thresholds in ./up-queue, the
// shared read timeout in ./up-timeout and the response body in ./up-body. The
// export list below is exactly the previous export list of this file, so all
// importers keep working untouched.
export { upBody, upHttpStatus } from "./up-body";
export type { MemberAccessLogEnforcement, UpBody } from "./up-body";
export { REQUIRED_SECRETS, configReadiness, missingSecrets } from "./up-config";
export type { ConfigReadiness } from "./up-config";
export {
  HEALTH_LOCK_TIMEOUT_MS,
  HEALTH_STATEMENT_TIMEOUT_MS,
  databaseReadiness,
  withHealthReadTimeout,
} from "./up-database";
export type { DatabaseReadiness } from "./up-database";
export { WEB_MIGRATIONS, pendingWebMigrations } from "./up-migrations";
export {
  QUEUE_CRITICAL_AT,
  QUEUE_WARN_AT,
  READY_WAIT_CRITICAL_AFTER_SECONDS,
  READY_WAIT_WARN_AFTER_SECONDS,
} from "./up-queue";
export type { QueuePayload, ReadyWaitSeverity } from "./up-queue";
export { revisionReadiness } from "./up-revision";
export type { RevisionReadiness } from "./up-revision";
export { QUEUE_READ_TIMEOUT_MS } from "./up-timeout";
