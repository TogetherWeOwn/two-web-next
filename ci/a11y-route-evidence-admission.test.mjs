import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admitSyntheticRouteEvidence } from "./admit-synthetic-route-evidence.mjs";
import { syntheticRouteReport } from "./route-evidence-synthetic-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function fixture() {
  const repository = "example/repo";
  const sourceSha = "a".repeat(40);
  const pull = {
    number: 7,
    state: "open",
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: sourceSha },
  };
  const run = {
    id: 34,
    run_attempt: 2,
    workflow_id: 12,
    repository: { full_name: repository },
    head_sha: sourceSha,
    event: "pull_request",
    pull_requests: [{ number: 7, head: { sha: sourceSha } }],
  };
  const job = {
    id: 56,
    run_id: 34,
    run_attempt: 2,
    name: "case-producer",
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "Run cases", status: "completed", conclusion: "success" },
      { name: "Upload report", status: "completed", conclusion: "success" },
    ],
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:05:00Z",
  };
  const expected = {
    repository,
    runId: 34,
    runAttempt: 2,
    producerJobName: "case-producer",
    producerResult: "success",
    requiredSteps: ["Run cases", "Upload report"],
    orchestrationSha: "b".repeat(40),
    artifactId: 78,
    artifactDigest: `sha256:${"c".repeat(64)}`,
  };
  const artifact = {
    id: 78,
    name: "route-evidence-34-2",
    digest: expected.artifactDigest,
    expired: false,
    size_in_bytes: 100,
    created_at: "2026-01-01T00:03:00Z",
    workflow_run: { id: 34, head_sha: sourceSha },
  };
  return {
    expected,
    run,
    attempt: structuredClone(run),
    job,
    artifact,
    pull,
    context: {
      repository,
      eventName: "pull_request",
      ref: "refs/pull/7/merge",
      sha: "d".repeat(40),
    },
    event: {
      number: 7,
      repository: { full_name: repository },
      pull_request: structuredClone(pull),
    },
  };
}

function requestFor(f, onPull = () => f.pull) {
  return async (path) => {
    if (path === "/actions/workflows/ci.yml")
      return f.workflow ?? { id: 12, path: ".github/workflows/ci.yml" };
    if (path === "/actions/runs/34") return f.run;
    if (path === "/actions/runs/34/attempts/2") return f.attempt;
    if (path === "/pulls/7") return onPull();
    if (path === "/actions/runs/34/attempts/2/jobs?per_page=100&page=1") {
      const jobs = f.jobs ?? [f.job];
      return { total_count: jobs.length, jobs };
    }
    if (path === "/actions/artifacts/78") return f.artifact;
    throw new Error("unexpected request");
  };
}

test("admission accepts only the bound synthetic report and rechecks the live head", async () => {
  const f = fixture();
  const visits = [];
  const request = requestFor(f, () => {
    visits.push("pull");
    return f.pull;
  });
  const download = async (id, digest) => {
    visits.push("download");
    assert.equal(id, f.expected.artifactId);
    assert.equal(digest, f.expected.artifactDigest);
    return new Map([["report.json", syntheticRouteReport(root)]]);
  };
  const result = await admitSyntheticRouteEvidence({ ...f, root, request, download });
  assert.equal(result.kind, "synthetic");
  assert.equal(result.sourceSha, f.pull.head.sha);
  assert.equal(result.identities.cases.length, 3);
  assert.deepEqual(visits, ["pull", "download", "pull"]);
});

test("admission refuses a head changed during artifact download", async () => {
  const f = fixture();
  const request = requestFor(f);
  const download = async () => {
    f.pull.head.sha = "e".repeat(40);
    return new Map([["report.json", syntheticRouteReport(root)]]);
  };
  await assert.rejects(
    admitSyntheticRouteEvidence({ ...f, root, request, download }),
    /inconsistent pull request binding/,
  );
});

