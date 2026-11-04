// Trusted version creation and independent version readback, never activation.
// Exclusion, dirty occupancy and complete restorable B are controller prerequisites.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateAssetUploader } from "./candidate-staging-assets.mjs";
import {
  prepareCandidateAssetInput,
  prepareCandidateWebUpload,
} from "./candidate-staging-upload.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ETAG = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const MAX_RESPONSE = 64 * 1024;
const MAX_MODULE_BYTES = 16 * 1024 * 1024;
// Base64 plus bounded module paths/metadata for the admitted 16-MiB bundle.
const MAX_CONTENT_RESPONSE = 24 * 1024 * 1024;

function requireEvidence(condition) {
  if (!condition) throw new Error("Candidate version refused: transport");
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

async function boundedResult(response, url, limit = MAX_RESPONSE) {
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
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= limit),
    );
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= limit);
      chunks.push(Buffer.from(value));
    }
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

function bindingRecords(bindings) {
  requireEvidence(Array.isArray(bindings) && bindings.length <= 8);
  const names = new Set();
  const records = bindings.map((binding) => {
    requireEvidence(typeof binding?.name === "string" && !names.has(binding.name));
    names.add(binding.name);
    // Unknown types, extra fields and inherited secrets cannot hide in readback.
    if (binding.type === "plain_text") {
      requireEvidence(keys(binding, "name,type,text") && typeof binding.text === "string");
      return [binding.name, binding.type, binding.text];
    }
    if (binding.type === "hyperdrive") {
      requireEvidence(keys(binding, "name,type,id") && typeof binding.id === "string");
      return [binding.name, binding.type, binding.id];
    }
    requireEvidence(
      keys(binding, "name,type") && ["assets", "version_metadata"].includes(binding.type),
    );
    return [binding.name, binding.type];
  });
  return records.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function admitReadback(readback, uploaded, metadata) {
  requireEvidence(
    readback.id === uploaded.id &&
      readback.annotations?.["workers/tag"] === metadata.annotations["workers/tag"] &&
      keys(readback.resources, "script,script_runtime,bindings") &&
      readback.resources.script?.etag === uploaded.resources?.script?.etag,
  );
  const runtime = readback.resources.script_runtime;
  requireEvidence(
    keys(runtime, "compatibility_date,compatibility_flags") &&
      runtime.compatibility_date === metadata.compatibility_date &&
      JSON.stringify(runtime.compatibility_flags) === JSON.stringify(metadata.compatibility_flags),
  );
  const bindings = bindingRecords(readback.resources.bindings);
  requireEvidence(JSON.stringify(bindings) === JSON.stringify(bindingRecords(metadata.bindings)));
  return candidateSha256(
    JSON.stringify([readback.id, readback.resources.script.etag, runtime, bindings]),
  );
}

function admitContentVersion(value, versionId, metadata, entries) {
  // The immutable Workers API includes modules only with include=modules. Never
  // substitute script content/v2 (the current script) or the alias "latest".
  const allowed = new Set([
    "id",
    "number",
    "urls",
    "created_on",
    "author_email",
    "author_id",
    "source",
    "startup_time_ms",
    "annotations",
    "assets",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "containers",
    "exports",
    "main_module",
    "modules",
    "usage_model",
  ]);
  requireEvidence(
    Object.keys(value).every((name) => allowed.has(name)) &&
      value.id === versionId &&
      Number.isSafeInteger(value.number) &&
      value.number > 0 &&
      Array.isArray(value.urls) &&
      value.urls.length === 0 &&
      typeof value.created_on === "string" &&
      value.created_on.length <= 40 &&
      Number.isFinite(Date.parse(value.created_on)) &&
      value.main_module === metadata.main_module &&
      value.compatibility_date === metadata.compatibility_date &&
      JSON.stringify(value.compatibility_flags) === JSON.stringify(metadata.compatibility_flags) &&
      JSON.stringify(bindingRecords(value.bindings)) ===
        JSON.stringify(bindingRecords(metadata.bindings)),
  );
  for (const name of ["author_email", "author_id", "source"])
    requireEvidence(
      !(name in value) || (typeof value[name] === "string" && value[name].length <= 320),
    );
  requireEvidence(
    !("startup_time_ms" in value) ||
      (Number.isSafeInteger(value.startup_time_ms) && value.startup_time_ms >= 0),
  );
  requireEvidence(
    (keys(value.annotations, "workers/tag") ||
      (keys(value.annotations, "workers/tag,workers/triggered_by") &&
        value.annotations["workers/triggered_by"] === "upload")) &&
      value.annotations["workers/tag"] === metadata.annotations["workers/tag"] &&
      (!("usage_model" in value) || value.usage_model === "standard") &&
      (!("containers" in value) ||
        (Array.isArray(value.containers) && value.containers.length === 0)),
  );
  if ("exports" in value) {
    requireEvidence(
      keys(value.exports, "default") &&
        keys(value.exports.default, "type,cache") &&
        value.exports.default.type === "worker" &&
        keys(value.exports.default.cache, "enabled") &&
        value.exports.default.cache.enabled === false,
    );
  }
  if (metadata.assets) {
    requireEvidence(
      (keys(value.assets, "config") ||
        (keys(value.assets, "config,jwt") && value.assets.jwt === metadata.assets.jwt)) &&
        keys(value.assets.config, "run_worker_first") &&
        value.assets.config.run_worker_first === true,
    );
  } else {
    requireEvidence(!("assets" in value));
  }
  const expected = new Map(
    entries
      .filter((entry) => entry.path.startsWith("worker/"))
      .map((entry) => [entry.path, entry.bytes]),
  );
  requireEvidence(Array.isArray(value.modules) && value.modules.length === expected.size);
  const names = new Set();
  const records = [];
  let size = 0;
  for (const module of value.modules) {
    requireEvidence(
      keys(module, "name,content_type,content_base64") &&
        typeof module.name === "string" &&
        !names.has(module.name) &&
        module.content_type === "application/javascript+module" &&
        typeof module.content_base64 === "string" &&
        module.content_base64.length <= 4 * Math.ceil(MAX_MODULE_BYTES / 3),
    );
    names.add(module.name);
    const original = expected.get(module.name);
    requireEvidence(
      original && module.content_base64.length === 4 * Math.ceil(original.length / 3),
    );
    // Node's base64 decoder is permissive. The round-trip rejects ignored bytes,
    // alternate alphabets, missing padding and non-canonical pad bits.
    const bytes = Buffer.from(module.content_base64, "base64");
    size += bytes.length;
    requireEvidence(
      size <= MAX_MODULE_BYTES &&
        bytes.toString("base64") === module.content_base64 &&
        bytes.equals(original),
    );
    records.push([module.name, bytes.length, candidateSha256(bytes)]);
  }
  records.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return candidateSha256(
    JSON.stringify([
      versionId,
      value.main_module,
      records,
      bindingRecords(value.bindings),
      value.compatibility_date,
      value.compatibility_flags,
      metadata.assets ? { run_worker_first: true } : null,
    ]),
  );
}

export function createCandidateVersionUploader({
  token,
  profile,
  profileSha256,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      typeof fetchImpl === "function" &&
      typeof clock === "function",
  );
  // Profile and independent pin belong to installed trusted T, not invocation
  // arguments or candidate output. The upload method cannot override either.
  const installedProfile = structuredClone(profile);
  return Object.freeze({
    async upload(options) {
      try {
        requireEvidence(keys(options, "identity,bundle,verifier"));
        const now = clock();
        const admitted = prepareCandidateAssetInput({
          ...options,
          profile: installedProfile,
          profileSha256,
          now,
        });
        // Validate bounds before copying. Snapshot all caller-owned data before
        // the first await, so asset and module requests cannot see different H.
        const input = {
          identity: structuredClone(options.identity),
          bundle: {
            ...options.bundle,
            build: structuredClone(options.bundle.build),
            entries: options.bundle.entries.map((entry) => ({
              ...entry,
              bytes: Buffer.from(entry.bytes),
            })),
          },
          verifier: options.verifier,
          profile: installedProfile,
          profileSha256,
        };
        const deadline = AbortSignal.timeout(180_000);
        let lastNow = now;
        function currentTime() {
          const time = clock();
          requireEvidence(
            Number.isSafeInteger(time) && time >= lastNow && time < admitted.expiresAt - 30,
          );
          deadline.throwIfAborted();
          lastNow = time;
          return time;
        }
        const assetsTicket = await createCandidateAssetUploader({
          token,
          fetchImpl,
          clock: currentTime,
        }).upload(input);
        const request = prepareCandidateWebUpload({ ...input, assetsTicket, now: currentTime() });
        // Mutable FormData never escapes this closure and no prepared request
        // from a caller is accepted. The expected projection comes from it too.
        const metadata = JSON.parse(request.form.get("metadata"));
        async function send(url, method, body, limit = MAX_RESPONSE) {
          currentTime();
          const response = await fetchImpl(url, {
            method,
            headers: { Authorization: `Bearer ${token}` },
            ...(body ? { body } : {}),
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          });
          const result = await boundedResult(response, url, limit);
          currentTime();
          return result;
        }
        const uploaded = await send(request.url, "POST", request.form);
        requireEvidence(
          typeof uploaded.id === "string" &&
            UUID.test(uploaded.id) &&
            typeof uploaded.resources?.script?.etag === "string" &&
            ETAG.test(uploaded.resources.script.etag),
        );
        const readUrl = `${request.url.split("?", 1)[0]}/${uploaded.id}`;
        const readback = await send(readUrl, "GET");
        const readbackSha256 = admitReadback(readback, uploaded, metadata);
        const contentUrl = `https://api.cloudflare.com/client/v4/accounts/${admitted.accountId}/workers/workers/${admitted.scriptName}/versions/${uploaded.id}?include=modules`;
        const content = await send(contentUrl, "GET", undefined, MAX_CONTENT_RESPONSE);
        const contentSha256 = admitContentVersion(
          content,
          uploaded.id,
          metadata,
          input.bundle.entries,
        );
        currentTime();
        // No URL or activation authority. Immutable version bytes/config are
        // checked, not persistent Worker settings, stored assets or serving.
        return Object.freeze({
          ...request.proof,
          schema: "two.candidate-version-upload.v2",
          versionId: uploaded.id,
          etag: uploaded.resources.script.etag,
          readbackScope: "version-modules-bindings-runtime-and-asset-config",
          readbackSha256,
          contentSha256,
        });
      } catch {
        // Provider exceptions and bodies may contain secrets or asset tickets.
        throw new Error("Candidate version refused: transport");
      }
    },
  });
}
