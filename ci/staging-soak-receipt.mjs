import { isDeepStrictEqual } from "node:util";
import {
  buildErrorRateQuery,
  parseErrorRateResponse,
} from "../.github/actions/gradual-promote/gradual-promote.mjs";
import { readRevision } from "../bin/revision-check.mjs";
import { assertExpectedVersionId } from "../bin/smoke.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";
import { PROMOTION_SOAK_MS } from "./resolve-promotion-sha.mjs";
import { observeStaging, validateStagingIdentityPair } from "./staging-provenance.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const SHA = /^[0-9a-f]{40}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const exactSha = (value) => typeof value === "string" && value.length === 40 && SHA.test(value);

function timestamp(value) {
  const ms = typeof value === "string" && UTC.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error("Invalid staging soak timestamp");
  const iso = new Date(ms).toISOString();
  if (value !== iso && value !== iso.replace(/\.000Z$/, "Z")) {
    throw new Error("Invalid staging soak timestamp");
  }
  return ms;
}

function receiptBase({ sha, deployment, e2e }, nowMs) {
  if (
    !Number.isFinite(nowMs) ||
    !exactSha(sha) ||
    !positiveInteger(deployment?.runId) ||
    !positiveInteger(deployment.attempt) ||
    !positiveInteger(e2e?.runId) ||
    e2e.runId === deployment.runId ||
    e2e.attempt !== 1 ||
    e2e.conclusion !== "success"
  ) {
    throw new Error("Missing exact staging deploy and successful first-attempt E2E evidence");
  }
  const completedAt = timestamp(e2e.completedAt);
  if (completedAt > nowMs || timestamp(deployment.deployedAt) > completedAt) {
    throw new Error("Inconsistent staging deploy and E2E chronology");
  }
  validateStagingIdentityPair(sha, deployment, e2e.before, completedAt);
  validateStagingIdentityPair(sha, deployment, e2e.after, completedAt);
  return {
    schema: "staging-soak/1",
    sha,
    workerVersion: assertExpectedVersionId(deployment.workerVersion),
    deployedAt: deployment.deployedAt,
    deployRunId: deployment.runId,
    deployAttempt: deployment.attempt,
    e2eRunId: e2e.runId,
    e2eAttempt: e2e.attempt,
    e2eCompletedAt: new Date(completedAt).toISOString(),
    floorAt: new Date(completedAt + PROMOTION_SOAK_MS).toISOString(),
  };
}

function supersessionReceipt(base, replacement, nowMs) {
  const observedAt = timestamp(replacement?.observedAt);
  const workerVersion = assertExpectedVersionId(replacement.workerVersion);
  if (
    !exactSha(replacement.sha) ||
    workerVersion === base.workerVersion ||
    observedAt <= timestamp(base.deployedAt) ||
    observedAt > nowMs
  ) {
    throw new Error("Invalid staging supersession evidence");
  }
  return {
    ...base,
    status: "superseded",
    replacement: {
      sha: replacement.sha,
      workerVersion,
      observedAt: new Date(observedAt).toISOString(),
    },
  };
}

function sampleReceipt(base, sample, nowMs) {
  const observedAt = timestamp(sample?.observedAt);
  if (observedAt < timestamp(base.floorAt) || observedAt > nowMs) {
    throw new Error("Sample is outside the post-floor observation window");
  }
  const { workerVersion, requests, errors } = sample;
  if (
    workerVersion !== base.workerVersion ||
    !positiveInteger(requests) ||
    !Number.isSafeInteger(errors) ||
    errors < 0 ||
    errors > requests
  ) {
    throw new Error("Missing or invalid version-tagged staging counts");
  }
  return {
    ...base,
    status: "sampled",
    sample: { observedAt: new Date(observedAt).toISOString(), workerVersion, requests, errors },
  };
}

// Validate against the independently retained deployment and E2E evidence.
// Known supersession takes precedence even if the earlier sample is retained.
export function validateStagingSoakReceipt(evidence, receipt, { nowMs = Date.now() } = {}) {
  const base = receiptBase(evidence, nowMs);
  const expected =
    evidence.replacement === undefined
      ? sampleReceipt(base, receipt?.sample, nowMs)
      : supersessionReceipt(base, evidence.replacement, nowMs);
  if (!isDeepStrictEqual(receipt, expected)) throw new Error("Staging soak receipt mismatch");
  return expected;
}

async function observeServing(base, fetchImpl, now) {
  try {
    const identity = await observeStaging({ expected: base.sha, fetchImpl, now });
    const revision = await readRevision(STAGING_ORIGIN, {
      fetchImpl: async (url, init) => {
        const response = await fetchImpl(url, init);
        const cacheControl = response.headers.get("cache-control")?.toLowerCase().split(",");
        if (
          response.status !== 200 ||
          response.headers.get("x-two-origin") !== "two-web-next" ||
          !cacheControl?.some((directive) => directive.trim() === "no-store")
        ) {
          throw new Error("Staging readiness response refused");
        }
        return response;
      },
    });
    if (
      identity.deployedAt !== base.deployedAt ||
      revision?.commit !== base.sha ||
      revision?.version_id !== base.workerVersion
    ) {
      throw new Error("Staging serving identity does not match the deployment");
    }
  } catch {
    throw new Error("Staging serving identity or readiness could not be verified");
  }
}

// Single attempt on ordinary staging routing. The caller supplies the transport
// and retains the returned record. This helper has no file or workflow writes.
export async function captureStagingSoakReceipt(
  evidence,
  { accountId, token, fetchImpl, now = Date.now } = {},
) {
  const startedAt = now();
  const base = receiptBase(evidence, startedAt);
  if (evidence.replacement !== undefined) {
    return supersessionReceipt(base, evidence.replacement, startedAt);
  }
  if (startedAt < timestamp(base.floorAt)) throw new Error("Staging soak floor has not elapsed");
  if (typeof fetchImpl !== "function" || typeof token !== "string" || !token) {
    throw new Error("Staging soak sampling requires a transport and analytics credential");
  }

  const versionId = base.workerVersion;
  await observeServing(base, fetchImpl, startedAt);
  const sampledAt = now();
  if (!Number.isFinite(sampledAt) || sampledAt < startedAt) {
    throw new Error("Invalid staging soak sample clock");
  }
  const observedAt = new Date(sampledAt).toISOString();
  let counts;
  try {
    const query = buildErrorRateQuery({
      accountId,
      scriptName: "two-web-next",
      versionId,
      sinceIso: base.e2eCompletedAt,
      untilIso: observedAt,
    });
    const response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(query),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Cloudflare analytics response refused");
    const payload = await response.json();
    if (payload?.errors !== undefined && !Array.isArray(payload.errors)) {
      throw new Error("Malformed Cloudflare analytics response");
    }
    counts = parseErrorRateResponse(payload, versionId);
  } catch {
    // Origin bodies and transport exceptions may contain sensitive detail.
    throw new Error("Version-tagged staging analytics could not be verified");
  }
  await observeServing(base, fetchImpl, sampledAt);
  return sampleReceipt(base, { observedAt, workerVersion: versionId, ...counts }, now());
}
