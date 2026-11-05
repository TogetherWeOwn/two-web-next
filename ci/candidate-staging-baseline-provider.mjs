// Joins authenticated retained bytes to immutable staging code/config and serving.
// Stored assets, other components and dirty-journal admission remain separate.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateArtifactReader } from "./candidate-staging-artifact.mjs";
import {
  candidateBaselineBindingsSnapshot,
  prepareCandidateBaselineAssetInput,
} from "./candidate-staging-baseline-upload.mjs";
import { createCandidateServingReader } from "./candidate-staging-serving.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate baseline refused: provider-evidence";
const MAX_RESPONSE = 24 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

function keys(value, required, optional = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const names = required.split(",").filter(Boolean);
  const allowed = new Set([...names, ...optional.split(",").filter(Boolean)]);
  return (
    names.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).every((name) => allowed.has(name))
  );
}

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

function snapshot(read) {
  try {
    return read();
  } catch {
    throw new Error(ERROR);
  }
}

function freeze(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function readCandidateBaselineVersionResult(response, url) {
  requireEvidence(response.body);
  const reader = response.body.getReader();
  try {
    requireEvidence(
      response.status === 200 &&
        !response.redirected &&
        (response.url === "" || response.url === url) &&
        response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
          "application/json",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_RESPONSE),
    );
    let size = 0;
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= MAX_RESPONSE);
      chunks.push(Buffer.from(value));
    }
    requireEvidence(length === null || Number(length) === size);
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    requireEvidence(
      value?.success === true &&
        Array.isArray(value.errors) &&
        value.errors.length === 0 &&
        value.result !== null &&
        typeof value.result === "object" &&
        !Array.isArray(value.result),
    );
    return value.result;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

// Shared strict projection for original B and B-prime. This comparison is not
// stored-asset, baseline provenance, serving or recovery authority by itself.
export function candidateBaselineVersionSnapshot(
  value,
  retained,
  run,
  installed,
  profileSha256,
  now,
) {
  requireEvidence(
    keys(
      value,
      "id,number,created_on,main_module,modules,bindings,compatibility_date,compatibility_flags,placement,annotations",
      "assets,source,usage_model,urls,author_email,author_id,startup_time_ms,containers,exports",
    ) &&
      value.id === retained.manifest.versionId &&
      Number.isSafeInteger(value.number) &&
      value.number > 0 &&
      typeof value.created_on === "string" &&
      value.created_on.length <= 40 &&
      Number.isFinite(Date.parse(value.created_on)) &&
      Date.parse(value.created_on) >= 0 &&
      Math.floor(Date.parse(value.created_on) / 1000) <= now &&
      value.main_module === retained.manifest.mainModule &&
      value.compatibility_date === "2026-09-29" &&
      Array.isArray(value.compatibility_flags) &&
      value.compatibility_flags.length === 1 &&
      value.compatibility_flags[0] === "nodejs_compat" &&
      keys(value.placement, "mode,region") &&
      value.placement.mode === "targeted" &&
      value.placement.region === "aws:us-east-1" &&
      keys(value.annotations, "workers/tag", "workers/triggered_by") &&
      value.annotations["workers/tag"] === retained.manifest.producer.sourceSha &&
      (!("workers/triggered_by" in value.annotations) ||
        value.annotations["workers/triggered_by"] === "upload"),
  );
  for (const name of ["source", "author_email", "author_id"])
    requireEvidence(
      !(name in value) || (typeof value[name] === "string" && value[name].length <= 320),
    );
  requireEvidence(
    (!("urls" in value) || (Array.isArray(value.urls) && value.urls.length === 0)) &&
      (!("usage_model" in value) || value.usage_model === "standard") &&
      (!("startup_time_ms" in value) ||
        (Number.isSafeInteger(value.startup_time_ms) && value.startup_time_ms >= 0)) &&
      (!("containers" in value) ||
        (Array.isArray(value.containers) && value.containers.length === 0)),
  );
  if ("exports" in value)
    requireEvidence(
      keys(value.exports, "default") &&
        keys(value.exports.default, "type,cache") &&
        value.exports.default.type === "worker" &&
        keys(value.exports.default.cache, "enabled") &&
        value.exports.default.cache.enabled === false,
    );
  const expected = new Map(
    retained.files.filter((file) => file.kind === "module").map((file) => [file.path, file]),
  );
  requireEvidence(Array.isArray(value.modules) && value.modules.length === expected.size);
  const seen = new Set();
  let size = 0;
  for (const module of value.modules) {
    requireEvidence(
      keys(module, "name,content_type,content_base64") &&
        typeof module.name === "string" &&
        !seen.has(module.name),
    );
    seen.add(module.name);
    const original = expected.get(module.name);
    requireEvidence(
      original &&
        module.content_type === original.contentType &&
        typeof module.content_base64 === "string" &&
        module.content_base64.length === 4 * Math.ceil(original.bytes.length / 3),
    );
    const bytes = Buffer.from(module.content_base64, "base64");
    size += bytes.length;
    requireEvidence(
      size <= MAX_BYTES &&
        bytes.toString("base64") === module.content_base64 &&
        bytes.equals(original.bytes),
    );
  }
  const hasAssets = retained.files.some((file) => file.kind === "asset");
  requireEvidence(
    hasAssets
      ? keys(value.assets, "config") &&
          keys(value.assets.config, "run_worker_first") &&
          value.assets.config.run_worker_first === true
      : !("assets" in value),
  );
  requireEvidence(Array.isArray(value.bindings));
  // Staging resource IDs come from the installed profile, not observed provider
  // state. This comparison still does not prove those resources are synthetic.
  for (const binding of value.bindings) {
    if (binding?.type === "hyperdrive")
      requireEvidence(
        installed.bindings.some(
          (expected) =>
            expected.name === binding.name &&
            expected.type === "hyperdrive" &&
            expected.id === binding.id,
        ),
      );
  }
  for (const expected of installed.bindings)
    requireEvidence(
      value.bindings.some(
        (binding) =>
          binding?.name === expected.name &&
          binding.type === expected.type &&
          (expected.type === "hyperdrive"
            ? binding.id === expected.id
            : binding.text === expected.text),
      ),
    );
  const baseline = {
    schema: "two.candidate-baseline-web.v1",
    promotable: false,
    q: run.q,
    profileSha256,
    versionId: value.id,
    capturedAt: now,
    mainModule: value.main_module,
    compatibilityDate: value.compatibility_date,
    compatibilityFlags: ["nodejs_compat"],
    placement: { mode: "targeted", region: "aws:us-east-1" },
    annotations: { "workers/tag": value.annotations["workers/tag"] },
    assets: hasAssets ? { run_worker_first: true } : null,
    bindings: candidateBaselineBindingsSnapshot(value.bindings),
    files: retained.files
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        contentType: file.contentType,
        size: file.bytes.length,
        sha256: candidateSha256(file.bytes),
      }))
      .sort((a, b) => {
        const x = `${a.kind}:${a.path}`;
        const y = `${b.kind}:${b.path}`;
        return x < y ? -1 : x > y ? 1 : 0;
      }),
  };
  return baseline;
}

