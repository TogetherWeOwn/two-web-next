import { isDeepStrictEqual } from "node:util";
import {
  buildErrorRateQuery,
  parseErrorRateResponse,
} from "../.github/actions/gradual-promote/gradual-promote.mjs";
import { assertExpectedVersionId } from "../bin/smoke.mjs";
import { PROMOTION_SOAK_MS } from "./resolve-promotion-sha.mjs";
import {
  observeStagingAllocation,
  orderedDeploymentTime,
  requireStagingAllocationPair,
} from "./staging-allocation.mjs";
import { validateStagingIdentityPair } from "./staging-provenance.mjs";

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

// Historical format only. A valid record here does not qualify promotion.
export function validateArchivedStagingSoakReceipt(evidence, receipt, { nowMs = Date.now() } = {}) {
  const base = receiptBase(evidence, nowMs);
  const expected =
    evidence.replacement === undefined
      ? sampleReceipt(base, receipt?.sample, nowMs)
      : supersessionReceipt(base, evidence.replacement, nowMs);
  if (!isDeepStrictEqual(receipt, expected)) throw new Error("Staging soak receipt mismatch");
  return expected;
}

function allocationSoakWindow({ sha, e2e }, nowMs) {
  if (
    !exactSha(sha) ||
    !Number.isFinite(nowMs) ||
    !positiveInteger(e2e?.runId) ||
    e2e.attempt !== 1 ||
    e2e.conclusion !== "success"
  ) {
    throw new Error("Missing successful first-attempt staging E2E evidence");
  }
  const startedAt = timestamp(e2e.startedAt);
  const completedAt = timestamp(e2e.completedAt);
  if (startedAt >= completedAt || completedAt > nowMs) {
    throw new Error("Inconsistent staging E2E chronology");
  }
  const floor = completedAt + PROMOTION_SOAK_MS;
  if (nowMs < floor) throw new Error("Staging soak floor has not elapsed");
  return {
    e2eStartedAt: new Date(startedAt).toISOString(),
    e2eCompletedAt: new Date(completedAt).toISOString(),
    floorAt: new Date(floor).toISOString(),
  };
}

function requireAllocationBeforeE2e(allocation, { e2eStartedAt }) {
  // GitHub timestamps have second precision. At equality the evidence cannot
  // order the allocation and the start of qualification.
  if (allocation.allocationStartedAt >= orderedDeploymentTime(e2eStartedAt)) {
    throw new Error("Staging allocation started after or at E2E start; fresh E2E is required");
  }
}

function buildAllocationReceipt({ sha, e2e, before, after }, sample, nowMs) {
  const window = allocationSoakWindow({ sha, e2e }, nowMs);
  requireStagingAllocationPair(sha, before, after);
  requireAllocationBeforeE2e(before, window);
  if (
    timestamp(before.observedAt) < timestamp(window.floorAt) ||
    sample?.observedAt !== before.observedAt ||
    timestamp(after.observedAt) > nowMs
  ) {
    throw new Error("Staging allocation observations do not bracket the soak sample");
  }
  return sampleReceipt(
    {
      schema: "staging-soak/2",
      sha,
      workerVersion: before.workerVersion,
      deployedAt: before.deployedAt,
      allocationId: before.allocationId,
      allocationStartedAt: before.allocationStartedAt,
      e2eRunId: e2e.runId,
      e2eAttempt: e2e.attempt,
      ...window,
    },
    sample,
    nowMs,
  );
}

export function validateStagingSoakReceipt(evidence, receipt, { nowMs = Date.now() } = {}) {
  if (receipt?.schema !== "staging-soak/2") {
    throw new Error("Staging soak receipt has no allocation proof");
  }
  const expected = buildAllocationReceipt(evidence, receipt.sample, nowMs);
  if (!isDeepStrictEqual(receipt, expected)) throw new Error("Staging soak receipt mismatch");
  return expected;
}

// The producer and verifier share the allocation receipt contract. Both
// observations read the active provider allocation and ordinary staging origin.
export async function captureStagingSoakReceipt(
  { sha, e2e },
  { accountId, token, fetchImpl, now = Date.now } = {},
) {
  const window = allocationSoakWindow({ sha, e2e }, now());
  if (typeof fetchImpl !== "function" || typeof token !== "string" || !token) {
    throw new Error("Staging soak sampling requires a transport and analytics credential");
  }
  const options = { accountId, token, fetchImpl, now };
  const before = await observeStagingAllocation(sha, options);
  requireAllocationBeforeE2e(before, window);
  const { workerVersion, observedAt } = before;
  if (timestamp(observedAt) < timestamp(window.floorAt)) {
    throw new Error("Staging soak floor has not elapsed at observation");
  }
  let counts;
  try {
    const query = buildErrorRateQuery({
      accountId,
      scriptName: "two-web-next",
      versionId: workerVersion,
      sinceIso: window.e2eCompletedAt,
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
    const errors = payload?.errors;
    if (errors !== null && errors !== undefined && !Array.isArray(errors)) {
      throw new Error("Malformed Cloudflare analytics response");
    }
    counts = parseErrorRateResponse(payload, workerVersion);
  } catch {
    // Origin bodies and transport exceptions may contain sensitive detail.
    throw new Error("Version-tagged staging analytics could not be verified");
  }
  const after = await observeStagingAllocation(sha, options);
  const evidence = { sha, e2e, before, after };
  const receipt = buildAllocationReceipt(evidence, { observedAt, workerVersion, ...counts }, now());
  return { evidence, receipt };
}
