// Live error-rate gate for one gradual-promotion stage.
//
// Ships inside the shared composite action next to gradual-promote.mjs,
// which holds the pure query/parse/evaluate helpers. This file owns the
// network: after a soak it asks the Cloudflare GraphQL Analytics API for
// the promoted version's invocation errors and requests over a trailing
// window (`workersInvocationsAdaptive`, filtered by scriptVersion) and
// exits non-zero when the rate is over threshold, so the action's
// existing failure-driven rollback steps restore the pre-promote
// version. Query or parse failures also exit non-zero (fail closed)
// after the configured attempts. An insufficient live sample retries
// while analytics aggregates catch up, then passes with a warning: the
// per-stage smoke gate has already probed the new version directly, and
// a quiet window must not strand a promotion forever.
//
// The API token comes from the environment only (CLOUDFLARE_API_TOKEN)
// and is never printed; responses are parsed by the fail-closed helper
// and never echoed. ERROR_RATE_FIXTURE points at a saved GraphQL
// envelope instead of the network: the staging rehearsal uses it to
// prove a simulated elevated rate halts through this exact code path.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildErrorRateQuery,
  evaluateErrorRate,
  parseErrorRateResponse,
} from "./gradual-promote.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

async function defaultFetchJson(body, token) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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
  const fetchJson = deps.fetchJson ?? ((body) => defaultFetchJson(body, config.apiToken));
  const log = deps.log ?? ((line) => console.log(line));

  if (config.soakSeconds > 0) {
    log(`error-rate soak_seconds=${config.soakSeconds} before first query`);
    await sleep(config.soakSeconds);
  }

  let last = { requests: 0, errors: 0, rate: 0, verdict: "error" };
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const until = now();
    const since = new Date(until.getTime() - config.windowMinutes * 60_000);
    try {
      const body = buildErrorRateQuery({
        accountId: config.accountId,
        scriptName: config.scriptName,
        versionId: config.versionId,
        sinceIso: since.toISOString(),
        untilIso: until.toISOString(),
      });
      const payload = config.fixturePayload ?? (await fetchJson(body));
      const sums = parseErrorRateResponse(payload, config.versionId);
      const { verdict, rate } = evaluateErrorRate({
        ...sums,
        threshold: config.threshold,
        minRequests: config.minRequests,
      });
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
    if (attempt < config.attempts && config.retrySeconds > 0) await sleep(config.retrySeconds);
  }

  if (last.verdict === "insufficient") {
    log(
      "::warning::error-rate gate passing on an insufficient live sample; " +
        "the smoke gate already probed the new version directly",
    );
    return { code: 0, attempts: config.attempts, ...last };
  }
  return { code: 1, attempts: config.attempts, ...last };
}

function numberFromEnv(env, name, fallback, { integer = false, min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${min}`);
  }
  return value;
}

export function configFromEnv(env) {
  const fixturePath = env.ERROR_RATE_FIXTURE || undefined;
  const apiToken = env.CLOUDFLARE_API_TOKEN || undefined;
  if (!fixturePath && !apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required unless ERROR_RATE_FIXTURE is set");
  }
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    scriptName: env.WORKER_NAME ?? "",
    versionId: env.NEW_VERSION ?? "",
    apiToken,
    fixturePayload: fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined,
    threshold: numberFromEnv(env, "ERROR_RATE_THRESHOLD", 0.05),
    minRequests: numberFromEnv(env, "ERROR_RATE_MIN_REQUESTS", 20, { integer: true, min: 1 }),
    windowMinutes: numberFromEnv(env, "ERROR_RATE_WINDOW_MINUTES", 10, { integer: true, min: 1 }),
    soakSeconds: numberFromEnv(env, "ERROR_RATE_SOAK_SECONDS", 60, { integer: true }),
    attempts: numberFromEnv(env, "ERROR_RATE_ATTEMPTS", 3, { integer: true, min: 1 }),
    retrySeconds: numberFromEnv(env, "ERROR_RATE_RETRY_SECONDS", 60, { integer: true }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runErrorRateGate(configFromEnv(process.env));
    process.exitCode = result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
