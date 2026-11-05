// Read-only deployment observation, not traffic selection or recovery authority.
// Installed callers must independently hold staging exclusion and admit the
// baseline artifact. Provider observations alone do not exclude outside writers.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { boundedResult } from "./candidate-staging-settings.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate serving refused: observation";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

function keys(value, required, optional = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const requiredKeys = required.split(",").filter(Boolean);
  const allowed = new Set([...requiredKeys, ...optional.split(",").filter(Boolean)]);
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function uuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function text(value, max) {
  return typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

function deployment(raw, now) {
  requireEvidence(
    keys(raw, "id,created_on,source,strategy,versions", "annotations,author_email") &&
      uuid(raw.id) &&
      typeof raw.created_on === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.created_on) &&
      Number.isFinite(Date.parse(raw.created_on)) &&
      new Date(raw.created_on).toISOString() ===
        (raw.created_on.includes(".") ? raw.created_on : raw.created_on.replace("Z", ".000Z")) &&
      Date.parse(raw.created_on) >= 0 &&
      Date.parse(raw.created_on) <= now * 1000 &&
      text(raw.source, 128) &&
      raw.source.length > 0 &&
      raw.strategy === "percentage" &&
      Array.isArray(raw.versions) &&
      raw.versions.length >= 1 &&
      raw.versions.length <= 2 &&
      (!Object.hasOwn(raw, "author_email") || text(raw.author_email, 320)),
  );
  if (Object.hasOwn(raw, "annotations")) {
    requireEvidence(keys(raw.annotations, "", "workers/message,workers/triggered_by"));
    for (const value of Object.values(raw.annotations)) requireEvidence(text(value, 512));
  }
  const ids = new Set();
  let total = 0;
  const versions = raw.versions.map((v) => {
    requireEvidence(
      keys(v, "version_id,percentage") &&
        uuid(v.version_id) &&
        !ids.has(v.version_id) &&
        typeof v.percentage === "number" &&
        Number.isFinite(v.percentage) &&
        v.percentage >= 0 &&
        v.percentage <= 100,
    );
    ids.add(v.version_id);
    total += v.percentage;
    return { versionId: v.version_id, percentage: v.percentage };
  });
  requireEvidence(total === 100);
  versions.sort((a, b) => a.versionId.localeCompare(b.versionId));
  // Author/annotation text is neither provenance nor selection authority. Do
  // not emit it; history identity joins only provider IDs/times/traffic/source.
  return {
    deploymentId: raw.id,
    createdAt: new Date(raw.created_on).toISOString(),
    source: raw.source,
    versions,
  };
}

function history(value, now) {
  requireEvidence(
    keys(value, "deployments") &&
      Array.isArray(value.deployments) &&
      value.deployments.length > 0 &&
      value.deployments.length <= 100,
  );
  const rows = value.deployments.map((row) => deployment(row, now));
  const ids = new Set();
  let previous = Infinity;
  for (const row of rows) {
    const created = Date.parse(row.createdAt);
    requireEvidence(!ids.has(row.deploymentId) && created <= previous);
    ids.add(row.deploymentId);
    previous = created;
  }
  requireEvidence(rows[0].versions.length === 1 && rows[0].versions[0].percentage === 100);
  return rows;
}

export function createCandidateServingReader({
  token,
  identity,
  profile,
  profileSha256,
  assertExclusive,
  requireDirty,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      [assertExclusive, requireDirty, fetchImpl, clock].every((fn) => typeof fn === "function") &&
      (signal === undefined || signal instanceof AbortSignal),
  );
  const installed = profileSnapshot(profile, profileSha256);
  const { q } = identitySnapshot(identity);
  const base = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/scripts/${installed.scriptName}`;

  function admitSnapshot(input, expectedSha256) {
    requireEvidence(typeof expectedSha256 === "string" && DIGEST.test(expectedSha256));
    const s = structuredClone(input);
    requireEvidence(
      keys(
        s,
        "schema,promotable,q,profileSha256,deploymentId,versionId,historySha256,observedAt",
      ) &&
        s.schema === "two.candidate-serving.v1" &&
        s.promotable === false &&
        s.q === q &&
        s.profileSha256 === profileSha256 &&
        uuid(s.deploymentId) &&
        uuid(s.versionId) &&
        typeof s.historySha256 === "string" &&
        DIGEST.test(s.historySha256) &&
        Number.isSafeInteger(s.observedAt) &&
        s.observedAt >= 0,
    );
    const canonical = receipt(s.deploymentId, s.versionId, s.historySha256, s.observedAt);
    requireEvidence(digest(canonical) === expectedSha256);
    return canonical;
  }

  function receipt(deploymentId, versionId, historySha256, observedAt) {
    return {
      schema: "two.candidate-serving.v1",
      promotable: false,
      q,
      profileSha256,
      deploymentId,
      versionId,
      historySha256,
      observedAt,
    };
  }

  async function observe(phase, snapshot, snapshotSha256, restoreDeploymentId, operationSignal) {
    try {
      const baseline = phase === "capture" ? null : admitSnapshot(snapshot, snapshotSha256);
      requireEvidence(
        (phase !== "restored" || uuid(restoreDeploymentId)) &&
          (operationSignal === undefined || operationSignal instanceof AbortSignal),
      );
      const deadline = AbortSignal.any([
        ...(signal ? [signal] : []),
        ...(operationSignal ? [operationSignal] : []),
        AbortSignal.timeout(60_000),
      ]);
      let lastNow = clock();
      function currentTime() {
        const time = clock();
        requireEvidence(
          Number.isSafeInteger(time) &&
            time >= 0 &&
            Number.isSafeInteger(lastNow) &&
            time >= lastNow &&
            (baseline === null || baseline.observedAt <= time),
        );
        deadline.throwIfAborted();
        lastNow = time;
        return time;
      }
      const context = freeze({ phase, q, profileSha256, snapshotSha256, restoreDeploymentId });
      async function guard() {
        currentTime();
        await assertExclusive(context, deadline);
        if (baseline) await requireDirty(context, deadline);
        currentTime();
      }
      async function get(path) {
        await guard();
        const url = `${base}/${path}`;
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
        });
        const value = await boundedResult(response, url);
        await guard();
        return value;
      }
      const before = history(await get("deployments"), currentTime());
      const active = before[0];
      const exact = deployment(await get(`deployments/${active.deploymentId}`), currentTime());
      requireEvidence(digest(exact) === digest(active));
      const after = history(await get("deployments"), currentTime());
      requireEvidence(digest(before) === digest(after));
      const historySha256 = digest(before);
      if (baseline) {
        requireEvidence(active.versions[0].versionId === baseline.versionId);
        if (phase === "unchanged") {
          requireEvidence(
            active.deploymentId === baseline.deploymentId &&
              historySha256 === baseline.historySha256,
          );
        } else {
          // The expected restore deployment comes from the installed controller,
          // never candidate output. Same-version traffic alone cannot satisfy it.
          requireEvidence(active.deploymentId === restoreDeploymentId);
        }
      }
      await guard();
      const observed = receipt(
        active.deploymentId,
        active.versions[0].versionId,
        historySha256,
        currentTime(),
      );
      return freeze({ snapshot: observed, snapshotSha256: digest(observed) });
    } catch {
      // No provider body, bearer, author/annotation or adapter exception escapes.
      // Failure never retries, mutates traffic or marks an occupancy record clean.
      throw new Error(ERROR);
    }
  }

  return Object.freeze({
    capture(operationSignal) {
      return observe("capture", null, null, null, operationSignal);
    },
    assertUnchanged(snapshot, snapshotSha256, operationSignal) {
      return observe("unchanged", snapshot, snapshotSha256, null, operationSignal);
    },
    assertRestored(snapshot, snapshotSha256, restoreDeploymentId, operationSignal) {
      return observe("restored", snapshot, snapshotSha256, restoreDeploymentId, operationSignal);
    },
  });
}
