// Durable dirty-before-mutation journal, not a lock or a deployment capability.
// Installed callers must hold the shared staging exclusion throughout recovery.
import { candidateSha256, identitySnapshot } from "./candidate-staging-admission.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const ENVIRONMENT = "candidate-staging-occupancy";
const TASK = "candidate-staging-occupancy-v1";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function requireEvidence(condition, code) {
  if (!condition) throw new Error(`Candidate occupancy refused: ${code}`);
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

function time(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function apiId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function baseline(value) {
  requireEvidence(
    keys(value, "artifactId,archiveSha256,stateSha256,expiresAt") &&
      matches(ID, value.artifactId) &&
      matches(DIGEST, value.archiveSha256) &&
      matches(DIGEST, value.stateSha256) &&
      time(value.expiresAt),
    "baseline",
  );
}

function payload(value) {
  requireEvidence(
    keys(value, "schema,q,controllerSha,headSha,runId,runAttempt,createdAt,baseline") &&
      value.schema === "two.candidate-occupancy.v1" &&
      matches(DIGEST, value.q) &&
      matches(SHA, value.controllerSha) &&
      matches(SHA, value.headSha) &&
      matches(ID, value.runId) &&
      matches(ID, value.runAttempt) &&
      time(value.createdAt),
    "payload",
  );
  baseline(value.baseline);
}

function payloadKey(value) {
  return JSON.stringify([
    value.schema,
    value.q,
    value.controllerSha,
    value.headSha,
    value.runId,
    value.runAttempt,
    value.createdAt,
    value.baseline.artifactId,
    value.baseline.archiveSha256,
    value.baseline.stateSha256,
    value.baseline.expiresAt,
  ]);
}

function restoredProof(value, record) {
  requireEvidence(
    keys(
      value,
      "schema,q,deploymentId,baselineStateSha256,providerStateSha256,smokeSha256,nextUploadSha256,verifiedAt",
    ) &&
      value.schema === "two.candidate-restoration.v1" &&
      value.q === record.payload.q &&
      value.deploymentId === String(record.id) &&
      value.baselineStateSha256 === record.payload.baseline.stateSha256 &&
      value.providerStateSha256 === value.baselineStateSha256 &&
      matches(DIGEST, value.smokeSha256) &&
      matches(DIGEST, value.nextUploadSha256) &&
      time(value.verifiedAt),
    "restoration-proof",
  );
  return candidateSha256(
    JSON.stringify([
      value.schema,
      value.q,
      value.deploymentId,
      value.baselineStateSha256,
      value.providerStateSha256,
      value.smokeSha256,
      value.nextUploadSha256,
      value.verifiedAt,
    ]),
  );
}

async function boundedJson(response, status) {
  requireEvidence(response.body, "http-body");
  const reader = response.body.getReader();
  try {
    requireEvidence(response.status === status && !response.redirected, "http-status");
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    requireEvidence(
      ["application/json", "application/vnd.github+json"].includes(type),
      "http-type",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_RESPONSE),
      "http-length",
    );
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= MAX_RESPONSE, "http-size");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function createCandidateStagingJournal({
  token,
  creatorId,
  appId,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token),
    "token",
  );
  requireEvidence(matches(ID, creatorId) && matches(ID, appId), "writer-identity");

  function writer(row) {
    return (
      apiId(row?.creator?.id) &&
      String(row.creator.id) === creatorId &&
      apiId(row.performed_via_github_app?.id) &&
      String(row.performed_via_github_app.id) === appId
    );
  }

  async function request(signal, path, method = "GET", body) {
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      // Do not retry writes: a lost response can still have committed a dirty
      // record. A subsequent run discovers it through the complete listing.
      return await boundedJson(response, method === "GET" ? 200 : 201);
    } catch {
      throw new Error("Candidate occupancy refused: request-evidence");
    }
  }

  function record(row) {
    requireEvidence(
      apiId(row?.id) &&
        writer(row) &&
        row.environment === ENVIRONMENT &&
        row.task === TASK &&
        row.transient_environment === false &&
        row.production_environment === false &&
        row.ref === row.sha,
      "deployment-record",
    );
    payload(row.payload);
    requireEvidence(row.sha === row.payload.controllerSha, "deployment-controller");
    return structuredClone(row);
  }

  async function read(id, signal = AbortSignal.timeout(60_000)) {
    requireEvidence(matches(ID, id), "deployment-id");
    const row = record(await request(signal, `/deployments/${id}`));
    requireEvidence(String(row.id) === id, "deployment-id-mismatch");
    return row;
  }

  async function arrayPages(path, query, signal) {
    const rows = [];
    // These endpoints have no total_count. Require a terminal short/empty page,
    // including a sixth sentinel after exactly 500 rows; never follow links.
    for (let page = 1; page <= 6; page++) {
      const params = new URLSearchParams({ ...query, per_page: "100", page: String(page) });
      const result = await request(signal, `${path}?${params}`);
      requireEvidence(
        Array.isArray(result) && result.length <= 100 && rows.length + result.length <= 500,
        "array-list",
      );
      rows.push(...result);
      if (result.length < 100) {
        requireEvidence(
          new Set(rows.map((row) => row?.id)).size === rows.length,
          "array-duplicates",
        );
        return rows;
      }
    }
    throw new Error("Candidate occupancy refused: array-pages");
  }

  async function clean(row, signal, expected) {
    const statuses = await arrayPages(`/deployments/${row.id}/statuses`, {}, signal);
    let previous = Infinity;
    for (const status of statuses) {
      requireEvidence(
        apiId(status?.id) &&
          status.id < previous &&
          writer(status) &&
          ["error", "failure", "inactive", "in_progress", "queued", "pending", "success"].includes(
            status.state,
          ) &&
          status.environment === ENVIRONMENT,
        "status-record",
      );
      previous = status.id;
    }
    if (statuses.length === 0) return false;
    const latest = statuses[0];
    if (latest.state !== "success") return false;
    requireEvidence(
      typeof latest.description === "string" &&
        /^two\.restore\.v1:[a-f0-9]{64}$/.test(latest.description),
      "clean-receipt",
    );
    requireEvidence(
      !expected || (latest.id === expected.id && latest.description === expected.description),
      "status-replaced",
    );
    return true;
  }

  async function inspect(signal) {
    const rows = (await arrayPages("/deployments", { environment: ENVIRONMENT }, signal)).map(
      record,
    );
    const dirty = [];
    for (const row of rows) {
      if (!(await clean(row, signal))) dirty.push(row);
    }
    return { rows, dirty };
  }

  async function unresolved(signal) {
    const deadline = AbortSignal.timeout(60_000);
    return (await inspect(signal ? AbortSignal.any([signal, deadline]) : deadline)).dirty;
  }

  async function requireDirty(id, signal = AbortSignal.timeout(60_000)) {
    requireEvidence(matches(ID, id), "deployment-id");
    const dirty = await unresolved(signal);
    requireEvidence(dirty.length === 1 && String(dirty[0].id) === id, "recovery-ownership");
    return dirty[0];
  }

  function clock() {
    const value = now();
    requireEvidence(Number.isSafeInteger(value) && value >= 0, "clock");
    return value;
  }

  return Object.freeze({
    async assertClear() {
      requireEvidence((await unresolved()).length === 0, "dirty-occupancy");
    },
    unresolved,
    read,
    requireDirty,
    bindRecovery({ deploymentId, identity, expectedPayload } = {}) {
      try {
        requireEvidence(matches(ID, deploymentId), "deployment-id");
        const run = identitySnapshot(identity);
        const expected = structuredClone(expectedPayload);
        payload(expected);
        requireEvidence(
          expected.q === run.q &&
            expected.headSha === run.descriptor[4] &&
            expected.controllerSha === run.descriptor[5] &&
            expected.runId === run.descriptor[7] &&
            expected.runAttempt === run.descriptor[8],
          "bound-identity",
        );
        const expectedKey = payloadKey(expected);
        // The trusted controller supplies the independently retained payload,
        // never one learned from the row this adapter is supposed to verify.
        // This binds ownership only; baseline contents still need admission.
        return async (context, signal) => {
          try {
            requireEvidence(
              context?.q === run.q && (signal === undefined || signal instanceof AbortSignal),
              "bound-context",
            );
            const deadline = AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(60_000),
            ]);
            deadline.throwIfAborted();
            const row = await requireDirty(deploymentId, deadline);
            requireEvidence(payloadKey(row.payload) === expectedKey, "bound-payload");
            deadline.throwIfAborted();
            return Object.freeze({
              schema: "two.candidate-occupancy-owner.v1",
              promotable: false,
              scope: "dirty-journal-ownership-only",
              q: run.q,
              deploymentId,
              payloadSha256: candidateSha256(expectedKey),
            });
          } catch {
            throw new Error("Candidate occupancy refused: bound-ownership");
          }
        };
      } catch {
        throw new Error("Candidate occupancy refused: bound-ownership");
      }
    },
    async begin(input) {
      const signal = AbortSignal.timeout(60_000);
      const value = structuredClone(input);
      payload(value);
      const started = clock();
      requireEvidence(Math.abs(started - Date.parse(value.createdAt)) <= 10_000, "creation-time");
      requireEvidence(
        Date.parse(value.baseline.expiresAt) - started >= RETENTION_MS,
        "baseline-retention",
      );
      const prior = await inspect(signal);
      requireEvidence(prior.dirty.length === 0, "dirty-occupancy");
      requireEvidence(prior.rows.length < 500, "journal-capacity");
      requireEvidence(!prior.rows.some((row) => row.payload.q === value.q), "session-replay");
      const body = {
        ref: value.controllerSha,
        task: TASK,
        environment: ENVIRONMENT,
        auto_merge: false,
        required_contexts: [],
        transient_environment: false,
        production_environment: false,
        payload: value,
      };
      const created = record(await request(signal, "/deployments", "POST", body));
      requireEvidence(payloadKey(created.payload) === payloadKey(value), "created-payload");
      const persisted = await read(String(created.id), signal);
      requireEvidence(payloadKey(persisted.payload) === payloadKey(value), "persisted-payload");
      const dirty = await unresolved(signal);
      requireEvidence(dirty.length === 1 && dirty[0].id === created.id, "occupancy-race");
      return persisted;
    },
    async markRestored(id, proof) {
      const signal = AbortSignal.timeout(60_000);
      const row = await requireDirty(id, signal);
      const value = structuredClone(proof);
      const digest = restoredProof(value, row);
      requireEvidence(
        Date.parse(value.verifiedAt) >= Date.parse(row.payload.createdAt) &&
          Math.abs(clock() - Date.parse(value.verifiedAt)) <= 10_000,
        "verification-time",
      );
      const status = await request(signal, `/deployments/${id}/statuses`, "POST", {
        state: "success",
        environment: ENVIRONMENT,
        description: `two.restore.v1:${digest}`,
        auto_inactive: false,
      });
      requireEvidence(
        apiId(status?.id) &&
          writer(status) &&
          status.state === "success" &&
          status.description === `two.restore.v1:${digest}` &&
          status.environment === ENVIRONMENT,
        "status-write",
      );
      requireEvidence(await clean(row, signal, status), "status-readback");
      requireEvidence((await unresolved(signal)).length === 0, "restoration-race");
      return digest;
    },
  });
}

// Dependencies are trusted installed adapters, not candidate callbacks. Restore
// is intentionally idempotent; a retry always restores and re-verifies B before
// publishing clean. An exception anywhere leaves the durable record unresolved.
export async function recoverCandidateStaging({
  journal,
  deploymentId,
  assertExclusive,
  restore,
  verify,
}) {
  requireEvidence(
    matches(ID, deploymentId) &&
      typeof assertExclusive === "function" &&
      typeof restore === "function" &&
      typeof verify === "function",
    "recovery-adapters",
  );
  try {
    await assertExclusive();
    const row = await journal.requireDirty(deploymentId);
    await restore(structuredClone(row));
    await assertExclusive();
    const proof = await verify(structuredClone(row));
    restoredProof(proof, row);
    await assertExclusive();
    return await journal.markRestored(deploymentId, proof);
  } catch {
    // Provider/adapter errors may contain bindings or response bodies.
    throw new Error("Candidate occupancy refused: recovery");
  }
}