export function createCandidateBaselineProviderReader({
  token,
  githubToken,
  identity,
  profile,
  profileSha256,
  installedContract,
  sourceManifestBytes,
  assertExclusive,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      [assertExclusive, fetchImpl, clock].every((fn) => typeof fn === "function") &&
      (signal === undefined || signal instanceof AbortSignal) &&
      Buffer.isBuffer(sourceManifestBytes) &&
      sourceManifestBytes.length > 0 &&
      sourceManifestBytes.length <= 64 * 1024,
  );
  const { run, installed, fixedIdentity, fixedProfile, contract, sources, artifacts } = snapshot(
    () => ({
      run: identitySnapshot(identity),
      installed: profileSnapshot(profile, profileSha256),
      fixedIdentity: structuredClone(identity),
      fixedProfile: structuredClone(profile),
      contract: structuredClone(installedContract),
      sources: Buffer.from(sourceManifestBytes),
      artifacts: createCandidateArtifactReader({ token: githubToken, fetchImpl }),
    }),
  );
  return Object.freeze({
    async observe(selection, { signal: operationSignal } = {}) {
      try {
        const selected = structuredClone(selection);
        requireEvidence(operationSignal === undefined || operationSignal instanceof AbortSignal);
        const deadline = AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(operationSignal ? [operationSignal] : []),
          AbortSignal.timeout(180_000),
        ]);
        let lastNow = clock();
        function currentTime() {
          const time = clock();
          requireEvidence(
            Number.isSafeInteger(time) &&
              time >= 0 &&
              time <= 253402300799 &&
              Number.isSafeInteger(lastNow) &&
              lastNow >= 0 &&
              lastNow <= 253402300799 &&
              time >= lastNow,
          );
          deadline.throwIfAborted();
          lastNow = time;
          return time;
        }
        currentTime();
        const context = Object.freeze({ phase: "baseline-provider", q: run.q, profileSha256 });
        async function guard() {
          currentTime();
          await assertExclusive(context, deadline);
          currentTime();
        }
        await guard();
        const retained = await artifacts.readBaseline(fixedIdentity, contract, selected, sources, {
          signal: deadline,
        });
        await guard();
        const serving = createCandidateServingReader({
          token,
          identity: fixedIdentity,
          profile: fixedProfile,
          profileSha256,
          assertExclusive,
          requireDirty: async () => {
            throw new Error(ERROR);
          },
          signal: deadline,
          fetchImpl,
          clock: currentTime,
        });
        const before = await serving.capture();
        requireEvidence(before.snapshot.versionId === retained.manifest.versionId);
        await guard();
        const url = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/workers/${installed.scriptName}/versions/${retained.manifest.versionId}?include=modules`;
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
        });
        const content = await readCandidateBaselineVersionResult(response, url);
        await guard();
        const baseline = candidateBaselineVersionSnapshot(
          content,
          retained,
          run,
          installed,
          profileSha256,
          currentTime(),
        );
        const baselineSha256 = digest(baseline);
        const files = retained.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          bytes: Buffer.from(file.bytes),
        }));
        // Use the recovery constructor's strict canonical binding/file contract,
        // not a parallel permissive approximation of it.
        prepareCandidateBaselineAssetInput({
          identity: fixedIdentity,
          profile: fixedProfile,
          profileSha256,
          baseline,
          baselineSha256,
          files,
          now: currentTime(),
        });
        const after = await serving.capture();
        requireEvidence(
          before.snapshot.deploymentId === after.snapshot.deploymentId &&
            before.snapshot.versionId === after.snapshot.versionId &&
            before.snapshot.historySha256 === after.snapshot.historySha256,
        );
        await guard();
        return freeze({
          schema: "two.candidate-baseline-provider.v1",
          promotable: false,
          scope: "immutable-code-config-and-serving-only",
          q: run.q,
          profileSha256,
          provenance: retained.observation,
          baseline,
          baselineSha256,
          files,
          serving: after.snapshot,
          servingSha256: after.snapshotSha256,
          observedAt: currentTime(),
        });
      } catch {
        // Neither provider bindings/modules nor artifact capabilities enter errors.
        throw new Error(ERROR);
      }
    },
  });
}
