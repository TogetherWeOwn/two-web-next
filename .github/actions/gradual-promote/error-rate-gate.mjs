// Live error-rate gate for one gradual-promotion stage.
//
// Ships inside the shared composite action next to gradual-promote.mjs,
// which holds the pure query/parse/evaluate helpers. This file owns the
// network: immediately after smoke it asks the Cloudflare GraphQL Analytics API for
// the promoted version's invocation errors and requests over the window
// since the stage's smoke gate finished (ERROR_RATE_WINDOW_START,
// capped by the configured lookback; `workersInvocationsAdaptive`,
// filtered by scriptVersion), so the smoke probes themselves never
// count, and exits non-zero when the rate is over threshold, so the
// action's existing failure-driven rollback steps restore the
// pre-promote version. Query or parse failures also exit non-zero
// (fail closed) after the configured attempts. An insufficient sample retries
// while analytics aggregates catch up, then passes with a warning: the
// per-stage smoke gate has already probed the new version directly, and
// a quiet window must not strand a promotion forever.
//
// The API token comes from the environment only (CLOUDFLARE_API_TOKEN)
// and is never printed; responses are parsed by the fail-closed helper
// and never echoed. ERROR_RATE_FIXTURE points at a saved GraphQL
// envelope instead of the network: the staging rehearsal uses it to
// prove a simulated elevated rate halts through this exact code path.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertErrorRateIdentifiers,
  buildErrorRateQuery,
  errorRateWindowSince,
  evaluateErrorRate,
  parseErrorRateResponse,
  parseWindowStartIso,
} from "./gradual-promote.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

async function defaultFetchJson(body, token, timeoutMs) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`error-rate GraphQL query failed with HTTP ${response.status}`);
  }
  return response.json();
}

function formatLine({ requests, errors, rate, verdict, attempt, attempts }) {
  return (
    `error-rate requests=${requests} errors=${errors} rate=${rate.toFixed(4)} ` +
    `verdict=${verdict} attempt=${attempt}/${attempts}`
  );
}

export async function runErrorRateGate(config, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
  const fetchJson =
    deps.fetchJson ?? ((body, timeoutMs) => defaultFetchJson(body, config.apiToken, timeoutMs));
  const log = deps.log ?? ((line) => console.log(line));
  // Adapted from two-web-next PR #2093 at f8c9803cb2c1. The former initial
  // delay is an allowance for multi-attempt gates. A single attempt retains
  // its original observation time because it cannot retry an early low sample.
  // Keep the original scheduled + API budget and attempt cap; an immediate
  // query does not buy an extra call, retry or a renewed deadline.
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const startedMs = monotonicNow();
  const deadlineMs =
    startedMs +
    (config.soakSeconds + (config.attempts - 1) * config.retrySeconds) * 1000 +
    config.attempts * 30_000;
  const expired = (attempts, lastVerdict) => {
    log(
      "::warning::error-rate observation budget expired; evidence is insufficient, not a rate pass",
    );
    // Only a parsed low sample has the existing procedural exception. Missing
    // queries/identity or a late response must not gain it by exhausting time.
    return {
      code: lastVerdict === "insufficient" ? 0 : 1,
      attempts,
      requests: 0,
      errors: 0,
      rate: 0,
      verdict: "insufficient",
    };
  };

  if (config.fixturePayload !== undefined) {
    // A fixture verdict must never be mistaken for a live one: composite
    // steps inherit the caller's job env, so ERROR_RATE_FIXTURE could be
    // set without any action input naming it.
    log(
      "::warning::error-rate gate is judging a rehearsal fixture " +
        "(ERROR_RATE_FIXTURE), not live Cloudflare analytics",
    );
  }

  // Smoke stamps one second beyond its finish to exclude its final inclusive
  // analytics bucket. Wait only for that boundary, not a blind aggregation soak.
  if (config.windowStartIso !== undefined && config.windowStartIso !== "") {
    const boundaryMs = parseWindowStartIso(config.windowStartIso) + 1;
    let waitMs = boundaryMs - now().getTime();
    while (waitMs > 0) {
      const remainingMs = deadlineMs - monotonicNow();
      if (waitMs >= remainingMs) return expired(0);
      await sleep(waitMs / 1000);
      // Timers may resume early; opening the window must not spend an attempt.
      waitMs = boundaryMs - now().getTime();
    }
  }

  if (config.attempts === 1) {
    const observationMs = startedMs + config.soakSeconds * 1000;
    let waitMs = observationMs - monotonicNow();
    while (waitMs > 0) {
      const remainingMs = deadlineMs - monotonicNow();
      if (remainingMs <= 0) return expired(0);
      await sleep(Math.min(waitMs, remainingMs) / 1000);
      waitMs = observationMs - monotonicNow();
    }
  }

  let last = { requests: 0, errors: 0, rate: 0, verdict: "error" };
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const until = now();
    const remainingMs = Math.floor(deadlineMs - monotonicNow());
    if (remainingMs <= 0) return expired(attempt - 1, last.verdict);
    try {
      const since = errorRateWindowSince({
        windowStartIso: config.windowStartIso,
        until,
        windowMinutes: config.windowMinutes,
      });
      const body = buildErrorRateQuery({
        accountId: config.accountId,
        scriptName: config.scriptName,
        versionId: config.versionId,
        sinceIso: since.toISOString(),
        untilIso: until.toISOString(),
      });
      const payload =
        config.fixturePayload ?? (await fetchJson(body, Math.min(30_000, remainingMs)));
      const sums = parseErrorRateResponse(payload, config.versionId);
      const { verdict, rate } = evaluateErrorRate({
        ...sums,
        threshold: config.threshold,
        minRequests: config.minRequests,
      });
      // A completed call can prove a candidate-bound breach even at expiry.
      // Retain that rollback evidence, but never admit a late success or give
      // a late low sample the procedural exception. No further call is allowed.
      if (verdict !== "fail" && monotonicNow() >= deadlineMs) return expired(attempt);
      last = { ...sums, rate, verdict };
      log(formatLine({ ...last, attempt, attempts: config.attempts }));
      if (verdict === "fail") return { code: 1, attempts: attempt, ...last };
      if (verdict === "pass") return { code: 0, attempts: attempt, ...last };
    } catch (error) {
      // Fail closed after retries. The message is the helper's own
      // (payload-free) or a bare HTTP status; never the raw response.
      last = { requests: 0, errors: 0, rate: 0, verdict: "error" };
      log(
        `error-rate verdict=error attempt=${attempt}/${config.attempts} ` +
          `detail=${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    if (attempt < config.attempts) {
      const remainingMs = deadlineMs - monotonicNow();
      if (remainingMs <= 0) return expired(attempt, last.verdict);
      // Defer the removed initial allowance to the first retry, so early low
      // samples do not shorten the original final observation opportunity.
      const retrySeconds = config.retrySeconds + (attempt === 1 ? config.soakSeconds : 0);
      if (retrySeconds > 0) await sleep(Math.min(retrySeconds, remainingMs / 1000));
    }
  }

  if (monotonicNow() >= deadlineMs) return expired(config.attempts, last.verdict);
  if (last.verdict === "insufficient") {
    log(
      "::warning::error-rate evidence is insufficient, not a measured rate pass; " +
        "continuing under the existing low-sample policy after the direct smoke gate",
    );
    return { code: 0, attempts: config.attempts, ...last };
  }
  return { code: 1, attempts: config.attempts, ...last };
}

function numberFromEnv(env, name, fallback, { integer = false, min = 0, max } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    (max !== undefined && value > max) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} ${range}`);
  }
  return value;
}

