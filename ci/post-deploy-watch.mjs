// Post-deploy watch: for 30 minutes after a promotion reaches 100%, probe
// production readiness every minute and judge the promoted version's live
// error rate every five minutes. A breach exits 1, and deploy-production.yml
// then rolls back to the recorded pre-promote version through
// rollback-production.yml.
//
// Readiness is the /up envelope bin/smoke.mjs already requires (HTTP 200,
// db ok, zero pending migrations, healthy or degraded status) plus identity:
// revision.version_id must be the promoted version. Three consecutive misses
// breach, so one dropped request never rolls back a healthy release. A
// different live version means someone else deployed or rolled back: the
// watch stands down without a verdict on it.
//
// Only a breach writes breach=true to GITHUB_OUTPUT; the rollback job keys
// on that output, so a misconfigured watch fails red without rolling back a
// healthy release.
//
// The error rate reuses the gradual-promote gate (Workers analytics for the
// promoted scriptVersion since the watch began, same 5% threshold and
// 20-request floor). An insufficient sample passes; a query error warns and
// does not roll back, because readiness still probes the version directly.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runErrorRateGate } from "../.github/actions/gradual-promote/error-rate-gate.mjs";
import { APEX_ORIGIN } from "./operator-constants.mjs";

export const WATCH_DEFAULTS = {
  durationSeconds: 30 * 60,
  intervalSeconds: 60,
  readinessMisses: 3,
  errorRateEverySeconds: 5 * 60,
  threshold: 0.05,
  minRequests: 20,
};

const VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One readiness probe: "ok", "superseded" (another version serves) or a
// miss reason.
export async function probeReadiness({ origin, versionId, fetchImpl = fetch }) {
  let response;
  let body;
  try {
    response = await fetchImpl(new URL("/up", origin), {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch (error) {
    return {
      state: "miss",
      reason: `unreachable (${error instanceof Error ? error.name : "error"})`,
    };
  }
  const served = body?.revision?.version_id;
  if (typeof served === "string" && VERSION_PATTERN.test(served) && served !== versionId) {
    return { state: "superseded", reason: `production now serves ${served}` };
  }
  if (response.status !== 200) return { state: "miss", reason: `HTTP ${response.status}` };
  if (
    body?.db !== "ok" ||
    body?.pending_migrations !== 0 ||
    !["healthy", "degraded"].includes(body?.status)
  ) {
    return { state: "miss", reason: "unready /up envelope" };
  }
  if (served !== versionId) return { state: "miss", reason: "no revision.version_id" };
  return { state: "ok" };
}

export async function watchProduction(config, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
  const log = deps.log ?? ((line) => console.log(line));
  const probe = deps.probe ?? probeReadiness;
  const errorRate = deps.errorRate ?? runErrorRateGate;
  const settings = { ...WATCH_DEFAULTS, ...config };
  if (!VERSION_PATTERN.test(settings.versionId ?? "")) {
    throw new Error("PROMOTED_VERSION_ID must be a Worker Version ID (lowercase UUID)");
  }
  const started = now();
  const deadline = started.getTime() + settings.durationSeconds * 1000;
  let misses = 0;
  let judged = 0;
  let lastErrorRateAt = started.getTime();
  for (;;) {
    const result = await probe({ origin: settings.origin, versionId: settings.versionId });
    if (result.state === "superseded") {
      log(`::notice::watch stands down: ${result.reason}`);
      return { verdict: "superseded", judged };
    }
    if (result.state === "ok") {
      misses = 0;
    } else {
      misses += 1;
      log(`readiness miss ${misses}/${settings.readinessMisses}: ${result.reason}`);
      if (misses >= settings.readinessMisses) {
        log(`::error::readiness breach: ${settings.readinessMisses} consecutive misses`);
        return { verdict: "breach", reason: "readiness", judged };
      }
    }
    const at = now().getTime();
    const final = at >= deadline;
    if (final || at - lastErrorRateAt >= settings.errorRateEverySeconds * 1000) {
      lastErrorRateAt = at;
      const rate = await errorRate(
        {
          accountId: settings.accountId,
          scriptName: settings.workerName,
          versionId: settings.versionId,
          apiToken: settings.apiToken,
          threshold: settings.threshold,
          minRequests: settings.minRequests,
          windowMinutes: Math.ceil(settings.durationSeconds / 60) + 5,
          windowStartIso: started.toISOString(),
          soakSeconds: 0,
          attempts: 1,
          retrySeconds: 0,
        },
        { log },
      );
      if (rate.verdict === "fail") {
        log("::error::error-rate breach on the promoted version");
        return { verdict: "breach", reason: "error-rate", judged: judged + 1 };
      }
      if (rate.verdict === "error") {
        log("::warning::error-rate query failed; readiness still gates this watch");
      } else {
        judged += 1;
      }
    }
    if (final) break;
    await sleep(settings.intervalSeconds);
  }
  if (judged === 0) {
    log("::warning::no error-rate judgment succeeded during the watch; readiness held throughout");
  }
  log(`post-deploy watch passed for ${settings.versionId}`);
  return { verdict: "pass", judged };
}

export function configFromEnv(env) {
  return {
    origin: (env.WATCH_ORIGIN ?? "").trim() || APEX_ORIGIN,
    versionId: env.PROMOTED_VERSION_ID ?? "",
    workerName: env.WORKER_NAME ?? "two-web-next-production",
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: env.CLOUDFLARE_API_TOKEN || undefined,
  };
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
    const config = configFromEnv(process.env);
    if (!config.apiToken || !config.accountId) {
      throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    }
    const result = await watchProduction(config);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `verdict=${result.verdict}\nbreach=${result.verdict === "breach"}\n`,
      );
    }
    process.exitCode = result.verdict === "breach" ? 1 : 0;
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
