import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateGitHubReader } from "./candidate-staging-github.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const CONTROLLER = "b".repeat(40);
const VERSION = "11111111-2222-3333-4444-555555555555";
const REFUSED = /^Error: Candidate GitHub refused: baseline-producer$/;
const WORKFLOW = ".github/workflows/deploy.yml";
const TOKEN = "fixture-token-not-a-secret";

function fixture() {
  const identity = candidateIdentity(
    { prNumber: "42", headSha: "a".repeat(40), ciRunId: "100", ciRunAttempt: "1" },
    {
      repositoryId: "1234",
      repository: "TogetherWeOwn/two-web-next",
      controllerSha: CONTROLLER,
      launcherSha: "c".repeat(40),
      checkoutSha: CONTROLLER,
      runId: "200",
      runAttempt: "1",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
  const bytes = Buffer.from("name: deploy\n# inert installed producer source\n");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const treeIds = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
  const sourceManifest = Buffer.from(
    JSON.stringify({
      schema: "two.candidate-controller-sources.v1",
      controllerSha: CONTROLLER,
      files: [
        { path: WORKFLOW, gitBlobSha: blob, sha256: candidateSha256(bytes), size: bytes.length },
      ],
    }),
  );
  const contract = {
    workflowId: "300",
    path: WORKFLOW,
    event: "workflow_run",
    job: "deploy-staging",
    steps: ["Set up job", "Retain baseline archive", "Complete job"],
    sourceManifestSha256: candidateSha256(sourceManifest),
  };
  const selection = {
    runId: "500",
    runAttempt: "1",
    artifactId: "600",
    archiveSha256: "d".repeat(64),
    versionId: VERSION,
  };
  const repository = {
    id: 1234,
    full_name: "TogetherWeOwn/two-web-next",
    fork: false,
    archived: false,
  };
  const run = {
    id: 500,
    run_attempt: 1,
    workflow_id: 300,
    path: WORKFLOW,
    event: "workflow_run",
    head_branch: "main",
    head_sha: CONTROLLER,
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    status: "completed",
    conclusion: "success",
  };
  const job = {
    id: 700,
    run_id: 500,
    run_attempt: 1,
    head_sha: CONTROLLER,
    name: contract.job,
    status: "completed",
    conclusion: "success",
    steps: contract.steps.map((name, index) => ({
      name,
      number: index + 1,
      status: "completed",
      conclusion: "success",
    })),
  };
  const artifact = {
    id: 600,
    name: `candidate-baseline-500-1-${VERSION}`,
    expired: false,
    digest: `sha256:${selection.archiveSha256}`,
    workflow_run: { id: 500, repository_id: 1234, head_repository_id: 1234, head_sha: CONTROLLER },
  };
  const routes = {
    [`/git/commits/${CONTROLLER}`]: { sha: CONTROLLER, tree: { sha: treeIds[0] } },
    [`/git/trees/${treeIds[0]}`]: {
      sha: treeIds[0],
      truncated: false,
      tree: [{ path: ".github", type: "tree", mode: "040000", sha: treeIds[1] }],
    },
    [`/git/trees/${treeIds[1]}`]: {
      sha: treeIds[1],
      truncated: false,
      tree: [{ path: "workflows", type: "tree", mode: "040000", sha: treeIds[2] }],
    },
    [`/git/trees/${treeIds[2]}`]: {
      sha: treeIds[2],
      truncated: false,
      tree: [{ path: "deploy.yml", type: "blob", mode: "100644", sha: blob, size: bytes.length }],
    },
    [`/contents/${WORKFLOW}?ref=${CONTROLLER}`]: {
      type: "file",
      path: WORKFLOW,
      sha: blob,
      size: bytes.length,
      encoding: "base64",
      content: bytes.toString("base64"),
    },
    "": repository,
    "/actions/runs/500": run,
    "/actions/runs/500/attempts/1": run,
    "/actions/runs/500/attempts/1/jobs?per_page=100&page=1": { total_count: 1, jobs: [job] },
    "/actions/runs/500/artifacts?per_page=100&page=1": { total_count: 1, artifacts: [artifact] },
    "/actions/artifacts/600": artifact,
  };
  const calls = [];
  const counts = new Map();
  const reader = createCandidateGitHubReader({
    token: TOKEN,
    async fetchImpl(url, init) {
      assert.ok(url.startsWith(`${BASE}/`) || url === BASE);
      const key = url.slice(BASE.length);
      assert.ok(Object.hasOwn(routes, key), `unexpected request ${key}`);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      calls.push(key);
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      const body = typeof routes[key] === "function" ? routes[key](count) : routes[key];
      return body instanceof Response
        ? body
        : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  return {
    identity,
    contract,
    selection,
    sourceManifest,
    routes,
    run,
    job,
    artifact,
    calls,
    reader,
  };
}

function read(f) {
  return f.reader.readBaselineArtifact(f.identity, f.contract, f.selection, f.sourceManifest);
}

test("baseline producer observation joins pinned source, exact successful attempt and separate artifact", async () => {
  const f = fixture();
  const before = JSON.stringify([f.identity, f.contract, f.selection, f.sourceManifest]);
  const result = await read(f);
  assert.deepEqual(result, {
    schema: "two.candidate-baseline-producer-observation.v1",
    promotable: false,
    scope: "producer-metadata-only",
    q: f.identity.q,
    controllerSha: CONTROLLER,
    sourceManifestSha256: f.contract.sourceManifestSha256,
    ...f.selection,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify([f.identity, f.contract, f.selection, f.sourceManifest]), before);
  assert.equal(f.calls.at(-1), "/actions/runs/500");
  assert.equal(f.calls.filter((path) => path === "/actions/runs/500").length, 2);
  assert.ok(f.calls.includes("/actions/runs/500/attempts/1/jobs?per_page=100&page=1"));
  assert.ok(!f.calls.some((path) => path.includes("latest") || path.includes("/pulls/")));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

for (const [name, mutate] of [
  [
    "missing contract",
    (f) => {
      f.contract = null;
    },
  ],
  [
    "arbitrary workflow",
    (f) => {
      f.contract.path = ".github/workflows/foreign.yml";
    },
  ],
  [
    "foreign event",
    (f) => {
      f.contract.event = "pull_request_target";
    },
  ],
  [
    "empty job",
    (f) => {
      f.contract.job = "";
    },
  ],
  [
    "empty steps",
    (f) => {
      f.contract.steps = [];
    },
  ],
  [
    "duplicate steps",
    (f) => {
      f.contract.steps.push(f.contract.steps[0]);
    },
  ],
  [
    "non-string step",
    (f) => {
      f.contract.steps[0] = 1;
    },
  ],
  [
    "sparse steps",
    (f) => {
      delete f.contract.steps[1];
    },
  ],
  [
    "oversize steps",
    (f) => {
      f.contract.steps = Array.from({ length: 129 }, (_, i) => `${i}`);
    },
  ],
  [
    "unpinned manifest",
    (f) => {
      f.contract.sourceManifestSha256 = "0".repeat(64);
    },
  ],
  [
    "source not bytes",
    (f) => {
      f.sourceManifest = f.sourceManifest.toString();
    },
  ],
  [
    "source tamper",
    (f) => {
      f.sourceManifest[0] ^= 1;
    },
  ],
  [
    "extra contract field",
    (f) => {
      f.contract.url = "https://example.com";
    },
  ],
  [
    "extra selection field",
    (f) => {
      f.selection.url = "https://example.com";
    },
  ],
  [
    "rerun",
    (f) => {
      f.selection.runAttempt = "2";
    },
  ],
  [
    "numeric attempt",
    (f) => {
      f.selection.runAttempt = 1;
    },
  ],
  [
    "arbitrary artifact",
    (f) => {
      f.selection.artifactId = "../600";
    },
  ],
  [
    "invalid digest",
    (f) => {
      f.selection.archiveSha256 = "D".repeat(64);
    },
  ],
  [
    "version alias",
    (f) => {
      f.selection.versionId = "latest";
    },
  ],
  [
    "foreign identity",
    (f) => {
      f.identity = structuredClone(f.identity);
      f.identity.descriptor[2] = "elsewhere/repo";
    },
  ],
]) {
  test(`baseline selection refuses ${name} before requests`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(read(f), REFUSED);
    assert.equal(f.calls.length, 0);
  });
}

for (const [name, mutate] of [
  [
    "fork repository",
    (f) => {
      f.routes[""].fork = true;
    },
  ],
  [
    "archived repository",
    (f) => {
      f.routes[""].archived = true;
    },
  ],
  [
    "wrong repository",
    (f) => {
      f.routes[""].id++;
    },
  ],
  [
    "wrong run",
    (f) => {
      f.run.id++;
    },
  ],
  [
    "rerun started",
    (f) => {
      f.run.run_attempt++;
    },
  ],
  [
    "wrong workflow",
    (f) => {
      f.run.workflow_id++;
    },
  ],
  [
    "wrong workflow path",
    (f) => {
      f.run.path += "@main";
    },
  ],
  [
    "wrong event",
    (f) => {
      f.run.event = "push";
    },
  ],
  [
    "non-main branch",
    (f) => {
      f.run.head_branch = "candidate";
    },
  ],
  [
    "candidate source",
    (f) => {
      f.run.head_sha = f.identity.descriptor[4];
    },
  ],
  [
    "foreign run repository",
    (f) => {
      f.run.repository.id++;
    },
  ],
  [
    "foreign head repository",
    (f) => {
      f.run.head_repository.id++;
    },
  ],
  [
    "foreign head name",
    (f) => {
      f.run.head_repository.full_name = "elsewhere/repo";
    },
  ],
  [
    "incomplete run",
    (f) => {
      f.run.status = "in_progress";
    },
  ],
  [
    "failed run",
    (f) => {
      f.run.conclusion = "failure";
    },
  ],
  [
    "cancelled run",
    (f) => {
      f.run.conclusion = "cancelled";
    },
  ],
  [
    "timed-out run",
    (f) => {
      f.run.conclusion = "timed_out";
    },
  ],
  [
    "skipped run",
    (f) => {
      f.run.conclusion = "skipped";
    },
  ],
  [
    "wrong job ID",
    (f) => {
      f.job.id = 0;
    },
  ],
  [
    "wrong job run",
    (f) => {
      f.job.run_id++;
    },
  ],
  [
    "wrong job attempt",
    (f) => {
      f.job.run_attempt++;
    },
  ],
  [
    "wrong job source",
    (f) => {
      f.job.head_sha = f.identity.descriptor[4];
    },
  ],
  [
    "wrong job name",
    (f) => {
      f.job.name += "candidate";
    },
  ],
  [
    "incomplete job",
    (f) => {
      f.job.status = "in_progress";
    },
  ],
  [
    "failed job",
    (f) => {
      f.job.conclusion = "failure";
    },
  ],
  [
    "skipped job",
    (f) => {
      f.job.conclusion = "skipped";
    },
  ],
  [
    "missing step",
    (f) => {
      f.job.steps.pop();
    },
  ],
  [
    "extra step",
    (f) => {
      f.job.steps.push({ ...f.job.steps[0] });
    },
  ],
  [
    "wrong step name",
    (f) => {
      f.job.steps[1].name += "not the uploader";
    },
  ],
  [
    "wrong step order",
    (f) => {
      f.job.steps[1].number++;
    },
  ],
  [
    "incomplete upload step",
    (f) => {
      f.job.steps[1].status = "in_progress";
    },
  ],
  [
    "skipped upload step",
    (f) => {
      f.job.steps[1].conclusion = "skipped";
    },
  ],
  [
    "cancelled upload step",
    (f) => {
      f.job.steps[1].conclusion = "cancelled";
    },
  ],
  [
    "missing job",
    (f) => {
      f.routes["/actions/runs/500/attempts/1/jobs?per_page=100&page=1"] = {
        total_count: 0,
        jobs: [],
      };
    },
  ],
  [
    "incomplete job page",
    (f) => {
      f.routes["/actions/runs/500/attempts/1/jobs?per_page=100&page=1"].total_count++;
    },
  ],
  [
    "extra job",
    (f) => {
      f.routes["/actions/runs/500/attempts/1/jobs?per_page=100&page=1"] = {
        total_count: 2,
        jobs: [f.job, { ...f.job, id: 701 }],
      };
    },
  ],
  [
    "missing baseline archive",
    (f) => {
      f.routes["/actions/runs/500/artifacts?per_page=100&page=1"] = {
        total_count: 0,
        artifacts: [],
      };
    },
  ],
  [
    "wrong artifact",
    (f) => {
      f.artifact.id++;
    },
  ],
  [
    "wrong version name",
    (f) => {
      f.artifact.name = "candidate-baseline-500-1-latest";
    },
  ],
  [
    "expired archive",
    (f) => {
      f.artifact.expired = true;
    },
  ],
  [
    "wrong digest",
    (f) => {
      f.artifact.digest = `sha256:${"e".repeat(64)}`;
    },
  ],
  [
    "wrong artifact run",
    (f) => {
      f.artifact.workflow_run.id++;
    },
  ],
  [
    "wrong artifact repository",
    (f) => {
      f.artifact.workflow_run.repository_id++;
    },
  ],
  [
    "foreign artifact head",
    (f) => {
      f.artifact.workflow_run.head_repository_id++;
    },
  ],
  [
    "candidate artifact",
    (f) => {
      f.artifact.workflow_run.head_sha = f.identity.descriptor[4];
    },
  ],
]) {
  test(`baseline producer refuses ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(read(f), REFUSED);
  });
}

test("baseline admission refuses a mismatched independent exact artifact even with a matching listing", async () => {
  const f = fixture();
  f.routes["/actions/artifacts/600"] = { ...f.artifact, name: "other-artifact" };
  await assert.rejects(read(f), REFUSED);
});

test("baseline admission refuses a mismatched exact attempt even with a successful current run", async () => {
  const f = fixture();
  f.routes["/actions/runs/500/attempts/1"] = { ...f.run, run_attempt: 2 };
  await assert.rejects(read(f), REFUSED);
});

test("baseline admission refuses a replacement run attempt after artifact retrieval", async () => {
  const f = fixture();
  f.routes["/actions/runs/500"] = (index) => (index === 0 ? f.run : { ...f.run, run_attempt: 2 });
  await assert.rejects(read(f), REFUSED);
  assert.equal(f.calls.at(-1), "/actions/runs/500");
});

test("baseline admission requires the workflow in the source closure before run reads", async () => {
  const f = fixture();
  f.sourceManifest = Buffer.from(
    JSON.stringify({
      schema: "two.candidate-controller-sources.v1",
      controllerSha: CONTROLLER,
      files: [],
    }),
  );
  f.contract.sourceManifestSha256 = candidateSha256(f.sourceManifest);
  await assert.rejects(read(f), REFUSED);
  assert.equal(f.calls.length, 0);
});

test("baseline transport failures redact source, credentials and upstream diagnostics", async () => {
  const f = fixture();
  f.routes["/actions/runs/500"] = () => {
    throw new Error(`${TOKEN} private upstream detail`);
  };
  await assert.rejects(read(f), REFUSED);
});

test("baseline source and selection are copied before asynchronous source retrieval", async () => {
  const f = fixture();
  const key = `/git/commits/${CONTROLLER}`;
  const original = f.routes[key];
  f.routes[key] = () => {
    f.contract.steps[1] = "candidate step";
    f.selection.versionId = "latest";
    f.sourceManifest.fill(0);
    return original;
  };
  const result = await read(f);
  assert.equal(result.versionId, VERSION);
});
