"use strict";

// Independent acceptance contract: a main ancestor is not promotion proof.
// Run: node --test ci/release-promotion-proof.acceptance.cjs
// RELEASE_ON_PROMOTE selects an alternate publisher without editing these tests.
//
// Fixture protocol for the smallest post-smoke receipt option in the spec:
// PROMOTION_RUN_ID / PROMOTION_RUN_ATTEMPT are untrusted selector hints. Read
// GitHub's repository/workflow/run/attempt/jobs/artifact metadata before trusting
// promotion.json in production-promotion-<run>-<attempt>. Its schema-1 fields
// are illustrated in release-promotion-proof.fixture.cjs. The producing run may
// be globally failed because publication failed, or still running its release
// job. The producing deploy job and identity-aware post-smoke must be successful.
// A receipt alone, a caller boolean, or the workflow's overall conclusion is
// insufficient. Equivalent verifiable evidence can be coordinated with the
// test author; do not weaken assertions or edit acceptance-owned files to pass.
//
// Expected breaks: removing exact-SHA/producer/attempt/smoke checks publishes in
// a refusal case; refusing all repairs breaks the healthy controls; requiring
// overall workflow success breaks failed-publication recovery; moving proof
// after create leaves a tag behind. Every refusal checks both creates and tags.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { fixture, REPO, RUN, ATTEMPT } = require("./release-promotion-proof.fixture.cjs");

function published(result, sha, tag = "v0.10.1", latest = "--latest") {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.creates.length,
    1,
    `expected one publication: ${JSON.stringify(result.calls)}`,
  );
  const argv = result.creates[0];
  assert.equal(argv[2], tag);
  assert.equal(
    argv[argv.indexOf("--target") + 1],
    sha,
    "publication targets the exact promoted commit",
  );
  assert.ok(argv.includes(latest), `expected ${latest}: ${JSON.stringify(argv)}`);
  assert.equal(result.output, `tag_name=${tag}\nreleased=true\n`);
}

function refused(f, result, before) {
  // Check side effects first: a failed unknown provider call is not an adequate
  // refusal if the script has already asked GitHub to create the tag/release.
  assert.equal(
    result.creates.length,
    0,
    `untrusted proof caused publication: ${JSON.stringify(result.creates)}`,
  );
  assert.equal(f.git("show-ref", "--tags"), before, "refusal leaves every tag unchanged");
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0, "untrusted or inconclusive provenance must fail closed");
  assert.doesNotMatch(result.output, /released=true/, "refusal cannot report a release");
  assert.doesNotMatch(
    result.stderr,
    /fixture: unexpected|acceptance forbids network/,
    "refusal must come from validation, not an unsupported fixture operation",
  );
}