export function configFromEnv(env) {
  const fixturePath = env.ERROR_RATE_FIXTURE || undefined;
  const apiToken = env.CLOUDFLARE_API_TOKEN || undefined;
  if (!fixturePath && !apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required unless ERROR_RATE_FIXTURE is set");
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const scriptName = env.WORKER_NAME ?? "";
  const versionId = env.NEW_VERSION ?? "";
  // Fail fast on static misconfiguration: this runs before the soak, so a
  // typo (threshold 5 for 5 percent, an empty id) surfaces in seconds
  // instead of after the soak and retry sleeps.
  assertErrorRateIdentifiers({ accountId, scriptName, versionId });
  const windowStartIso = env.ERROR_RATE_WINDOW_START || undefined;
  if (windowStartIso !== undefined) {
    try {
      parseWindowStartIso(windowStartIso);
    } catch (error) {
      throw new Error(`ERROR_RATE_WINDOW_START is invalid: ${error.message}`);
    }
  }
  return {
    accountId,
    scriptName,
    versionId,
    apiToken,
    fixturePayload: fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined,
    threshold: numberFromEnv(env, "ERROR_RATE_THRESHOLD", 0.05, { max: 1 }),
    minRequests: numberFromEnv(env, "ERROR_RATE_MIN_REQUESTS", 20, { integer: true, min: 1 }),
    windowMinutes: numberFromEnv(env, "ERROR_RATE_WINDOW_MINUTES", 10, { integer: true, min: 1 }),
    windowStartIso,
    soakSeconds: numberFromEnv(env, "ERROR_RATE_SOAK_SECONDS", 60, { integer: true }),
    attempts: numberFromEnv(env, "ERROR_RATE_ATTEMPTS", 3, { integer: true, min: 1 }),
    retrySeconds: numberFromEnv(env, "ERROR_RATE_RETRY_SECONDS", 60, { integer: true }),
  };
}

// Node realpath-resolves the main module for import.meta.url but leaves
// argv[1] as given, so compare realpaths: the naive URL comparison no-ops
// (a silent pass for a safety gate) when the action path has a symlinked
// component, as on self-hosted runners with a symlinked _work directory.
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
    const result = await runErrorRateGate(configFromEnv(process.env));
    process.exitCode = result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
