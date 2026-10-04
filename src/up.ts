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
//     answer (or is not configured) reports `queue.status: unknown` and the
//     endpoint stays on the last known application health.
//
// The measured object is the Postgres queue ledger (`queue_jobs` /
// `queue_failed_jobs`): Cloudflare Queues carries the messages but exposes no
// depth API, so the ledger is the `jobs`/`failed_jobs` pair of this port.

import type { Sql, TransactionSql } from "postgres";
import journal from "../drizzle/meta/_journal.json";
import type { QueueDepth } from "./jobs/postgres";

// JSON is bundled by Wrangler: no filesystem access or migrator in the Worker.
// Only this repository's web 1000-series entries participate; bot rows and the
// grandfathered 0000/0001 tags are outside this readiness gate.
export const WEB_MIGRATIONS = journal.entries.filter((entry) => /^1\d{3}_/.test(entry.tag));

export function pendingWebMigrations(rows: readonly { created_at: unknown }[]): number {
  const applied = new Set(
    rows.map(({ created_at }) => {
      if (
        (typeof created_at !== "number" && typeof created_at !== "string") ||
        !/^\d+$/.test(String(created_at)) ||
        !Number.isSafeInteger(Number(created_at))
      ) {
        throw new Error("Invalid migration timestamp");
      }
      return Number(created_at);
    }),
  );
  return WEB_MIGRATIONS.filter((entry) => !applied.has(entry.when)).length;
}

export type DatabaseReadiness = { db: "ok" | "error"; pending_migrations: number | null };

export const HEALTH_STATEMENT_TIMEOUT_MS = 1000;
export const HEALTH_LOCK_TIMEOUT_MS = 750;
const HEALTH_RESPONSE_MARGIN_MS = 250;

// SET LOCAL belongs to the same reserved transaction as the read, not a pooled
// session. Closing a client alone does not cancel a lock-waiting backend.
// https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
// https://www.postgresql.org/docs/current/runtime-config-client.html#RUNTIME-CONFIG-CLIENT-STATEMENT
export async function withHealthReadTimeout<T>(
  sql: Sql,
  read: (tx: TransactionSql) => Promise<T>,
  deadline = Date.now() + QUEUE_READ_TIMEOUT_MS,
): Promise<T> {
  return (await sql.begin("read only", async (tx) => {
    const remaining = deadline - Date.now() - HEALTH_RESPONSE_MARGIN_MS;
    if (remaining <= 1) throw new Error("Health read deadline elapsed");
    const statement = Math.min(HEALTH_STATEMENT_TIMEOUT_MS, remaining);
    const lock = Math.min(HEALTH_LOCK_TIMEOUT_MS, statement - 1);
    await tx`SELECT set_config('statement_timeout', ${`${statement}ms`}, true),
      set_config('lock_timeout', ${`${lock}ms`}, true)`;
    // The successful setup reply can consume budget too. Refuse the read if
    // its installed server limit no longer fits; do not start another SET loop.
    if (statement > deadline - Date.now() - HEALTH_RESPONSE_MARGIN_MS)
      throw new Error("Health read deadline elapsed");
    return read(tx);
  })) as T;
}

export async function databaseReadiness(sql: Sql | null): Promise<DatabaseReadiness> {
  let db: DatabaseReadiness["db"] = "error";
  if (!sql) return { db, pending_migrations: null };
  try {
    const deadline = Date.now() + QUEUE_READ_TIMEOUT_MS;
    const pending_migrations = await withTimeout(
      (async () => {
        // Volatile clock_timestamp() prevents Hyperdrive query caching from
        // turning a cached ping/ledger into false readiness after an outage:
        // https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
        const ping = await withHealthReadTimeout(
          sql,
          async (tx) => tx`SELECT clock_timestamp() AS checked_at`,
          deadline,
        );
        if (ping.length !== 1) throw new Error("Missing database ping result");
        db = "ok";
        // Drizzle 0.45 records journal.when as created_at, not the filename/tag:
        // https://orm.drizzle.team/docs/drizzle-kit-migrate#applied-migrations-log-in-the-database
        const rows = await withHealthReadTimeout(
          sql,
          async (tx) => tx<{ created_at: unknown }[]>`
        SELECT created_at, clock_timestamp() AS checked_at FROM drizzle.__drizzle_migrations
      `,
          deadline,
        );
        return pendingWebMigrations(rows);
      })(),
      QUEUE_READ_TIMEOUT_MS,
    );
    return { db, pending_migrations };
  } catch (err) {
    console.warn("Health check could not establish database/schema readiness.", {
      exception: err instanceof Error ? err.name : typeof err,
    });
    return { db, pending_migrations: null };
  }
}

// Secrets without which sign-in or join cannot work. Presence only: no shape
// or strength check, and the body never names which one is absent. The
// server-side warning lists names, never values (TOG-12400).
export const REQUIRED_SECRETS = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
] as const;
type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

export type ConfigReadiness = { config?: "missing" };

export function missingSecrets(env: Partial<Record<RequiredSecret, unknown>>): RequiredSecret[] {
  return REQUIRED_SECRETS.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

// A ready Worker adds nothing to the body, so its shape stays unchanged.
export function configReadiness(env: Partial<Record<RequiredSecret, unknown>>): ConfigReadiness {
  const missing = missingSecrets(env);
  if (missing.length === 0) return {};
  console.warn("Health check found required Worker secrets missing.", { missing });
  return { config: "missing" };
}

export function upHttpStatus(body: DatabaseReadiness & ConfigReadiness): 200 | 503 {
  return body.config === undefined && body.db === "ok" && body.pending_migrations === 0 ? 200 : 503;
}

// Deployed-revision marker (staging only: the `version_metadata` binding is
// declared at the top level of wrangler.jsonc and, like every binding, is not
// inherited by `env.production`, so a production `/up` body stays unchanged).
// `version_id` is the Worker Version ID: the exact value `wrangler rollback`
// takes, so a rollback is proven by reading it back from the live Worker.
// `commit` is the deploy tag, accepted only as a full lowercase SHA-1 so an
// arbitrary manual tag never reaches a public body; otherwise `null`.
export type RevisionReadiness = {
  revision?: { version_id: string; commit: string | null };
};

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function revisionReadiness(
  meta: { id?: unknown; tag?: unknown } | null | undefined,
): RevisionReadiness {
  if (typeof meta?.id !== "string" || meta.id === "") return {};
  const commit = typeof meta.tag === "string" && COMMIT_SHA.test(meta.tag) ? meta.tag : null;
  return { revision: { version_id: meta.id, commit } };
}

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

type QueueHealth = { status: "healthy" | "degraded"; queue: QueuePayload };
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
 */
async function queueBody(measure: (() => Promise<QueueDepth>) | null): Promise<QueueHealth> {
  // Legacy: `queue driver 'x' has no countable depth.` — here: no ledger to read.
  if (!measure)
    return { status: "healthy", queue: unknownQueue("queue ledger is not configured.") };

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
    oldest_ready_wait_age_seconds: depth.oldestReadyWaitAgeSeconds,
    ready_wait_severity: readyWaitSeverity(depth.oldestReadyWaitAgeSeconds),
    warn_at: QUEUE_WARN_AT,
    critical_at: QUEUE_CRITICAL_AT,
    detail: null,
  };
  return { status: queue.status === "degraded" ? "degraded" : "healthy", queue };
}