const denials = [
  [
    "never-promoted main tip",
    (f) => {
      f.state.runs = [];
      f.state.jobs = [];
      f.state.artifacts = [];
    },
  ],
  [
    "unhinted manual repair has no unchecked fallback",
    (f) => {
      f.state.runs = [];
      f.state.jobs = [];
      f.state.artifacts = [];
    },
    { hints: false },
  ],
  [
    "proof for previously promoted A cannot publish newer main B",
    (f) => {
      f.state.receipt.sha = f.historical;
      f.state.runs[0].head_sha = f.historical;
      f.state.artifacts[0].workflow_run.head_sha = f.historical;
    },
  ],
  [
    "missing invocation context is not permission to publish",
    (f) => {
      f.state.runs = [];
      f.state.jobs = [];
      f.state.artifacts = [];
    },
    { hints: false, extraEnv: { GITHUB_EVENT_NAME: "", GITHUB_WORKFLOW_REF: "" } },
  ],
  [
    "caller-supplied success assertions are not proof",
    (f) => {
      f.state.runs = [];
      f.state.artifacts = [];
    },
    {
      extraEnv: {
        PROMOTION_VERIFIED: "true",
        PROMOTION_SUCCESS: "true",
        PROMOTED_VERSION_ID: "12345678-1234-4234-8234-123456789abc",
      },
    },
  ],
  [
    "receipt from another repository",
    (f) => {
      f.state.receipt.repository = "outsider/r";
    },
  ],
  [
    "run from another repository",
    (f) => {
      f.state.runs[0].repository.full_name = "outsider/r";
    },
  ],
  [
    "fork producing head",
    (f) => {
      f.state.runs[0].head_repository = { id: 200, full_name: "outsider/r" };
    },
  ],
  [
    "wrong producing workflow path despite matching display name",
    (f) => {
      f.state.runs[0].path = ".github/workflows/pretend-production.yml";
    },
  ],
  [
    "wrong workflow in receipt",
    (f) => {
      f.state.receipt.workflow = ".github/workflows/release.yml";
    },
  ],
  [
    "pull-request producer",
    (f) => {
      f.state.runs[0].event = "pull_request";
      f.state.runs[0].head_branch = "feature";
    },
  ],
  [
    "non-main workflow producer",
    (f) => {
      f.state.runs[0].head_branch = "unreviewed";
    },
  ],
  [
    "wrong producing run in receipt",
    (f) => {
      f.state.receipt.run_id = "699";
    },
  ],
  [
    "stale attempt receipt",
    (f) => {
      f.state.receipt.run_attempt = "1";
    },
  ],
  [
    "wrong attempt returned by provider",
    (f) => {
      f.state.runs[0].run_attempt = 1;
    },
  ],
  [
    "job from another attempt",
    (f) => {
      f.state.jobs[0].run_attempt = 1;
    },
  ],
  [
    "job from another producing run",
    (f) => {
      f.state.jobs[0].run_id = 699;
    },
  ],
  [
    "receipt claims success for another job",
    (f) => {
      f.state.receipt.job = "release";
    },
  ],
  [
    "successful unrelated job cannot stand in for production",
    (f) => {
      f.state.jobs[0].name = "lint";
    },
  ],
  [
    "artifact name selects a stale attempt",
    (f) => {
      f.state.artifacts[0].name = "production-promotion-700-1";
    },
  ],
  [
    "artifact metadata belongs to another repository",
    (f) => {
      f.state.artifacts[0].workflow_run.repository_id = 200;
    },
  ],
  [
    "failed deploy job despite successful-looking receipt",
    (f) => {
      f.state.jobs[0].conclusion = "failure";
    },
  ],
  [
    "promotion step failed even though job claims success",
    (f) => {
      f.state.jobs[0].steps[0].conclusion = "failure";
    },
  ],
  [
    "post-promotion smoke failed",
    (f) => {
      f.state.jobs[0].steps[1].conclusion = "failure";
    },
  ],
  [
    "post-promotion smoke skipped",
    (f) => {
      f.state.jobs[0].steps[1].conclusion = "skipped";
    },
  ],
  [
    "post-promotion smoke missing",
    (f) => {
      f.state.jobs[0].steps.splice(1, 1);
    },
  ],
  [
    "post-promotion smoke still running",
    (f) => {
      f.state.jobs[0].steps[1].status = "in_progress";
      f.state.jobs[0].steps[1].conclusion = null;
    },
  ],
  [
    "globally green workflow cannot substitute for missing deploy proof",
    (f) => {
      f.state.runs[0].conclusion = "success";
      f.state.jobs = f.state.jobs.slice(1);
    },
  ],
  [
    "artifact belongs to another run",
    (f) => {
      f.state.artifacts[0].workflow_run.id = 699;
    },
  ],
  [
    "expired artifact",
    (f) => {
      f.state.artifacts[0].expired = true;
    },
  ],
  [
    "missing artifact",
    (f) => {
      f.state.artifacts = [];
    },
  ],
  [
    "ambiguous duplicate artifact",
    (f) => {
      f.state.artifacts.push({ ...f.state.artifacts[0], id: 801 });
    },
  ],
  [
    "malformed receipt JSON",
    (f) => {
      f.state.receiptText = "{incomplete";
    },
  ],
  [
    "unsupported receipt schema",
    (f) => {
      f.state.receipt.schema = 99;
    },
  ],
  [
    "missing promoted version identity",
    (f) => {
      delete f.state.receipt.promoted_version_id;
    },
  ],
  [
    "malformed promoted version identity",
    (f) => {
      f.state.receipt.promoted_version_id = "unknown";
    },
  ],
  ...["unavailable", "forbidden", "malformed-api", "download"].map((mode) => [
    `${mode} evidence lookup`,
    (f) => {
      f.state.proofError = mode;
    },
  ]),
];

