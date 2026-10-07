import type { Context, Next } from "hono";
import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import { parseFailureId, previewFailedJob, type FailedJobPreview } from "../jobs/preview";
import { bufferedMemberJson, declareMemberResult } from "../member-reads";
import { QA_IDENTITIES, STAGING_APP_URL } from "../qa";
import type { AccessDecl, Actor } from "./guard";

export type QueuePreviewVars = {
  Bindings: Env;
  Variables: {
    adminActor: Actor;
    access: AccessDecl;
    queuePreviewAudit?: FailedJobPreview;
  };
};

function configuredOperator(env: Env): string | null {
  const id = env.QUEUE_RECONCILE_OPERATOR_ID;
  return id &&
    /^\d{10,25}$/.test(id) &&
    !Object.values(QA_IDENTITIES).some((qa) => qa.discordId === id)
    ? id
    : null;
}

/** Operational reads use the existing activity trail, not invented member subjects. */
export async function recordQueuePreviewAccess(
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
    // This is the only write: one audit receipt, no job/source mutations.
    // Do not persist payloads, failure diagnostics or bot request identities.
    await sql`insert into activity_log
      (log_name, description, subject_type, subject_id, causer_type, causer_id, event, properties)
      values ('operations', 'queue.failed.preview', 'queue_failed_jobs', ${String(preview.failure.id)},
        'User', ${actorId}, 'view', ${sql.json({
          disposition: { before: null, after: preview.disposition.action },
          observedAt: { before: null, after: preview.observedAt },
        })})`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/**
 * Register before adminGuard. Disabled means no session or source lookup.
 * Its post-next audit runs after the admin read capture closes, but before
 * any buffered contents leave the request. Audit failure always refuses.
 * https://hono.dev/docs/guides/middleware#execution-order
 */
export async function queuePreviewAdmission(c: Context<QueuePreviewVars>, next: Next) {
  c.header("cache-control", "private, no-store");
  if (
    c.env.QUEUE_RECONCILE_PREVIEW_ENABLED !== "true" ||
    c.env.APP_URL !== STAGING_APP_URL ||
    !configuredOperator(c.env) ||
    new URL(c.req.url).origin !== STAGING_APP_URL
  ) {
    return c.json({ error: "preview_disabled" }, 404);
  }
  // GET has no global CSRF guard. Require its own explicit same-origin
  // assertion; never infer it from a cookie, token or forwarded host header.
  if (c.req.header("origin") !== c.env.APP_URL) return c.json({ error: "cross_origin" }, 403);
  if (c.req.method !== "GET") {
    c.header("allow", "GET");
    return c.json({ error: "method_not_allowed" }, 405);
  }
  await next();
  if (c.res.status !== 200) return;
  try {
    const preview = c.get("queuePreviewAudit");
    const actor = c.get("adminActor");
    if (!preview || !actor || actor.id !== configuredOperator(c.env))
      throw new Error("missing preview audit context");
    await recordQueuePreviewAccess(c.env, actor.id, preview);
  } catch {
    // No raw exception message, SQL bindings or diagnostic payload in logs.
    c.res = c.json({ error: "preview_unavailable" }, 503);
  }
  c.header("cache-control", "private, no-store");
}

export async function queuePreviewHandler(c: Context<QueuePreviewVars>) {
  c.set("access", {
    resource: "queue_failed_jobs",
    action: "view",
    route: "admin.queue.failed.preview",
  });
  if (c.get("adminActor").id !== configuredOperator(c.env)) {
    return bufferedMemberJson(c, { error: "operator_required" }, 403);
  }
  const id = parseFailureId(c.req.param("id") ?? "");
  // No payload, event key, idempotency key or query overrides are admitted.
  if (id === null || new URL(c.req.url).search !== "")
    return bufferedMemberJson(c, { error: "invalid_failure_id" }, 422);
  try {
    const preview = await previewFailedJob(c.env, id);
    // This operational store returns no member owners or member contents.
    declareMemberResult([]);
    if (!preview) return bufferedMemberJson(c, { error: "failure_not_found" }, 404);
    c.set("queuePreviewAudit", preview);
    return bufferedMemberJson(c, { previewOnly: true, ...preview });
  } catch {
    return bufferedMemberJson(c, { error: "preview_unavailable" }, 503);
  }
}
