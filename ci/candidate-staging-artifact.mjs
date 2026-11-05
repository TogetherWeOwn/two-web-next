// Installed controller code only. The archive and decoded modules stay inert;
// the signed download URL is never returned, logged, cached or given a bearer.
import {
  admitCandidateBundle,
  candidateIdentity,
  candidateSha256,
  safeBundlePath,
} from "./candidate-staging-admission.mjs";
import { decodeBaselineArchive, decodeCandidateArchive } from "./candidate-staging-archive.mjs";
import { baselineProducerRecord } from "./candidate-staging-baseline-retain.mjs";
import { createCandidateGitHubReader } from "./candidate-staging-github.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const MAX_ARCHIVE = 16 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;

function requireEvidence(condition, code) {
  if (!condition) throw new Error(`Candidate artifact refused: ${code}`);
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function snapshotIdentity(input) {
  const value = structuredClone(input);
  requireEvidence(
    keys(value, "descriptor,q,ciRunId,ciRunAttempt") &&
      Array.isArray(value.descriptor) &&
      value.descriptor.length === 12,
    "identity",
  );
  const d = value.descriptor;
  const expected = candidateIdentity(
    { prNumber: d[3], headSha: d[4], ciRunId: value.ciRunId, ciRunAttempt: value.ciRunAttempt },
    {
      repositoryId: d[1],
      repository: d[2],
      controllerSha: d[5],
      launcherSha: d[6],
      checkoutSha: d[5],
      runId: d[7],
      runAttempt: d[8],
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
  requireEvidence(
    JSON.stringify(d) === JSON.stringify(expected.descriptor) && value.q === expected.q,
    "identity-descriptor",
  );
  return expected;
}

function snapshotBuild(input) {
  const value = structuredClone(input);
  requireEvidence(
    keys(value, "runId,runAttempt,artifactId,archiveSha256") &&
      matches(ID, value.runId) &&
      matches(ID, value.runAttempt) &&
      matches(ID, value.artifactId) &&
      matches(DIGEST, value.archiveSha256),
    "build-selection",
  );
  return value;
}

function snapshotProducer(input, identity, build) {
  const value = structuredClone(input);
  requireEvidence(
    keys(
      value,
      "schema,q,ciRunId,ciRunAttempt,buildRunId,buildRunAttempt,artifactId,archiveSha256,files,rootSha256",
    ) &&
      value.schema === "two.candidate-build.v1" &&
      value.q === identity.q &&
      value.ciRunId === identity.ciRunId &&
      value.ciRunAttempt === identity.ciRunAttempt &&
      value.buildRunId === build.runId &&
      value.buildRunAttempt === build.runAttempt &&
      value.artifactId === build.artifactId &&
      value.archiveSha256 === build.archiveSha256 &&
      matches(DIGEST, value.rootSha256) &&
      Array.isArray(value.files) &&
      value.files.length > 0 &&
      value.files.length <= 4096 &&
      Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024,
    "producer",
  );
  return value;
}

function signedLocation(raw) {
  requireEvidence(typeof raw === "string" && raw.length > 0 && raw.length <= 8192, "location");
  const url = new URL(raw);
  requireEvidence(
    url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      // Only the documented GitHub artifact storage origins, never arbitrary
      // Azure tenants, localhost, an API-provided next link or another redirect.
      (/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
        url.hostname === "pipelines.actions.githubusercontent.com"),
    "location-origin",
  );
  return url.href;
}

async function closeResponse(response) {
  if (response.body) await response.body.cancel();
}

async function archiveBytes(response) {
  requireEvidence(response.body, "archive-body");
  const reader = response.body.getReader();
  try {
    requireEvidence(response.status === 200 && !response.redirected, "archive-status");
    const media = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    requireEvidence(
      ["application/zip", "application/octet-stream"].includes(media),
      "archive-type",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^[1-9][0-9]*$/.test(length) && Number(length) <= MAX_ARCHIVE),
      "archive-length",
    );
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= MAX_ARCHIVE, "archive-size");
      chunks.push(Buffer.from(value));
    }
    requireEvidence(size > 0 && (length === null || size === Number(length)), "archive-truncated");
    return Buffer.concat(chunks);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function baselineBytes(identity, contract, selected, payload, recordEntries) {
  requireEvidence(recordEntries.length === 1, "baseline-producer-entries");
  const producerBytes = recordEntries[0].bytes;
  const manifestBytes = payload.find((file) => file.path === "baseline.json")?.bytes;
  requireEvidence(
    producerBytes.length <= 16384 &&
      manifestBytes?.length > 0 &&
      manifestBytes.length <= 1024 * 1024,
    "baseline-manifest-size",
  );
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  requireEvidence(
    keys(manifest, "schema,promotable,scope,producer,versionId,mainModule,files,rootSha256") &&
      manifest.schema === "two.staging-baseline-retention.v1" &&
      manifest.promotable === false &&
      manifest.scope === "retained-bytes-only" &&
      manifest.versionId === selected.versionId &&
      manifest.mainModule === "_worker.js" &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length < 4096 &&
      manifest.files.length + 1 === payload.length &&
      matches(DIGEST, manifest.rootSha256) &&
      candidateSha256(JSON.stringify(manifest.files)) === manifest.rootSha256,
    "baseline-manifest",
  );
  const source = manifest.producer;
  requireEvidence(
    keys(source, "repository,repositoryId,sourceSha,workflowSha,runId,runAttempt,event") &&
      source.repository === identity.descriptor[2] &&
      source.repositoryId === identity.descriptor[1] &&
      source.sourceSha === identity.descriptor[5] &&
      source.workflowSha === identity.descriptor[5] &&
      source.runId === selected.runId &&
      source.runAttempt === "1" &&
      source.event === contract.event,
    "baseline-source",
  );
  const entries = new Map(payload.map((file) => [file.path, file.bytes]));
  const names = new Set();
  const files = [];
  let previous = "";
  for (const [index, file] of manifest.files.entries()) {
    requireEvidence(
      keys(file, "kind,path,contentType,size,sha256,entry") &&
        typeof file.path === "string" &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        matches(DIGEST, file.sha256) &&
        file.entry === `file-${String(index).padStart(4, "0")}` &&
        (file.kind === "module"
          ? (file.path === "_worker.js" && file.contentType === "application/javascript+module") ||
            (file.path === "_worker.js.map" && file.contentType === "application/source-map")
          : file.kind === "asset" &&
            file.contentType === null &&
            safeBundlePath(`assets/${file.path}`)),
      "baseline-file",
    );
    const key = `${file.kind}:${file.path}`;
    requireEvidence(key > previous && !names.has(key.toLowerCase()), "baseline-file-order");
    previous = key;
    names.add(key.toLowerCase());
    const bytes = entries.get(file.entry);
    requireEvidence(
      Buffer.isBuffer(bytes) &&
        bytes.length === file.size &&
        candidateSha256(bytes) === file.sha256,
      "baseline-file-digest",
    );
    files.push(
      Object.freeze({
        kind: file.kind,
        path: file.path,
        contentType: file.contentType,
        bytes: Buffer.from(bytes),
      }),
    );
    Object.freeze(file);
  }
  requireEvidence(names.has("module:_worker.js"), "baseline-main-module");
  const producer = baselineProducerRecord({
    manifestBytes,
    artifactId: selected.artifactId,
    archiveSha256: selected.archiveSha256,
  });
  // The trusted producer emits one canonical JSON record on its separate channel.
  // Do not accept an archive-local producer claim or a self-consistent wrong join.
  requireEvidence(
    producerBytes.equals(Buffer.from(JSON.stringify(producer))),
    "baseline-producer-join",
  );
  Object.freeze(manifest.producer);
  Object.freeze(manifest.files);
  Object.freeze(manifest);
  Object.freeze(producer.producer);
  return { manifest, producer, files: Object.freeze(files) };
}

export function createCandidateArtifactReader({ token, fetchImpl = fetch } = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token),
    "read-token",
  );
  async function download(build, request) {
    const redirect = await request(`${BASE}/actions/artifacts/${build.artifactId}/zip`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    let location;
    try {
      requireEvidence(redirect.status === 302 && !redirect.redirected, "download-redirect");
      location = signedLocation(redirect.headers.get("location"));
    } finally {
      await closeResponse(redirect);
    }
    // Never forward the API bearer to signed storage, including across redirects.
    const response = await request(location, {
      method: "GET",
      headers: { Accept: "application/zip, application/octet-stream" },
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    const archive = await archiveBytes(response);
    requireEvidence(candidateSha256(archive) === build.archiveSha256, "archive-digest");
    return archive;
  }
  return Object.freeze({
    // `producer` is obtained separately from installed trusted build tooling,
    // never from this archive. This joins evidence; it does not establish that
    // producer's trust, CI completion, sandboxing or build-attempt freshness.
    async readBundle(input, selectedBuild, trustedProducer, { signal } = {}) {
      try {
        const identity = snapshotIdentity(input);
        const build = snapshotBuild(selectedBuild);
        const producer = snapshotProducer(trustedProducer, identity, build);
        const deadline = AbortSignal.timeout(60_000);
        const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
        async function request(url, init) {
          operation.throwIfAborted();
          return fetchImpl(url, {
            ...init,
            signal: AbortSignal.any([operation, init.signal ?? AbortSignal.timeout(10_000)]),
          });
        }
        const github = createCandidateGitHubReader({ token, fetchImpl: request });
        await github.verifyPullRequest(identity);
        const artifact = await github.readArtifact(identity, build);
        const archive = await download(build, request);
        const files = decodeCandidateArchive(archive, build.archiveSha256);
        const bundle = admitCandidateBundle(identity, build, artifact, producer, files);
        // Neither a signed URL nor an earlier metadata read is a lease. Fail if
        // the artifact disappears/expires or the selected live head moves.
        await github.readArtifact(identity, build);
        await github.verifyPullRequest(identity);
        operation.throwIfAborted();
        return Object.freeze({
          q: identity.q,
          build: Object.freeze(build),
          ...bundle,
          entries: files,
        });
      } catch {
        // Fetch, stream and parser diagnostics can contain a SAS, token or code.
        throw new Error("Candidate artifact refused: evidence");
      }
    },

    // Retained-byte authority only. Provider/config/serving/asset admission and
    // installed exclusion/journal ownership are still mandatory before mutation.
    async readBaseline(input, installedContract, selected, sourceManifestBytes, { signal } = {}) {
      try {
        const identity = snapshotIdentity(input);
        const contract = structuredClone(installedContract);
        const selection = structuredClone(selected);
        const sources = Buffer.isBuffer(sourceManifestBytes)
          ? Buffer.from(sourceManifestBytes)
          : null;
        requireEvidence(
          keys(
            selection,
            "runId,runAttempt,artifactId,archiveSha256,versionId,producerArtifactId,producerArchiveSha256",
          ),
          "baseline-selection",
        );
        const deadline = AbortSignal.timeout(60_000);
        const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
        async function request(url, init) {
          operation.throwIfAborted();
          return fetchImpl(url, {
            ...init,
            signal: AbortSignal.any([operation, init.signal ?? AbortSignal.timeout(10_000)]),
          });
        }
        const github = createCandidateGitHubReader({ token, fetchImpl: request });
        const observation = await github.readBaselineArtifact(
          identity,
          contract,
          selection,
          sources,
        );
        const recordArchive = await download(
          {
            artifactId: selection.producerArtifactId,
            archiveSha256: selection.producerArchiveSha256,
          },
          request,
        );
        const recordEntries = decodeBaselineArchive(
          recordArchive,
          selection.producerArchiveSha256,
          "producer",
        );
        const archive = await download(selection, request);
        const payload = decodeBaselineArchive(archive, selection.archiveSha256, "payload");
        const retained = baselineBytes(identity, contract, selection, payload, recordEntries);
        await github.readBaselineArtifact(identity, contract, selection, sources);
        operation.throwIfAborted();
        return Object.freeze({
          schema: "two.candidate-baseline-bytes.v1",
          promotable: false,
          scope: "authenticated-retained-bytes-only",
          q: identity.q,
          observation,
          ...retained,
        });
      } catch {
        throw new Error("Candidate artifact refused: baseline-evidence");
      }
    },
  });
}