for (const [name, change, options] of denials) {
  test(`refuses new tag: ${name}`, (t) => {
    const f = fixture(t);
    change(f);
    const tags = f.git("show-ref", "--tags");
    refused(f, f.run(options), tags);
  });
}

test("discovers trusted evidence without requiring a caller assertion", (t) => {
  const f = fixture(t);
  const result = f.run({ hints: false });
  published(result, f.sha);
  const createAt = result.calls.findIndex((argv) => argv[0] === "release");
  const prior = result.calls
    .slice(0, createAt)
    .map((argv) => argv.join(" "))
    .join("\n");
  assert.match(prior, /actions\/.*runs/, "provider run identity is checked before publication");
  assert.match(prior, /jobs/, "successful promotion and smoke are checked before publication");
  assert.match(prior, /artifacts/, "receipt producer metadata is checked before publication");
});

test("successful promotion permits repair when downstream publication made the workflow red", (t) => {
  const f = fixture(t);
  assert.equal(f.state.runs[0].conclusion, "failure");
  published(f.run(), f.sha);
});

test("globally successful production run with valid proof also permits repair", (t) => {
  const f = fixture(t);
  f.state.runs[0].conclusion = "success";
  f.state.jobs[1].conclusion = "success";
  published(f.run(), f.sha);
});

test("ordinary workflow-call publication works while its producing workflow is still running", (t) => {
  const f = fixture(t);
  f.state.runs[0].status = "in_progress";
  f.state.runs[0].conclusion = null;
  published(f.run({ workflowCall: true }), f.sha);
});

test("a selected older deployed SHA need not equal the producer workflow checkout SHA", (t) => {
  const f = fixture(t);
  const workflowHead = f.commit("docs: later main tip, not the selected deployment");
  f.state.runs[0].head_sha = workflowHead;
  f.state.artifacts[0].workflow_run.head_sha = workflowHead;
  // The successful producer's receipt binds the selected target, not github.sha.
  published(f.run(), f.sha);
});

test("partial release creation failure retries the same SHA and tag without an extra version bump", (t) => {
  const f = fixture(t);
  f.state.createError = true;
  const failed = f.run();
  assert.notEqual(failed.status, 0);
  assert.equal(failed.creates.length, 1);
  assert.equal(failed.creates[0][2], "v0.10.1");
  assert.equal(failed.output, "");
  assert.equal(f.git("rev-parse", "v0.10.1^{commit}"), f.sha);
  f.state.createError = false;
  published(f.run(), f.sha);
  assert.equal(f.git("tag", "--list", "v0.10.2"), "");
});

test("already-tagged missing-release repair does not demand new-tag provenance", (t) => {
  const f = fixture(t);
  f.git("tag", "v0.10.1", f.sha);
  f.state.runs = [];
  f.state.jobs = [];
  f.state.artifacts = [];
  published(f.run(), f.sha);
  assert.equal(f.git("tag", "--list", "v0.10.2"), "");
});

test("existing release is a no-op without promotion proof", (t) => {
  const f = fixture(t);
  f.git("tag", "v0.10.1", f.sha);
  f.state.releases = ["v0.10.1"];
  f.state.runs = [];
  f.state.jobs = [];
  f.state.artifacts = [];
  const before = f.git("show-ref", "--tags");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.creates.length, 0);
  assert.equal(result.output, "tag_name=v0.10.1\nreleased=true\n");
  assert.equal(f.git("show-ref", "--tags"), before);
});

test("historical tagged repair remains explicitly non-Latest", (t) => {
  const f = fixture(t);
  f.state.runs = [];
  f.state.jobs = [];
  f.state.artifacts = [];
  const before = f.git("show-ref", "--tags");
  published(
    f.run({ extraEnv: { RELEASE_SHA: f.historical } }),
    f.historical,
    "v0.9.0",
    "--latest=false",
  );
  assert.equal(f.git("show-ref", "--tags"), before);
});

test("dry-run previews an unproven main SHA without publishing or authorizing the next real run", (t) => {
  const f = fixture(t);
  f.state.runs = [];
  f.state.jobs = [];
  f.state.artifacts = [];
  const tags = f.git("show-ref", "--tags");
  const dry = f.run({ dryRun: true });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.creates.length, 0);
  assert.equal(dry.output, "tag_name=\nreleased=false\n");
  assert.match(dry.stdout, /0\.10\.1/);
  assert.equal(f.git("show-ref", "--tags"), tags);
  refused(f, f.run(), tags);
});

