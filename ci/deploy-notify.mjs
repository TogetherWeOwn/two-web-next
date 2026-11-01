// Deploy notify: the last step of every production deploy and rollback POSTs
// what happened to the Paperclip deploy-verification routine, where the
// Release Manager verifies it and writes the release log.
//
// The routine URL is the repo variable PAPERCLIP_DEPLOY_WEBHOOK_URL and the
// HMAC key the repo secret PAPERCLIP_DEPLOY_WEBHOOK_SECRET. The body is
// signed as HMAC-SHA256(secret, "<unix seconds>.<exact body>") and sent with
// X-Paperclip-Timestamp and X-Paperclip-Signature: sha256=<hex>. The secret
// and the signature are never printed.
//
// Notification never decides a deploy: the workflow step is
// continue-on-error, and an unconfigured webhook only warns. The Release
// Manager's daily audit cross-checks GitHub runs, so a missed notification is
// still caught.
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const optionalVersion = (value) => (VERSION_PATTERN.test(value ?? "") ? value : null);

// The deploy run's outcome from its job results, in the order a reader needs:
// a completed rollback first, then a clean promotion, then everything else.
export function deployOutcome(env) {
  const promoted = optionalVersion(env.PROMOTED_VERSION_ID);
  if (env.ROLLBACK_RESULT === "success") {
    const reason =
      env.VERIFY_OUTCOME === "failure"
        ? "post-promotion public-route smoke failed after 100%"
        : env.WATCH_BREACH === "true"
          ? "post-deploy watch breach (readiness or error rate)"
          : "automatic rollback";
    return { outcome: "rolled_back", reason };
  }
  if (env.DEPLOY_RESULT === "success" && env.WATCH_RESULT === "success") {
    return { outcome: "success", reason: null };
  }
  if (env.ROLLBACK_RESULT === "failure") {
    return {
      outcome: "failed",
      reason: "automatic rollback failed; production may still serve the promoted version",
    };
  }
  if (env.PREFLIGHT_RESULT === "failure") {
    return {
      outcome: "failed",
      reason: "preflight refused promotion (gate, hold, rollback drill or rollback target)",
    };
  }
  if (env.REGRESSION_RESULT === "failure" || env.SOAK_RESULT === "failure") {
    return { outcome: "failed", reason: "regression check against production refused promotion" };
  }
  if (env.DEPLOY_RESULT === "failure") {
    return {
      outcome: "failed",
      reason: promoted
        ? "deploy job failed during promotion; the gradual action's own rollback ran"
        : "deploy job failed before promotion; production unchanged",
    };
  }
  return { outcome: "failed", reason: `run ended with deploy ${env.DEPLOY_RESULT || "unknown"}` };
}

export function buildPayload(env, { now = () => new Date() } = {}) {
  const event = env.NOTIFY_EVENT;
  if (event !== "deploy" && event !== "rollback") {
    throw new Error("NOTIFY_EVENT must be deploy or rollback");
  }
  const { outcome, reason } =
    event === "deploy"
      ? deployOutcome(env)
      : {
          // A rollback that completed (traffic moved, or the target already
          // served) is a success; anything else failed.
          outcome: env.ROLLBACK_RESULT === "success" ? "success" : "failed",
          reason: env.ROLLBACK_REASON || "manual rollback-production dispatch",
        };
  const sha = /^[0-9a-f]{40}$/.test(env.NOTIFY_SHA ?? "") ? env.NOTIFY_SHA : null;
  return {
    repo: "two-web-next",
    event,
    outcome,
    sha,
    versionId:
      event === "deploy"
        ? optionalVersion(env.PROMOTED_VERSION_ID)
        : optionalVersion(env.ROLLBACK_VERSION_ID),
    previousVersionId:
      event === "deploy"
        ? optionalVersion(env.ROLLBACK_VERSION_ID)
        : optionalVersion(env.EXPECTED_CURRENT_VERSION_ID),
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    startedAt: Number.isFinite(Date.parse(env.NOTIFY_STARTED_AT ?? ""))
      ? env.NOTIFY_STARTED_AT
      : null,
    finishedAt: now().toISOString(),
    reason,
  };
}

export function signBody(secret, body, timestamp) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function notify(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const url = (env.PAPERCLIP_DEPLOY_WEBHOOK_URL ?? "").trim();
  const secret = env.PAPERCLIP_DEPLOY_WEBHOOK_SECRET ?? "";
  const payload = buildPayload(env, { now });
  if (!url || !secret) {
    return { sent: false, payload, detail: "webhook URL or secret not configured" };
  }
  if (!url.startsWith("https://")) throw new Error("PAPERCLIP_DEPLOY_WEBHOOK_URL must be https");
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now().getTime() / 1000));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paperclip-timestamp": timestamp,
      "x-paperclip-signature": signBody(secret, body, timestamp),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`deploy-notify webhook answered HTTP ${response.status}`);
  return { sent: true, payload };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const result = await notify(process.env);
    const { event, outcome, sha, versionId } = result.payload;
    if (result.sent) {
      console.log(
        `deploy-notify sent: ${event} ${outcome} ${sha ?? "no sha"} ${versionId ?? "no version"}`,
      );
    } else {
      console.log(`::warning::deploy-notify not sent: ${result.detail}`);
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
