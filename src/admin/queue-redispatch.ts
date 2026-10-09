import type { Context, Next } from "hono";
import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import {
  loadRedispatchCandidate,
  parseFailureId,
  type FailedJobPreview,
  type FailedJobReplayCandidate,
} from "../jobs/preview";
import { pgQueueLedger, pgUniqueLock } from "../jobs/postgres";
import { replayFailedSyncEvent } from "../jobs/replay";
import { bufferedMemberJson } from "../member-reads";
import { QA_IDENTITIES, STAGING_APP_URL } from "../qa";
import type { QueuePreviewVars } from "./queue-preview";

/**
 * The one dedicated principal allowed past the moderator gate for queue
 * operations. A bare snowflake shape is not enough: QA identities can never
 * activate the boundary, and an unset value denies every request.
 */
export function configuredOperator(env: Env): string | null {
  const id = env.QUEUE_RECONCILE_OPERATOR_ID;
  return id &&
    /^\d{10,25}$/.test(id) &&
    !Object.values(QA_IDENTITIES).some((qa) => qa.discordId === id)
    ? id
    : null;
}

/**
 * Test-only seam (production resolves through the same seams as the preview).
 * Route tests inject a candidate loader and a dispatch double so no source
 * database is needed; the Postgres suite leaves it unset and exercises the
 * real producer path against a migrated database.
 */
export type RedispatchDeps = {
  loadCandidate?: (env: Env, failureId: number) => Promise<FailedJobReplayCandidate | null>;
  dispatch?: (eventKey: string, idempotencyKey: string) => Promise<boolean>;
};

type EnvWithRedispatchDeps = Env & { REDISPATCH_DEPS?: RedispatchDeps };

function depsFor(env: Env): RedispatchDeps {
  return (env as EnvWithRedispatchDeps).REDISPATCH_DEPS ?? {};
}

/**
 * Default producer dispatch: one reconciled sync-event through the tracked
 * producer path, which mints a fresh live ledger row. The dead row is never
 * touched here — no delete, no refusal reset, no budget change. A missing
 * queue binding or database fails closed before anything is written.
 */
