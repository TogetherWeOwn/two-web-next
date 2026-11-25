import { readRevision } from "../bin/revision-check.mjs";
import { observeStaging, STAGING_ORIGIN } from "./staging-provenance.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isUuid = (value) => typeof value === "string" && value.length === 36 && UUID.test(value);

export function orderedDeploymentTime(value) {
  const parsed =
    typeof value === "string" &&
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parsed || parsed[0] !== value) throw new Error("Invalid staging deployment timestamp");
  const [, time, fraction = "", offset] = parsed;
  const wallClock = new Date(`${time}Z`).toJSON();
  const utc = new Date(`${time}${offset}`).toJSON();
  if (!utc || !wallClock?.startsWith(time)) {
    throw new Error("Invalid staging deployment timestamp");
  }
  return `${utc.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`;
}

async function readProvider(path, { accountId, token, fetchImpl = fetch }) {
  if (
    typeof accountId !== "string" ||
    accountId.length !== 32 ||
    !/^[0-9a-f]{32}$/.test(accountId) ||
    typeof token !== "string" ||
    !token
  ) {
    throw new Error("Missing staging allocation read inputs");
  }
  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next/${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "cache-control": "no-cache",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error("Request failed");
    const payload = await response.json();
    if (payload?.success !== true) throw new Error("Provider refused");
    return payload.result;
  } catch {
    throw new Error("Cannot read staging provider evidence");
  }
}

async function readActiveStagingAllocation(options) {
  const deployments = (await readProvider("deployments", options))?.deployments;
  if (!Array.isArray(deployments) || !deployments.length) {
    throw new Error("Missing staging provider allocations");
  }
  const ids = new Set();
  const starts = new Set();
  let latest;
  for (const row of deployments) {
    const allocationId = row?.id;
    const allocationStartedAt = orderedDeploymentTime(row?.created_on);
    if (!isUuid(allocationId) || ids.has(allocationId) || starts.has(allocationStartedAt)) {
      throw new Error("Ambiguous staging provider allocations");
    }
    ids.add(allocationId);
    starts.add(allocationStartedAt);
    if (!latest || allocationStartedAt > latest.allocationStartedAt) {
      latest = { allocationId, allocationStartedAt, versions: row.versions };
    }
  }
  const { allocationId, allocationStartedAt, versions } = latest;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !isUuid(versions[0].version_id)
  ) {
    throw new Error("Staging allocation must serve one Worker at 100 percent");
  }
  // Provider deployments are distinct records, including rollbacks to a reused
  // UUID. If the same allocation is still newest, nothing has superseded it.
  return { allocationId, allocationStartedAt, workerVersion: versions[0].version_id };
}

async function observeStagingServing(sha, { fetchImpl, now }) {
  try {
    const identity = await observeStaging({ expected: sha, fetchImpl, now });
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
    if (revision?.commit !== sha || !isUuid(revision.version_id)) throw new Error("Wrong revision");
    return { ...identity, workerVersion: revision.version_id };
  } catch {
    throw new Error("Staging serving identity or readiness could not be verified");
  }
}

export async function observeStagingAllocation(sha, options) {
  const { fetchImpl = fetch, now = Date.now } = options;
  const serving = await observeStagingServing(sha, { fetchImpl, now: now() });
  const version = await readProvider(`versions/${serving.workerVersion}`, options);
  const allocation = await readActiveStagingAllocation(options);
  const observedAt = new Date(now()).toISOString();
  if (
    serving.workerVersion !== allocation.workerVersion ||
    version?.id !== allocation.workerVersion ||
    version.annotations?.["workers/tag"] !== sha ||
    Date.parse(orderedDeploymentTime(version.metadata?.created_on)) !==
      Date.parse(serving.deployedAt) ||
    allocation.allocationStartedAt > orderedDeploymentTime(observedAt)
  ) {
    throw new Error("Staging serving identity does not match the provider allocation");
  }
  return { ...serving, ...allocation, observedAt };
}

export function requireStagingAllocationPair(sha, before, after) {
  if (
    !isUuid(before?.allocationId) ||
    !isUuid(before.workerVersion) ||
    before.allocationId !== after?.allocationId ||
    before.workerVersion !== after.workerVersion ||
    before.allocationStartedAt !== after.allocationStartedAt ||
    before.allocationStartedAt !== orderedDeploymentTime(before.allocationStartedAt)
  ) {
    throw new Error("Staging provider allocation changed or is unproven");
  }
  if (
    before.sha !== sha ||
    after.sha !== sha ||
    before.deployedAt !== after.deployedAt ||
    orderedDeploymentTime(before.deployedAt) > before.allocationStartedAt ||
    before.allocationStartedAt > orderedDeploymentTime(before.observedAt) ||
    orderedDeploymentTime(before.observedAt) > orderedDeploymentTime(after.observedAt)
  ) {
    throw new Error("Inconsistent staging allocation observations");
  }
}
