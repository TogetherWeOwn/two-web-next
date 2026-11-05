// Read-only controller transport. Candidate source is returned as inert bytes;
// this module never installs it, imports it, or follows API-provided URLs.
import { createHash } from "node:crypto";
import {
  admitCandidateCi,
  admitCandidatePullRequest,
  candidateIdentity,
  candidateSha256,
  completeCandidatePages,
} from "./candidate-staging-admission.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INTEGER = /^[1-9][0-9]{0,19}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_SOURCE = 512 * 1024;
const MAX_SOURCES = 4 * 1024 * 1024;

function requireEvidence(condition, code) {
  if (!condition) throw new Error(`Candidate GitHub refused: ${code}`);
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

function apiInteger(value, expected) {
  return Number.isSafeInteger(value) && value > 0 && String(value) === expected;
}

function safeSourcePath(value) {
  return (
    typeof value === "string" &&
    value.length <= 240 &&
    /^[A-Za-z0-9_.\/-]+$/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function snapshotIdentity(identity) {
  const copy = structuredClone(identity);
  requireEvidence(
    Array.isArray(copy?.descriptor) &&
      copy.descriptor.length === 12 &&
      copy.descriptor.every((value) => typeof value === "string") &&
      matches(DIGEST, copy.q) &&
      candidateSha256(JSON.stringify(copy.descriptor)) === copy.q &&
      matches(INTEGER, copy.descriptor[1]) &&
      copy.descriptor[2] === "TogetherWeOwn/two-web-next" &&
      matches(INTEGER, copy.descriptor[3]) &&
      matches(SHA, copy.descriptor[4]) &&
      matches(SHA, copy.descriptor[5]) &&
      matches(INTEGER, copy.ciRunId) &&
      matches(INTEGER, copy.ciRunAttempt),
    "identity",
  );
  const expected = candidateIdentity(
    {
      prNumber: copy.descriptor[3],
      headSha: copy.descriptor[4],
      ciRunId: copy.ciRunId,
      ciRunAttempt: copy.ciRunAttempt,
    },
    {
      repositoryId: copy.descriptor[1],
      repository: copy.descriptor[2],
      controllerSha: copy.descriptor[5],
      launcherSha: copy.descriptor[6],
      checkoutSha: copy.descriptor[5],
      runId: copy.descriptor[7],
      runAttempt: copy.descriptor[8],
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
  requireEvidence(
    JSON.stringify(expected.descriptor) === JSON.stringify(copy.descriptor),
    "identity-descriptor",
  );
  return copy;
}

async function boundedJson(response) {
  requireEvidence(response.body, "http-body");
  const reader = response.body.getReader();
  try {
    requireEvidence(response.status === 200 && !response.redirected, "http-status");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    requireEvidence(
      mediaType === "application/json" || mediaType === "application/vnd.github+json",
      "http-content-type",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_RESPONSE),
      "http-length",
    );
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= MAX_RESPONSE, "http-size");
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text);
  } finally {
    // Also cancel on an over-limit or failed read; never leave a live response.
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function createCandidateGitHubReader({ token, fetchImpl = fetch } = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token),
    "read-token",
  );
  async function get(path) {
    // All callers construct repository-local paths from strictly typed IDs or
    // encoded installed paths. There is no public arbitrary-URL request method.
    try {
      const response = await fetchImpl(`${BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      return await boundedJson(response);
    } catch {
      // API/network/parser messages may contain URLs, source or credentials.
      throw new Error("Candidate GitHub refused: request-evidence");
    }
  }

  async function pages(path, field, query = {}) {
    const output = [];
    let count = 1;
    for (let page = 1; page <= count; page++) {
      const params = new URLSearchParams({ ...query, per_page: "100", page: String(page) });
      const result = await get(`${path}?${params}`);
      requireEvidence(
        Number.isSafeInteger(result?.total_count) &&
          result.total_count >= 0 &&
          result.total_count <= 500,
        "page-count",
      );
      if (page === 1) count = Math.max(1, Math.ceil(result.total_count / 100));
      output.push({ ...result, page });
    }
    return completeCandidatePages(output, field);
  }

  async function pull(identity) {
    const repository = await get("");
    const request = await get(`/pulls/${identity.descriptor[3]}`);
    admitCandidatePullRequest(identity, repository, request);
    return { repository, pull: request };
  }

  const reader = Object.freeze({
    async verifyPullRequest(input) {
      return pull(snapshotIdentity(input));
    },

    // This must be an installed, independently verified contract, not one parsed
    // from candidate workflow source. A second listing closes the newer-run race
    // during job retrieval; the selected attempt is read explicitly, not latest.
    async verifyCi(input, installedContract) {
      const identity = snapshotIdentity(input);
      const contract = structuredClone(installedContract);
      requireEvidence(matches(INTEGER, contract?.workflowId), "workflow-id");
      await pull(identity);
      const runPath = `/actions/runs/${identity.ciRunId}`;
      const listPath = `/actions/workflows/${contract.workflowId}/runs`;
      const query = { head_sha: identity.descriptor[4] };
      const runs = await pages(listPath, "workflow_runs", query);
      const before = await get(runPath);
      const attempt = await get(`${runPath}/attempts/${identity.ciRunAttempt}`);
      const jobs = await pages(`${runPath}/attempts/${identity.ciRunAttempt}/jobs`, "jobs");
      const after = await get(runPath);
      const currentRuns = await pages(listPath, "workflow_runs", query);
      admitCandidateCi(identity, contract, runs, before, jobs, attempt);
      admitCandidateCi(identity, contract, currentRuns, before, jobs, after);
      await pull(identity);
      return Object.freeze({
        q: identity.q,
        runId: identity.ciRunId,
        runAttempt: identity.ciRunAttempt,
      });
    },

    // Metadata only: an artifact name or this observation alone cannot attest
    // producer provenance, archive bytes, or the build's source/execution path.
    async readArtifact(input, buildSelection) {
      const identity = snapshotIdentity(input);
      const build = structuredClone(buildSelection);
      requireEvidence(
        keys(build, "runId,runAttempt,artifactId,archiveSha256") &&
          matches(INTEGER, build.runId) &&
          matches(INTEGER, build.runAttempt) &&
          matches(INTEGER, build.artifactId) &&
          matches(DIGEST, build.archiveSha256),
        "artifact-selection",
      );
      const artifacts = await pages(`/actions/runs/${build.runId}/artifacts`, "artifacts");
      const matching = artifacts.filter((artifact) => apiInteger(artifact.id, build.artifactId));
      requireEvidence(matching.length === 1, "artifact-missing");
      const artifact = await get(`/actions/artifacts/${build.artifactId}`);
      for (const value of [matching[0], artifact]) {
        requireEvidence(
          apiInteger(value.id, build.artifactId) &&
            value.expired === false &&
            value.digest === `sha256:${build.archiveSha256}` &&
            apiInteger(value.workflow_run?.id, build.runId) &&
            apiInteger(value.workflow_run?.repository_id, identity.descriptor[1]) &&
            apiInteger(value.workflow_run?.head_repository_id, identity.descriptor[1]) &&
            value.workflow_run?.head_sha === identity.descriptor[4],
          "artifact-provenance",
        );
      }
      return artifact;
    },

    // This observes an independent baseline-producer channel, not a receipt found
    // inside the candidate archive. The installation pins the source manifest and
    // exact job/step contract. The retained archive still needs byte/schema and
    // actual serving/provider admission before it can authorize any mutation.
    async readBaselineArtifact(input, installedContract, selected, sourceManifestBytes) {
      try {
        const identity = snapshotIdentity(input);
        const contract = structuredClone(installedContract);
        const selection = structuredClone(selected);
        const sourceManifest = Buffer.isBuffer(sourceManifestBytes)
          ? Buffer.from(sourceManifestBytes)
          : null;
        requireEvidence(
          keys(contract, "workflowId,path,event,job,steps,sourceManifestSha256") &&
            matches(INTEGER, contract.workflowId) &&
            contract.path === ".github/workflows/deploy.yml" &&
            ["workflow_run", "workflow_dispatch"].includes(contract.event) &&
            typeof contract.job === "string" &&
            contract.job.length > 0 &&
            contract.job.length <= 128 &&
            Array.isArray(contract.steps) &&
            contract.steps.length > 0 &&
            contract.steps.length <= 128 &&
            Array.from(contract.steps).every(
              (step) => typeof step === "string" && step.length > 0 && step.length <= 256,
            ) &&
            new Set(contract.steps).size === contract.steps.length &&
            matches(DIGEST, contract.sourceManifestSha256) &&
            keys(selection, "runId,runAttempt,artifactId,archiveSha256,versionId") &&
            matches(INTEGER, selection.runId) &&
            // Artifact metadata has no run_attempt. Until there is an independently
            // authenticated per-attempt channel, reruns are ambiguous, not latest.
            selection.runAttempt === "1" &&
            matches(INTEGER, selection.artifactId) &&
            matches(DIGEST, selection.archiveSha256) &&
            matches(
              /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
              selection.versionId,
            ),
          "baseline-selection",
        );
        const sources = await reader.verifyInstalledSources(
          identity,
          sourceManifest,
          contract.sourceManifestSha256,
        );
        requireEvidence(
          sources.some((source) => source.path === contract.path),
          "baseline-workflow-source",
        );
        const repo = await get("");
        requireEvidence(
          apiInteger(repo?.id, identity.descriptor[1]) &&
            repo.full_name === identity.descriptor[2] &&
            repo.fork === false &&
            repo.archived === false,
          "baseline-repository",
        );
        const runPath = `/actions/runs/${selection.runId}`;
        function admitRun(run) {
          requireEvidence(
            apiInteger(run?.id, selection.runId) &&
              apiInteger(run.run_attempt, selection.runAttempt) &&
              apiInteger(run.workflow_id, contract.workflowId) &&
              run.path === contract.path &&
              run.event === contract.event &&
              run.head_branch === "main" &&
              run.head_sha === identity.descriptor[5] &&
              run.repository?.full_name === identity.descriptor[2] &&
              apiInteger(run.repository?.id, identity.descriptor[1]) &&
              apiInteger(run.head_repository?.id, identity.descriptor[1]) &&
              run.head_repository?.full_name === identity.descriptor[2] &&
              run.status === "completed" &&
              run.conclusion === "success",
            "baseline-run",
          );
        }
        admitRun(await get(runPath));
        admitRun(await get(`${runPath}/attempts/1`));
        const jobs = await pages(`${runPath}/attempts/1/jobs`, "jobs");
        requireEvidence(jobs.length === 1, "baseline-jobs");
        const job = jobs[0];
        requireEvidence(
          Number.isSafeInteger(job?.id) &&
            job.id > 0 &&
            apiInteger(job.run_id, selection.runId) &&
            apiInteger(job.run_attempt, selection.runAttempt) &&
            job.head_sha === identity.descriptor[5] &&
            job.name === contract.job &&
            job.status === "completed" &&
            job.conclusion === "success" &&
            Array.isArray(job.steps) &&
            job.steps.length === contract.steps.length &&
            contract.steps.every(
              (name, index) =>
                job.steps[index]?.name === name &&
                job.steps[index].number === index + 1 &&
                job.steps[index].status === "completed" &&
                job.steps[index].conclusion === "success",
            ),
          "baseline-jobs",
        );
        const artifacts = await pages(`${runPath}/artifacts`, "artifacts");
        const found = artifacts.filter((row) => apiInteger(row.id, selection.artifactId));
        requireEvidence(found.length === 1, "baseline-artifact-missing");
        const artifact = await get(`/actions/artifacts/${selection.artifactId}`);
        const name = `candidate-baseline-${selection.runId}-1-${selection.versionId}`;
        for (const value of [found[0], artifact]) {
          requireEvidence(
            apiInteger(value.id, selection.artifactId) &&
              value.name === name &&
              value.expired === false &&
              value.digest === `sha256:${selection.archiveSha256}` &&
              apiInteger(value.workflow_run?.id, selection.runId) &&
              apiInteger(value.workflow_run?.repository_id, identity.descriptor[1]) &&
              apiInteger(value.workflow_run?.head_repository_id, identity.descriptor[1]) &&
              value.workflow_run?.head_sha === identity.descriptor[5],
            "baseline-artifact-provenance",
          );
        }
        // Re-read the current attempt after jobs/artifacts; a rerun started while
        // reading is refusal even if the old attempt and archive were successful.
        admitRun(await get(runPath));
        return Object.freeze({
          schema: "two.candidate-baseline-producer-observation.v1",
          promotable: false,
          scope: "producer-metadata-only",
          q: identity.q,
          controllerSha: identity.descriptor[5],
          sourceManifestSha256: contract.sourceManifestSha256,
          runId: selection.runId,
          runAttempt: selection.runAttempt,
          artifactId: selection.artifactId,
          archiveSha256: selection.archiveSha256,
          versionId: selection.versionId,
        });
      } catch {
        throw new Error("Candidate GitHub refused: baseline-producer");
      }
    },

    // The expected digest must be anchored by the reviewed installation, outside
    // candidate inputs and API responses. Verifying a self-supplied digest is not
    // trust. This verifies only the named closure; installation must prove it is
    // complete before any credential-bearing tooling/test execution.
    async verifyInstalledSources(input, manifestBytes, installedManifestSha256) {
      const identity = snapshotIdentity(input);
      requireEvidence(
        Buffer.isBuffer(manifestBytes) &&
          manifestBytes.length > 0 &&
          manifestBytes.length <= 64 * 1024 &&
          matches(DIGEST, installedManifestSha256) &&
          candidateSha256(manifestBytes) === installedManifestSha256,
        "installed-manifest-digest",
      );
      let manifest;
      try {
        manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
      } catch {
        throw new Error("Candidate GitHub refused: installed-manifest-json");
      }
      requireEvidence(
        keys(manifest, "schema,controllerSha,files") &&
          manifest.schema === "two.candidate-controller-sources.v1" &&
          manifest.controllerSha === identity.descriptor[5] &&
          Array.isArray(manifest.files) &&
          manifest.files.length > 0 &&
          manifest.files.length <= 128,
        "installed-manifest-shape",
      );
      let total = 0;
      const paths = new Set();
      // Admit the whole manifest before issuing even the first path request.
      for (const file of manifest.files) {
        requireEvidence(
          keys(file, "path,gitBlobSha,sha256,size") &&
            safeSourcePath(file.path) &&
            matches(SHA, file.gitBlobSha) &&
            matches(DIGEST, file.sha256) &&
            Number.isSafeInteger(file.size) &&
            file.size >= 0 &&
            file.size <= MAX_SOURCE &&
            !paths.has(file.path.toLowerCase()),
          "installed-file-shape",
        );
        paths.add(file.path.toLowerCase());
        total += file.size;
        requireEvidence(total <= MAX_SOURCES, "installed-source-size");
      }
      const commit = await get(`/git/commits/${manifest.controllerSha}`);
      requireEvidence(
        commit?.sha === manifest.controllerSha && matches(SHA, commit.tree?.sha),
        "installed-commit",
      );
      const trees = new Map();
      async function tree(sha) {
        if (!trees.has(sha)) {
          requireEvidence(trees.size < 64, "installed-tree-count");
          const result = await get(`/git/trees/${sha}`);
          requireEvidence(
            result?.sha === sha &&
              result.truncated === false &&
              Array.isArray(result.tree) &&
              result.tree.length <= 4096,
            "installed-tree",
          );
          trees.set(sha, result.tree);
        }
        return trees.get(sha);
      }
      const files = [];
      for (const file of manifest.files) {
        const parts = file.path.split("/");
        requireEvidence(parts.length <= 8, "installed-path-depth");
        let treeSha = commit.tree.sha;
        for (const [index, part] of parts.entries()) {
          const entries = (await tree(treeSha)).filter((entry) => entry?.path === part);
          requireEvidence(entries.length === 1, "installed-tree-entry");
          const entry = entries[0];
          if (index === parts.length - 1) {
            requireEvidence(
              entry.type === "blob" &&
                ["100644", "100755"].includes(entry.mode) &&
                entry.sha === file.gitBlobSha &&
                entry.size === file.size,
              "installed-file-mode",
            );
          } else {
            requireEvidence(
              entry.type === "tree" && entry.mode === "040000" && matches(SHA, entry.sha),
              "installed-directory-mode",
            );
            treeSha = entry.sha;
          }
        }
        const path = parts.map(encodeURIComponent).join("/");
        const params = new URLSearchParams({ ref: manifest.controllerSha });
        const source = await get(`/contents/${path}?${params}`);
        requireEvidence(
          source?.type === "file" &&
            source.path === file.path &&
            source.sha === file.gitBlobSha &&
            source.size === file.size &&
            source.encoding === "base64" &&
            typeof source.content === "string" &&
            !Object.hasOwn(source, "target") &&
            !source.submodule_git_url,
          "installed-file-response",
        );
        const encoded = source.content.replaceAll("\n", "");
        const bytes = Buffer.from(encoded, "base64");
        const gitSha = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        requireEvidence(
          bytes.length === file.size &&
            bytes.toString("base64") === encoded &&
            candidateSha256(bytes) === file.sha256 &&
            gitSha === file.gitBlobSha,
          "installed-file-digest",
        );
        files.push({ path: file.path, bytes });
      }
      return files;
    },
  });
  return reader;
}