async function dispatchRedispatch(
  env: Env,
  eventKey: string,
  idempotencyKey: string,
): Promise<boolean> {
  const queue = env.SYNC_EVENT_QUEUE;
  if (!queue) throw new Error("no dispatch queue bound");
  const url = databaseUrl(env);
  if (!url) throw new Error("no dispatch database configured");
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  try {
    return await replayFailedSyncEvent(
      queue,
      pgQueueLedger(sql),
      pgUniqueLock(sql),
      eventKey,
      idempotencyKey,
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Operational writes use the existing activity trail, not invented member subjects. */
export async function recordQueueRedispatchAccess(
  env: Env,
  actorId: string,
  preview: FailedJobPreview,
): Promise<void> {
  const url = databaseUrl(env);
  if (!url) throw new Error("no audit database configured");
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  try {
    // This is the only write besides the new live queue row and its lock
    // lease: one audit receipt, no job/source mutations. Do not persist
    // payloads, failure diagnostics, ledger keys or idempotency keys.
    await sql`insert into activity_log
      (log_name, description, subject_type, subject_id, causer_type, causer_id, event, properties)
      values ('operations', 'queue.failed.redispatch', 'queue_failed_jobs', ${String(preview.failure.id)},
        'User', ${actorId}, 'dispatch', ${sql.json({
          disposition: { before: null, after: preview.disposition.action },
          reason: { before: null, after: preview.disposition.reason },
          observedAt: { before: null, after: preview.observedAt },
        })})`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/**
 * Register before adminGuard. Same staging/default-off gating and principal
 * check as the preview admission: disabled means no session or source lookup.
 * Its post-next audit runs after the dispatch, before any buffered contents
 * leave the request. Audit failure always refuses.
 * https://hono.dev/docs/guides/middleware#execution-order
 */
export async function queueRedispatchAdmission(c: Context<QueuePreviewVars>, next: Next) {
  c.header("cache-control", "private, no-store");
  if (
    c.env.QUEUE_RECONCILE_PREVIEW_ENABLED !== "true" ||
    c.env.APP_URL !== STAGING_APP_URL ||
    !configuredOperator(c.env) ||
    new URL(c.req.url).origin !== STAGING_APP_URL
  ) {
    return c.json({ error: "redispatch_disabled" }, 404);
  }
  // POSTs carry the outer same-origin guard, but the preview asserts its own
  // explicit origin for the same reason: never infer it from a cookie, token
  // or forwarded host header.
  if (c.req.header("origin") !== c.env.APP_URL) return c.json({ error: "cross_origin" }, 403);
  if (c.req.method !== "POST") {
    c.header("allow", "POST");
    return c.json({ error: "method_not_allowed" }, 405);
  }
  await next();
  if (c.res.status !== 200) return;
  // A deduped report carries no new receipt: the in-flight dispatch owns it.
  const preview = c.get("queueRedispatchAudit");
  if (!preview) {
    c.header("cache-control", "private, no-store");
    return;
  }
  try {
    const actor = c.get("adminActor");
    if (!actor || actor.id !== configuredOperator(c.env))
      throw new Error("missing redispatch audit context");
    await recordQueueRedispatchAccess(c.env, actor.id, preview);
  } catch {
    // No raw exception message, SQL bindings or diagnostic payload in logs.
    c.res = c.json({ error: "redispatch_unavailable" }, 503);
  }
  c.header("cache-control", "private, no-store");
}

export async function queueRedispatchHandler(c: Context<QueuePreviewVars>) {
  if (c.get("adminActor").id !== configuredOperator(c.env)) {
    return bufferedMemberJson(c, { error: "operator_required" }, 403);
  }
  const id = parseFailureId(c.req.param("id") ?? "");
  // No payload, event key, idempotency key or query overrides are admitted.
  // The body is never parsed: dispatch always starts from the original
  // authorized source the candidate loader reconciles.
  if (id === null || new URL(c.req.url).search !== "")
    return bufferedMemberJson(c, { error: "invalid_failure_id" }, 422);
  const deps = depsFor(c.env);
  let candidate: FailedJobReplayCandidate | null;
  try {
    candidate = await (deps.loadCandidate ?? loadRedispatchCandidate)(c.env, id);
  } catch {
    return bufferedMemberJson(c, { error: "redispatch_unavailable" }, 503);
  }
  if (!candidate) return bufferedMemberJson(c, { error: "failure_not_found" }, 404);
  if (candidate.preview.disposition.action !== "replay" || !candidate.eventKey) {
    // Refusal: the row stays untouched and the preview advice is unchanged.
    // Stale rows are never deleted here either — only replay dispatches.
    return bufferedMemberJson(
      c,
      {
        error: "redispatch_refused",
        failure: candidate.preview.failure,
        disposition: candidate.preview.disposition,
      },
      409,
    );
  }
  let dispatched: boolean;
  try {
    // A due recovery reuses its immutable request identity, the same rule the
    // scheduled pass applies; otherwise a fresh key is minted. A held lock
    // means another dispatch is already in flight: report it instead of
    // queueing a duplicate.
    const key = candidate.idempotencyKey ?? crypto.randomUUID();
    dispatched =
      deps.dispatch !== undefined
        ? await deps.dispatch(candidate.eventKey, key)
        : await dispatchRedispatch(c.env, candidate.eventKey, key);
  } catch {
    return bufferedMemberJson(c, { error: "redispatch_unavailable" }, 503);
  }
  if (!dispatched) {
    return bufferedMemberJson(c, {
      redispatched: true,
      deduped: true,
      ...candidate.preview,
    });
  }
  c.set("queueRedispatchAudit", candidate.preview);
  return bufferedMemberJson(c, { redispatched: true, ...candidate.preview });
}
