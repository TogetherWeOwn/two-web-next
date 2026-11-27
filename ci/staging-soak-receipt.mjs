import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import {
  buildErrorRateQuery,
  parseErrorRateResponse,
} from "../.github/actions/gradual-promote/gradual-promote.mjs";
import { readRevision } from "../bin/revision-check.mjs";
import { assertExpectedVersionId } from "../bin/smoke.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";
import { PROMOTION_SOAK_MS } from "./resolve-promotion-sha.mjs";
import { liveVersion } from "./rollback-target.mjs";
import { orderedDeploymentTime } from "./staging-forward.mjs";
import { observeStaging, validateStagingIdentityPair } from "./staging-provenance.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
// The query returns one account and at most one aggregate row.
const MAX_ANALYTICS_RESPONSE_BYTES = 64 * 1024;
// Allow for a page of deployment history, or one version record, with JSON metadata.
const ALLOCATION_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
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
    !Number.isSafeInteger(requests) ||
    requests < (base.schema === "staging-soak/1" ? 1 : 0) ||
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

// Validate archived v1 records only. Promotion requires a live v2 sample.
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
  let identity;
  try {
    identity = await observeStaging({ expected: base.sha, fetchImpl, now });
  } catch {
    throw new Error("Staging origin identity could not be verified");
  }

  let revision;
  try {
    revision = await readRevision(STAGING_ORIGIN, {
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
  } catch {
    throw new Error("Staging readiness contract could not be verified");
  }

  if (
    identity.deployedAt !== base.deployedAt ||
    revision?.commit !== base.sha ||
    revision?.version_id !== base.workerVersion
  ) {
    throw new Error("Staging serving deployment or version mismatch");
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

  await observeServing(base, fetchImpl, startedAt);
  const sampledAt = now();
  if (!Number.isFinite(sampledAt) || sampledAt < startedAt) {
    throw new Error("Invalid staging soak sample clock");
  }
  const counts = await versionTaggedCounts(base, sampledAt, { accountId, token, fetchImpl });
  await observeServing(base, fetchImpl, sampledAt);
  return sampleReceipt(base, counts, now());
}

async function versionTaggedCounts(base, sampledAt, { accountId, token, fetchImpl }) {
  const versionId = base.workerVersion;
  const observedAt = new Date(sampledAt).toISOString();
  let counts;
  try {
    const query = buildErrorRateQuery({
      accountId,
      scriptName: "two-web-next",
      versionId,
      sinceIso: base.e2e?.startedAt ?? base.e2eCompletedAt,
      untilIso: observedAt,
    });
    const signal = AbortSignal.timeout(30_000);
    const response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(query),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Cloudflare analytics response refused");
    const payload = await readBoundedProviderJson(response, signal, MAX_ANALYTICS_RESPONSE_BYTES);
    const errors = payload?.errors;
    if (errors !== null && errors !== undefined && !Array.isArray(errors)) {
      throw new Error("Malformed Cloudflare analytics response");
    }
    counts = parseErrorRateResponse(payload, versionId);
  } catch {
    // Origin bodies and transport exceptions may contain sensitive detail.
    throw new Error("Version-tagged staging analytics could not be verified");
  }
  return { observedAt, workerVersion: versionId, ...counts };
}

async function readBoundedProviderJson(response, signal, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing provider response body");
  const cancel = () => {
    // Source cleanup can stall or fail after the read has already been refused.
    void reader.cancel().catch(() => undefined);
  };
  const deadline = addAbortListener(signal, cancel);
  try {
    if (!response.ok) throw new Error("Request refused");
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error("Provider response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    deadline[Symbol.dispose]();
    cancel();
    reader.releaseLock();
  }
}

// A restored Worker gets a new allocation that must span fresh E2E and sampling.
export async function captureAllocationSoak(
  { sha, e2e },
  { accountId, token, fetchImpl = fetch, now = Date.now },
) {
  const start = timestamp(e2e.startedAt);
  const end = timestamp(e2e.completedAt);
  const floor = end + PROMOTION_SOAK_MS;
  if (!exactSha(sha) || !positiveInteger(e2e.runId) || start >= end) {
    throw new Error("Invalid executed staging E2E evidence");
  }
  if (now() < floor) throw new Error("Staging soak floor has not elapsed");
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId) || !token) {
    throw new Error("Missing staging provider read inputs");
  }
  async function provider(path) {
    try {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next/${path}`,
        {
          headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache" },
          redirect: "error",
          signal,
        },
      );
      const body = await readBoundedProviderJson(
        response,
        signal,
        ALLOCATION_PROVIDER_RESPONSE_BYTES,
      );
      if (body.success !== true || !body.result) throw new Error("Missing provider result");
      return body.result;
    } catch {
      throw new Error("Cannot read staging provider evidence");
    }
  }
  async function active() {
    const { deployments } = await provider("deployments");
    const rows = deployments
      .map((row) => ({ ...row, created_on: orderedDeploymentTime(row.created_on) }))
      .sort((a, b) => b.created_on.localeCompare(a.created_on));
    if (
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      new Set(rows.map((row) => row.created_on)).size !== rows.length
    ) {
      throw new Error("Ambiguous staging allocations");
    }
    const workerVersion = assertExpectedVersionId(liveVersion(rows));
    return {
      allocationId: assertExpectedVersionId(rows[0].id),
      allocationStartedAt: rows[0].created_on,
      workerVersion,
    };
  }
  const allocation = await active();
  if (allocation.allocationStartedAt >= orderedDeploymentTime(e2e.startedAt)) {
    throw new Error("Staging allocation did not precede E2E; fresh E2E is required");
  }
  const version = await provider(`versions/${allocation.workerVersion}`);
  const upload = orderedDeploymentTime(version.metadata?.created_on);
  if (
    version.id !== allocation.workerVersion ||
    version.annotations?.["workers/tag"] !== sha ||
    upload > allocation.allocationStartedAt
  ) {
    throw new Error("Staging provider version does not match the allocation and candidate");
  }
  const base = {
    schema: "staging-soak/2",
    sha,
    ...allocation,
    e2e,
    deployedAt: new Date(upload).toISOString(),
    e2eCompletedAt: new Date(end).toISOString(),
    floorAt: new Date(floor).toISOString(),
  };
  await observeServing(base, fetchImpl, now());
  const observed = now();
  if (observed < floor) throw new Error("Staging soak floor has not elapsed");
  const counts = await versionTaggedCounts(base, observed, { accountId, token, fetchImpl });
  await observeServing(base, fetchImpl, now());
  if (!isDeepStrictEqual(allocation, await active()))
    throw new Error("Staging allocation changed during sampling");
  return sampleReceipt(base, counts, now());
}