test("admission refuses stale, failed, missing and ambiguous metadata before download", async () => {
  for (const [label, change] of Object.entries({
    "different workflow ID": (f) => {
      f.workflow = { id: 99, path: ".github/workflows/ci.yml" };
    },
    "different workflow path": (f) => {
      f.workflow = { id: 12, path: ".github/workflows/other.yml" };
    },
    "stale source head": (f) => {
      f.pull.head.sha = "e".repeat(40);
    },
    "unbound run head": (f) => {
      f.run.head_sha = f.expected.orchestrationSha;
    },
    "failed producer": (f) => {
      f.job.conclusion = "failure";
    },
    "skipped upload": (f) => {
      f.job.steps[1].conclusion = "skipped";
    },
    "old attempt producer": (f) => {
      f.job.run_attempt = 1;
    },
    "replaced artifact": (f) => {
      f.artifact.id = 79;
    },
    "digest mismatch": (f) => {
      f.artifact.digest = `sha256:${"e".repeat(64)}`;
    },
    "missing producer": (f) => {
      f.jobs = [];
    },
    "ambiguous producer": (f) => {
      f.jobs = [f.job, { ...f.job, id: 57 }];
    },
  })) {
    const f = fixture();
    change(f);
    let downloads = 0;
    const download = async () => {
      downloads++;
    };
    await assert.rejects(
      admitSyntheticRouteEvidence({ ...f, root, request: requestFor(f), download }),
      /route evidence refused/,
      label,
    );
    assert.equal(downloads, 0, label);
  }
});

test("admission revalidates the downloaded synthetic report", async () => {
  const f = fixture();
  const report = JSON.parse(syntheticRouteReport(root));
  report.testResults[0].assertionResults.pop();
  const download = async () => new Map([["report.json", Buffer.from(JSON.stringify(report))]]);
  await assert.rejects(
    admitSyntheticRouteEvidence({ ...f, root, request: requestFor(f), download }),
    /invalid synthetic report/,
  );
});

test("CLI refuses malformed or missing trusted inputs before metadata access", (t) => {
  const f = fixture();
  const scratch = mkdtempSync(join(tmpdir(), "synthetic-admission-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const eventPath = join(scratch, "event.json");
  writeFileSync(eventPath, JSON.stringify(f.event));
  const workflowSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const env = {
    PATH: process.env.PATH,
    GH_TOKEN: "fixture-only",
    ROUTE_WORKFLOW_SHA: workflowSha,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: f.context.repository,
    GITHUB_EVENT_NAME: f.context.eventName,
    GITHUB_REF: f.context.ref,
    GITHUB_SHA: f.context.sha,
    GITHUB_RUN_ID: String(f.expected.runId),
    GITHUB_RUN_ATTEMPT: String(f.expected.runAttempt),
    ROUTE_PRODUCER_RESULT: "success",
    ROUTE_ARTIFACT_ID: String(f.expected.artifactId),
    ROUTE_ARTIFACT_DIGEST: "c".repeat(64),
  };
  const metadataMarker = "synthetic transport reached\n";
  const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = () => { process.stderr.write(${JSON.stringify(metadataMarker)}); throw new Error("fixture transport stopped"); };`)}`;
  const cli = fileURLToPath(new URL("./run-synthetic-route-admission.mjs", import.meta.url));
  function check(overrides, marker = "") {
    const result = spawnSync(process.execPath, ["--import", preload, cli], {
      cwd: scratch,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${marker}route evidence refused: synthetic admission failed\n`);
  }
  // Valid inputs reach the deliberately refusing transport; there is no live request.
  check({}, metadataMarker);
  for (const overrides of [
    { ROUTE_WORKFLOW_SHA: workflowSha.replace(/^./, workflowSha[0] === "f" ? "e" : "f") },
    { ROUTE_WORKFLOW_SHA: "main" },
    { GITHUB_RUN_ID: "01" },
    { GITHUB_RUN_ATTEMPT: "9007199254740993" },
    { ROUTE_PRODUCER_RESULT: "skipped" },
    { ROUTE_ARTIFACT_ID: "" },
    { ROUTE_ARTIFACT_DIGEST: "" },
    { ROUTE_ARTIFACT_DIGEST: "unexpected-digest" },
  ])
    check(overrides);
});