test("release lookup outage remains fail-closed even with healthy promotion evidence", (t) => {
  const f = fixture(t);
  f.state.releaseError = true;
  const tags = f.git("show-ref", "--tags");
  refused(f, f.run(), tags);
});

// A receipt is not trusted merely because JSON claims it came from this job.
// The workflow graph must produce it *after* identity-aware post-smoke, in the
// existing successful deploy job; release depends on that job, not vice versa.
test("workflow publishes the attempt-bound receipt only after successful identity-aware smoke", () => {
  const { parse } = require("yaml");
  const workflow = parse(
    fs.readFileSync(path.join(__dirname, "..", ".github/workflows/deploy-production.yml"), "utf8"),
  );
  const deploy = workflow.jobs["deploy-production"];
  const smokeAt = deploy.steps.findIndex(
    (step) =>
      step.env?.PROMOTED_VERSION_ID === "${{ steps.gradual.outputs.promoted-version-id }}" &&
      step.run?.includes("--expected-version-id"),
  );
  assert.ok(smokeAt >= 0, "successful identity-aware post-promotion smoke remains required");
  const proofAt = deploy.steps.findIndex(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.name === "production-promotion-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.ok(proofAt > smokeAt, "trusted receipt must be uploaded after post-promotion smoke");
  assert.notEqual(deploy.steps[smokeAt]["continue-on-error"], true);
  assert.notEqual(deploy["continue-on-error"], true);
  for (const step of deploy.steps.slice(smokeAt + 1, proofAt + 1)) {
    assert.doesNotMatch(
      String(step.if ?? ""),
      /always\(|failure\(|!\s*cancelled\(/,
      "failed smoke must not produce usable proof",
    );
    assert.notEqual(step["continue-on-error"], true);
  }
  assert.ok(workflow.jobs.release.needs.includes("deploy-production"));
  assert.doesNotMatch(String(workflow.jobs.release.if ?? ""), /always\(|failure\(/);
});

// GitHub exposes these display names to the verifier as API identifiers. A
// cosmetic rename, duplicate or unrelated namesake must not strand tag repair.
test("workflow proof API names identify the unique semantic producers in order", () => {
  const { parse } = require("yaml");
  const workflow = parse(
    fs.readFileSync(path.join(__dirname, "..", ".github/workflows/deploy-production.yml"), "utf8"),
  );
  const deploy = workflow.jobs["deploy-production"];
  assert.equal(deploy.name, "deploy-production", "verifier selects the deploy job by API name");
  const steps = deploy.steps;
  const producers = [
    [
      "Gradual promotion 5-50-100 with automatic rollback",
      (step) =>
        step.id === "gradual" &&
        step.uses?.startsWith("TogetherWeOwn/.github/actions/gradual-promote@"),
    ],
    [
      "Verify public routes on the promoted version",
      (step) =>
        step.env?.PROMOTED_VERSION_ID === "${{ steps.gradual.outputs.promoted-version-id }}" &&
        step.run?.includes("--expected-version-id"),
    ],
    [
      "Record successful production promotion",
      (step) =>
        step.env?.DEPLOY_SHA === "${{ needs.preflight.outputs.sha }}" &&
        step.env?.PROMOTED_VERSION_ID === "${{ steps.gradual.outputs.promoted-version-id }}" &&
        step.run?.includes("promotion.json"),
    ],
    [
      "Upload production promotion proof",
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.name === "production-promotion-${{ github.run_id }}-${{ github.run_attempt }}",
    ],
  ];
  let previousAt = -1;
  for (const [name, matches] of producers) {
    const selected = steps.filter(matches);
    assert.equal(selected.length, 1, `${name} has exactly one semantic producer`);
    const step = selected[0];
    assert.equal(step.name, name, "the actual producer carries the verifier's exact API name");
    assert.equal(
      steps.filter((candidate) => candidate.name === name).length,
      1,
      `${name} is unique, including unrelated steps`,
    );
    const at = steps.indexOf(step);
    assert.ok(at > previousAt, `${name} follows the preceding proof producer`);
    previousAt = at;
  }
});

test("workflow receipt binds the selected SHA, version and producing attempt at runtime", (t) => {
  const { parse } = require("yaml");
  const workflow = parse(
    fs.readFileSync(path.join(__dirname, "..", ".github/workflows/deploy-production.yml"), "utf8"),
  );
  const steps = workflow.jobs["deploy-production"].steps;
  const smokeAt = steps.findIndex(
    (step) =>
      step.env?.PROMOTED_VERSION_ID === "${{ steps.gradual.outputs.promoted-version-id }}" &&
      step.run?.includes("--expected-version-id"),
  );
  const uploadAt = steps.findIndex(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.name === "production-promotion-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.ok(uploadAt > smokeAt && smokeAt >= 0, "post-smoke receipt producer is required");
  const f = fixture(t);
  fs.cpSync(__dirname, path.join(f.root, "ci"), { recursive: true });
  const environment = f.environment({
    workflowCall: true,
    extraEnv: { GITHUB_SHA: f.historical, GITHUB_WORKSPACE: f.root },
  });
  const context = {
    "github.repository": REPO,
    "github.run_id": String(RUN),
    "github.run_attempt": String(ATTEMPT),
    "github.sha": f.historical,
    "github.workflow_ref": `${REPO}/.github/workflows/deploy-production.yml@refs/heads/main`,
    "needs.preflight.outputs.sha": f.sha,
    "steps.gradual.outputs.promoted-version-id": f.state.receipt.promoted_version_id,
    "runner.temp": f.root,
    "github.workspace": f.root,
  };
  const expand = (value) =>
    String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key) => {
      const resolved = key.startsWith("env.") ? environment[key.slice(4)] : context[key];
      assert.notEqual(resolved, undefined, `unmodelled receipt input ${key}`);
      return resolved;
    });
  let executed = 0;
  for (const step of steps.slice(smokeAt + 1, uploadAt)) {
    if (!step.run) continue;
    for (const [key, value] of Object.entries(step.env ?? {})) environment[key] = expand(value);
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", expand(step.run)],
      { cwd: f.root, env: environment, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    executed += 1;
  }
  assert.ok(
    executed > 0,
    "execute the real workflow's receipt writer, not a test-generated receipt",
  );
  const uploadPath = path.resolve(f.root, expand(steps[uploadAt].with.path));
  assert.ok(
    uploadPath.startsWith(`${f.root}${path.sep}`),
    "receipt stays in owned fixture scratch",
  );
  const filename = fs.statSync(uploadPath).isDirectory()
    ? path.join(uploadPath, "promotion.json")
    : uploadPath;
  const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
  for (const [key, expected] of Object.entries(f.state.receipt)) {
    assert.equal(
      receipt[key],
      expected,
      `producer binds ${key} independently of workflow checkout SHA`,
    );
  }
});

test("the reusable publisher and its caller grant only repository-local Actions reads for proof", () => {
  const { parse } = require("yaml");
  const read = (name) =>
    parse(fs.readFileSync(path.join(__dirname, "..", ".github/workflows", name), "utf8"));
  const release = read("release.yml");
  const deploy = read("deploy-production.yml");
  assert.equal(
    release.jobs.tag.permissions.actions,
    "read",
    "publisher can read run/jobs/artifact evidence",
  );
  assert.equal(
    deploy.jobs.release.permissions.actions,
    "read",
    "reusable workflow cannot elevate its caller token",
  );
});

test("repair workflow does not expose a caller-controlled trust bypass", () => {
  const { parse } = require("yaml");
  const workflow = parse(
    fs.readFileSync(path.join(__dirname, "..", ".github/workflows/release.yml"), "utf8"),
  );
  for (const [name, input] of Object.entries(workflow.on.workflow_dispatch.inputs)) {
    assert.ok(
      !/verified|trusted|success|skip.*proof|bypass/i.test(name),
      `${name} cannot grant promotion trust`,
    );
    if (input.type === "boolean") assert.equal(name, "dry_run", "only dry-run is a caller boolean");
  }
  assert.deepEqual(workflow.permissions, {});
  const permissions = workflow.jobs.tag.permissions;
  assert.equal(permissions.contents, "write");
  for (const [name, permission] of Object.entries(permissions)) {
    if (name !== "contents")
      assert.equal(permission, "read", `${name} cannot gain write authority`);
  }
});
