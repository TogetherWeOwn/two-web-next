// These predicates consume independently retrieved controller evidence, never
// candidate assertions. They do not grant containment clearance or deploy code.
import { createHash } from "node:crypto";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const ORIGIN = "https://next.togetherweown.com";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INTEGER = /^[1-9][0-9]{0,19}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;

function requireEvidence(condition, code) {
  // Never interpolate API, path or candidate values into diagnostics.
  if (!condition) throw new Error(`Candidate staging refused: ${code}`);
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

function integer(value) {
  return matches(INTEGER, value);
}

function apiInteger(value, expected) {
  return Number.isSafeInteger(value) && value > 0 && String(value) === expected;
}

export function candidateSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The launcher supplies its own immutable source identity. Dispatch inputs may
// select only a PR/head and CI run/attempt; they cannot choose policy or tooling.
export function candidateIdentity(selection, launcher) {
  requireEvidence(keys(selection, "prNumber,headSha,ciRunId,ciRunAttempt"), "selection-shape");
  requireEvidence(
    integer(selection.prNumber) &&
      matches(SHA, selection.headSha) &&
      integer(selection.ciRunId) &&
      integer(selection.ciRunAttempt),
    "selection-values",
  );
  requireEvidence(
    keys(
      launcher,
      "repositoryId,repository,controllerSha,launcherSha,checkoutSha,runId,runAttempt,event,ref,path",
    ) &&
      integer(launcher.repositoryId) &&
      launcher.repository === REPOSITORY &&
      matches(SHA, launcher.controllerSha) &&
      matches(SHA, launcher.launcherSha) &&
      launcher.checkoutSha === launcher.controllerSha &&
      integer(launcher.runId) &&
      integer(launcher.runAttempt) &&
      launcher.event === "workflow_dispatch" &&
      launcher.ref === "refs/heads/main" &&
      launcher.path === ".github/workflows/candidate-staging.yml",
    "launcher-identity",
  );
  const descriptor = Object.freeze([
    "two.qa.run.v1",
    launcher.repositoryId,
    REPOSITORY,
    selection.prNumber,
    selection.headSha,
    launcher.controllerSha,
    launcher.launcherSha,
    launcher.runId,
    launcher.runAttempt,
    "staging",
    ORIGIN,
    "candidate-qa-login",
  ]);
  return Object.freeze({
    descriptor,
    q: candidateSha256(JSON.stringify(descriptor)),
    ciRunId: selection.ciRunId,
    ciRunAttempt: selection.ciRunAttempt,
  });
}

// Revalidate a retained identity without depending on upload/build tooling. The
// sparse normal-staging guard shares this builtin-only admission closure.
export function identitySnapshot(input) {
  const value = structuredClone(input);
  requireEvidence(
    keys(value, "descriptor,q,ciRunId,ciRunAttempt") &&
      Array.isArray(value.descriptor) &&
      value.descriptor.length === 12,
    "identity-shape",
  );
  const d = value.descriptor;
  const identity = candidateIdentity(
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
    JSON.stringify(d) === JSON.stringify(identity.descriptor) && value.q === identity.q,
    "identity-mismatch",
  );
  return identity;
}

function repositoryMatches(repository, id) {
  return (
    apiInteger(repository?.id, id) &&
    repository.full_name === REPOSITORY &&
    repository.fork === false
  );
}

export function admitCandidatePullRequest(identity, repository, pull) {
  const [, repositoryId, , prNumber, headSha] = identity.descriptor;
  requireEvidence(
    repositoryMatches(repository, repositoryId) && repository.archived === false,
    "repository-identity",
  );
  requireEvidence(
    apiInteger(pull?.number, prNumber) &&
      pull.state === "open" &&
      pull.merged === false &&
      pull.base?.ref === "main" &&
      repositoryMatches(pull.base.repo, repositoryId) &&
      repositoryMatches(pull.head?.repo, repositoryId) &&
      pull.head.sha === headSha,
    "pr-head-or-origin",
  );
}

// Pages are numbered by the trusted reader. No successful-only query/filter may
// precede this check. Partial pages, changed totals and duplicate IDs refuse.
export function completeCandidatePages(pages, field) {
  requireEvidence(
    ["workflow_runs", "jobs", "artifacts", "deployments"].includes(field) &&
      Array.isArray(pages) &&
      pages.length > 0 &&
      pages.length <= 5,
    "evidence-pages",
  );
  const total = pages[0]?.total_count;
  requireEvidence(Number.isSafeInteger(total) && total >= 0 && total <= 500, "evidence-count");
  requireEvidence(pages.length === Math.max(1, Math.ceil(total / 100)), "evidence-incomplete");
  const rows = [];
  for (const [index, page] of pages.entries()) {
    const expected = Math.min(100, total - index * 100);
    requireEvidence(
      page?.page === index + 1 &&
        page.total_count === total &&
        Array.isArray(page[field]) &&
        page[field].length === expected,
      "evidence-page-shape",
    );
    rows.push(...page[field]);
  }
  const ids = rows.map((row) => row?.id);
  requireEvidence(
    ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === rows.length,
    "evidence-duplicate-or-id",
  );
  return rows;
}

function validContract(contract) {
  return (
    keys(contract, "workflowId,path,event,jobs") &&
    integer(contract.workflowId) &&
    contract.path === ".github/workflows/candidate-ci.yml" &&
    contract.event === "workflow_dispatch" &&
    Array.isArray(contract.jobs) &&
    contract.jobs.length > 0 &&
    contract.jobs.length <= 100 &&
    new Set(contract.jobs.map((job) => job?.name)).size === contract.jobs.length &&
    contract.jobs.every(
      (job) =>
        keys(job, "name,steps") &&
        typeof job.name === "string" &&
        /^[A-Za-z0-9 ()_.:/-]{1,128}$/.test(job.name) &&
        Array.isArray(job.steps) &&
        job.steps.length > 0 &&
        job.steps.length <= 100 &&
        new Set(job.steps).size === job.steps.length &&
        job.steps.every(
          (step) => typeof step === "string" && /^[A-Za-z0-9 ()_.:/-]{1,128}$/.test(step),
        ),
    )
  );
}

function admitRun(identity, contract, run) {
  const [, repositoryId, , , headSha] = identity.descriptor;
  requireEvidence(
    apiInteger(run?.id, identity.ciRunId) &&
      apiInteger(run.run_attempt, identity.ciRunAttempt) &&
      apiInteger(run.workflow_id, contract.workflowId) &&
      run.path === contract.path &&
      run.event === contract.event &&
      run.head_sha === headSha &&
      repositoryMatches(run.repository, repositoryId) &&
      repositoryMatches(run.head_repository, repositoryId) &&
      run.status === "completed" &&
      run.conclusion === "success",
    "ci-run",
  );
}

// The contract and workflow source MUST come from installed trusted T, and the
// reader must independently verify that source. Candidate workflow changes are
// never interpreted as an amended execution contract. An aggregate is not one.
export function admitCandidateCi(identity, contract, runs, before, jobs, after) {
  requireEvidence(validContract(contract), "ci-contract");
  requireEvidence(
    Array.isArray(runs) && runs.length === 1 && runs[0]?.id === before?.id,
    "ci-newer-or-ambiguous-run",
  );
  for (const run of [runs[0], before, after]) admitRun(identity, contract, run);
  requireEvidence(Array.isArray(jobs) && jobs.length === contract.jobs.length, "ci-job-count");
  requireEvidence(new Set(jobs.map((job) => job?.id)).size === jobs.length, "ci-job-ids");
  for (const expected of contract.jobs) {
    const matches = jobs.filter((job) => job?.name === expected.name);
    requireEvidence(matches.length === 1, "ci-job-missing-or-duplicate");
    const job = matches[0];
    requireEvidence(
      Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        apiInteger(job.run_id, identity.ciRunId) &&
        apiInteger(job.run_attempt, identity.ciRunAttempt) &&
        job.head_sha === identity.descriptor[4] &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        Array.isArray(job.steps) &&
        job.steps.length === expected.steps.length,
      "ci-job-execution",
    );
    for (const [index, name] of expected.steps.entries()) {
      const step = job.steps[index];
      requireEvidence(
        step?.name === name &&
          step.number === index + 1 &&
          step.status === "completed" &&
          step.conclusion === "success",
        "ci-heavy-step-execution",
      );
    }
  }
}

export function safeBundlePath(path) {
  return (
    typeof path === "string" &&
    path.length <= 240 &&
    /^[A-Za-z0-9_./-]+$/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    (path === "worker/worker.mjs" ||
      /^worker\/chunks\/[A-Za-z0-9_-]+\.mjs$/.test(path) ||
      (path.startsWith("assets/") && !path.split("/").some((part) => part.startsWith("."))))
  );
}

// This is a flat, already safely decoded bundle, NOT an archive extractor.
// Producer receipts must be obtained independently from the trusted build
// wrapper, not from files inside the candidate's archive. Byte hashing alone
// proves neither source provenance nor safe binding capabilities.
export function admitCandidateBundle(identity, build, artifact, producer, files) {
  requireEvidence(
    keys(build, "runId,runAttempt,artifactId,archiveSha256") &&
      integer(build.runId) &&
      integer(build.runAttempt) &&
      integer(build.artifactId) &&
      matches(DIGEST, build.archiveSha256),
    "build-selection",
  );
  requireEvidence(
    apiInteger(artifact?.id, build.artifactId) &&
      artifact.expired === false &&
      artifact.digest === `sha256:${build.archiveSha256}` &&
      apiInteger(artifact.workflow_run?.id, build.runId) &&
      apiInteger(artifact.workflow_run.repository_id, identity.descriptor[1]) &&
      apiInteger(artifact.workflow_run.head_repository_id, identity.descriptor[1]) &&
      artifact.workflow_run.head_sha === identity.descriptor[4],
    "artifact-provenance",
  );
  requireEvidence(
    keys(
      producer,
      "schema,q,ciRunId,ciRunAttempt,buildRunId,buildRunAttempt,artifactId,archiveSha256,files,rootSha256",
    ) &&
      producer.schema === "two.candidate-build.v1" &&
      producer.q === identity.q &&
      producer.ciRunId === identity.ciRunId &&
      producer.ciRunAttempt === identity.ciRunAttempt &&
      producer.buildRunId === build.runId &&
      producer.buildRunAttempt === build.runAttempt &&
      producer.artifactId === build.artifactId &&
      producer.archiveSha256 === build.archiveSha256 &&
      matches(DIGEST, producer.rootSha256),
    "producer-provenance",
  );
  requireEvidence(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= MAX_FILES &&
      Array.isArray(producer.files) &&
      producer.files.length === files.length,
    "bundle-file-count",
  );
  let total = 0;
  const paths = new Set();
  const records = [];
  for (const file of files) {
    requireEvidence(
      keys(file, "path,type,bytes") &&
        safeBundlePath(file.path) &&
        file.type === "file" &&
        Buffer.isBuffer(file.bytes),
      "bundle-entry",
    );
    const folded = file.path.toLowerCase();
    requireEvidence(!paths.has(folded), "bundle-collision");
    paths.add(folded);
    total += file.bytes.length;
    requireEvidence(total <= MAX_BYTES, "bundle-size");
    records.push({ path: file.path, size: file.bytes.length, sha256: candidateSha256(file.bytes) });
  }
  requireEvidence(paths.has("worker/worker.mjs"), "bundle-entrypoint");
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const [index, record] of records.entries()) {
    const declared = producer.files[index];
    requireEvidence(
      keys(declared, "path,size,sha256") &&
        declared.path === record.path &&
        declared.size === record.size &&
        declared.sha256 === record.sha256,
      "bundle-file-digest",
    );
  }
  const root = candidateSha256(
    JSON.stringify(records.map((file) => [file.path, file.size, file.sha256])),
  );
  requireEvidence(root === producer.rootSha256, "bundle-root-digest");
  return Object.freeze({ rootSha256: root, bytes: total, files: records.length });
}
