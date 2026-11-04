import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  admitCandidateBundle,
  admitCandidateCi,
  admitCandidatePullRequest,
  candidateIdentity,
  candidateSha256,
  completeCandidatePages,
} from "./candidate-staging-admission.mjs";
import { deploymentTarget } from "./staging-deploy-gate.mjs";

test("admission fixtures execute in required CI and the local complete check", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.equal(
    scripts["test:candidate-staging"],
    "node --test ci/candidate-staging-admission.test.mjs",
  );
  assert.ok(scripts.check.split(" && ").includes("npm run test:candidate-staging"));
  const steps = workflow.jobs.check.steps;
  const matches = steps.filter((step) => step.run === "npm run test:candidate-staging");
  assert.equal(matches.length, 1);
  assert.equal(
    matches[0].if,
    "(needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true')",
  );
  assert.equal(matches[0]["continue-on-error"], undefined);
  assert.ok(workflow.jobs["ci-ok"].needs.includes("check"));
});

function fixture() {
  const selection = { prNumber: "42", headSha: "a".repeat(40), ciRunId: "100", ciRunAttempt: "1" };
  const launcher = {
    repositoryId: "1234",
    repository: "TogetherWeOwn/two-web-next",
    controllerSha: "b".repeat(40),
    launcherSha: "c".repeat(40),
    checkoutSha: "b".repeat(40),
    runId: "200",
    runAttempt: "1",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    path: ".github/workflows/candidate-staging.yml",
  };
  const identity = candidateIdentity(selection, launcher);
  const repository = { id: 1234, full_name: launcher.repository, fork: false, archived: false };
  const pull = {
    number: 42,
    state: "open",
    merged: false,
    base: { ref: "main", repo: structuredClone(repository) },
    head: { sha: selection.headSha, repo: structuredClone(repository) },
  };
  const contract = {
    workflowId: "300",
    path: ".github/workflows/candidate-ci.yml",
    event: "workflow_dispatch",
    jobs: [
      { name: "full-checks", steps: ["Set up job", "Full check", "Complete job"] },
      { name: "browser", steps: ["Set up job", "All journeys", "Complete job"] },
    ],
  };
  const run = {
    id: 100,
    run_attempt: 1,
    workflow_id: 300,
    path: contract.path,
    event: contract.event,
    head_sha: selection.headSha,
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    status: "completed",
    conclusion: "success",
  };
  const jobs = contract.jobs.map((expected, index) => ({
    id: 400 + index,
    run_id: 100,
    run_attempt: 1,
    name: expected.name,
    head_sha: selection.headSha,
    status: "completed",
    conclusion: "success",
    steps: expected.steps.map((name, index) => ({
      name,
      number: index + 1,
      status: "completed",
      conclusion: "success",
    })),
  }));
  const files = [
    { path: "assets/app.css", type: "file", bytes: Buffer.from("body{color:black}") },
    { path: "worker/worker.mjs", type: "file", bytes: Buffer.from("export default {}") },
  ];
  const records = files.map((file) => ({
    path: file.path,
    size: file.bytes.length,
    sha256: candidateSha256(file.bytes),
  }));
  const build = { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) };
  const artifact = {
    id: 600,
    expired: false,
    digest: `sha256:${build.archiveSha256}`,
    workflow_run: {
      id: 500,
      repository_id: 1234,
      head_repository_id: 1234,
      head_sha: selection.headSha,
    },
  };
  const producer = {
    schema: "two.candidate-build.v1",
    q: identity.q,
    ciRunId: "100",
    ciRunAttempt: "1",
    buildRunId: "500",
    buildRunAttempt: "1",
    artifactId: "600",
    archiveSha256: build.archiveSha256,
    files: records,
    rootSha256: candidateSha256(
      JSON.stringify(records.map((file) => [file.path, file.size, file.sha256])),
    ),
  };
  return {
    selection,
    launcher,
    identity,
    repository,
    pull,
    contract,
    run,
    jobs,
    files,
    build,
    artifact,
    producer,
  };
}

function ci(f, after = f.run, runs = [f.run]) {
  return admitCandidateCi(f.identity, f.contract, runs, f.run, f.jobs, after);
}

function bundle(f) {
  return admitCandidateBundle(f.identity, f.build, f.artifact, f.producer, f.files);
}

test("canonical descriptor matches runtime Q, is immutable, and separates every selection", () => {
  const f = fixture();
  assert.equal(f.identity.q, candidateSha256(JSON.stringify(f.identity.descriptor)));
  assert.equal(f.identity.descriptor.length, 12);
  assert.equal(f.identity.descriptor[10], "https://next.togetherweown.com");
  assert.throws(() => {
    f.identity.descriptor[4] = "e".repeat(40);
  }, TypeError);
  for (const [field, value] of [
    ["runAttempt", "2"],
    ["runId", "201"],
    ["controllerSha", "e".repeat(40)],
    ["launcherSha", "f".repeat(40)],
  ]) {
    const launcher = { ...f.launcher, [field]: value };
    if (field === "controllerSha") launcher.checkoutSha = value;
    assert.notEqual(candidateIdentity(f.selection, launcher).q, f.identity.q);
  }
  assert.notEqual(
    candidateIdentity({ ...f.selection, headSha: "e".repeat(40) }, f.launcher).q,
    f.identity.q,
  );
  assert.notEqual(
    candidateIdentity({ ...f.selection, prNumber: "43" }, f.launcher).q,
    f.identity.q,
  );
});

for (const [field, value] of [
  ["prNumber", "042"],
  ["prNumber", 42],
  ["prNumber", "-42"],
  ["prNumber", "42;exit"],
  ["ciRunId", "0"],
  ["ciRunAttempt", "1\n"],
  ["headSha", "main"],
  ["headSha", "A".repeat(40)],
  ["headSha", "a".repeat(39)],
  ["headSha", ["a".repeat(40)]],
  ["ref", "refs/heads/main"],
]) {
  test(`selection refuses ${field} ${JSON.stringify(value)}`, () => {
    const f = fixture();
    assert.throws(
      () => candidateIdentity({ ...f.selection, [field]: value }, f.launcher),
      /refused/,
    );
  });
}

for (const [field, value] of [
  ["ref", "refs/heads/topic"],
  ["event", "pull_request_target"],
  ["event", "pull_request"],
  ["repository", "other/two-web-next"],
  ["repositoryId", "01234"],
  ["path", ".github/workflows/ci.yml"],
  ["controllerSha", "main"],
  ["controllerSha", ["b".repeat(40)]],
  ["launcherSha", ["c".repeat(40)]],
  ["checkoutSha", "a".repeat(40)],
  ["runAttempt", "2.0"],
]) {
  test(`launcher refuses ${field} ${JSON.stringify(value)}`, () => {
    const f = fixture();
    assert.throws(
      () => candidateIdentity(f.selection, { ...f.launcher, [field]: value }),
      /refused/,
    );
  });
}

test("same-repository PR admission rechecks its live head rather than following drift", () => {
  const f = fixture();
  admitCandidatePullRequest(f.identity, f.repository, f.pull);
  f.pull.head.sha = "e".repeat(40);
  assert.throws(
    () => admitCandidatePullRequest(f.identity, f.repository, f.pull),
    /pr-head-or-origin/,
  );
});

for (const [label, mutate] of [
  [
    "fork with write access",
    (f) => {
      f.pull.head.repo.fork = true;
      f.pull.author_association = "MEMBER";
    },
  ],
  [
    "same name wrong head id",
    (f) => {
      f.pull.head.repo.id = 1235;
    },
  ],
  [
    "same id foreign name",
    (f) => {
      f.pull.head.repo.full_name = "other/two-web-next";
    },
  ],
  [
    "missing head",
    (f) => {
      f.pull.head = null;
    },
  ],
  [
    "closed",
    (f) => {
      f.pull.state = "closed";
    },
  ],
  [
    "merged",
    (f) => {
      f.pull.merged = true;
    },
  ],
  [
    "retargeted",
    (f) => {
      f.pull.base.ref = "release";
    },
  ],
  [
    "foreign base",
    (f) => {
      f.pull.base.repo.id = 1235;
    },
  ],
  [
    "wrong PR",
    (f) => {
      f.pull.number = 43;
    },
  ],
  [
    "archived repo",
    (f) => {
      f.repository.archived = true;
    },
  ],
  [
    "foreign repository",
    (f) => {
      f.repository.id = 1235;
    },
  ],
]) {
  test(`PR refuses ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => admitCandidatePullRequest(f.identity, f.repository, f.pull), /refused/);
  });
}

test("bounded complete pages preserve all states, including unsuccessful newer evidence", () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    conclusion: index ? "success" : "failure",
  }));
  const pages = [
    { page: 1, total_count: 101, workflow_runs: rows.slice(0, 100) },
    { page: 2, total_count: 101, workflow_runs: rows.slice(100) },
  ];
  assert.deepEqual(completeCandidatePages(pages, "workflow_runs"), rows);
  assert.deepEqual(completeCandidatePages([{ page: 1, total_count: 0, jobs: [] }], "jobs"), []);
  for (const broken of [
    [],
    [pages[0]],
    [pages[1], pages[0]],
    [pages[0], { ...pages[1], total_count: 102 }],
    [pages[0], { ...pages[1], workflow_runs: [rows[0]] }],
    [pages[0], { ...pages[1], workflow_runs: [{ id: "101" }] }],
    [{ page: 1, total_count: 501, workflow_runs: [] }],
  ])
    assert.throws(() => completeCandidatePages(broken, "workflow_runs"), /refused/);
  assert.throws(() => completeCandidatePages(pages, "arbitrary"), /refused/);
});

test("CI admits only the selected complete run and unchanged rerun attempt", () => {
  ci(fixture());
});

for (const state of [
  "failure",
  "cancelled",
  "timed_out",
  "skipped",
  "neutral",
  "action_required",
  null,
]) {
  test(`CI run and every job/step refuse ${state}`, () => {
    for (const apply of [
      (f) => {
        f.run.conclusion = state;
      },
      (f) => {
        f.jobs[0].conclusion = state;
      },
      (f) => {
        f.jobs[0].steps[1].conclusion = state;
      },
    ]) {
      const f = fixture();
      apply(f);
      assert.throws(() => ci(f), /refused/);
    }
  });
}

for (const [label, mutate] of [
  [
    "run id",
    (f) => {
      f.run.id++;
    },
  ],
  [
    "run attempt",
    (f) => {
      f.run.run_attempt++;
    },
  ],
  [
    "pending",
    (f) => {
      f.run.status = "in_progress";
    },
  ],
  [
    "aggregate workflow",
    (f) => {
      f.run.path = ".github/workflows/ci.yml";
    },
  ],
  [
    "candidate edited workflow",
    (f) => {
      f.run.workflow_id++;
    },
  ],
  [
    "event",
    (f) => {
      f.run.event = "pull_request";
    },
  ],
  [
    "merge-ref SHA",
    (f) => {
      f.run.head_sha = "f".repeat(40);
    },
  ],
  [
    "fork",
    (f) => {
      f.run.head_repository.fork = true;
    },
  ],
  [
    "repository",
    (f) => {
      f.run.repository.id++;
    },
  ],
  [
    "missing heavy job",
    (f) => {
      f.jobs.pop();
    },
  ],
  [
    "duplicate job",
    (f) => {
      f.jobs[1] = structuredClone(f.jobs[0]);
    },
  ],
  [
    "wrong job head",
    (f) => {
      f.jobs[0].head_sha = "e".repeat(40);
    },
  ],
  [
    "wrong job attempt",
    (f) => {
      f.jobs[0].run_attempt++;
    },
  ],
  [
    "pending job",
    (f) => {
      f.jobs[0].status = "in_progress";
    },
  ],
  [
    "missing heavy step",
    (f) => {
      f.jobs[0].steps.splice(1, 1);
    },
  ],
  [
    "scope only instead of full check",
    (f) => {
      f.jobs[0].steps[1].name = "Scope verdict";
    },
  ],
  [
    "duplicate heavy step",
    (f) => {
      f.jobs[0].steps[2] = structuredClone(f.jobs[0].steps[1]);
    },
  ],
  [
    "pending step",
    (f) => {
      f.jobs[0].steps[1].status = "in_progress";
    },
  ],
  [
    "empty contract",
    (f) => {
      f.contract.jobs = [];
    },
  ],
  [
    "candidate contract path",
    (f) => {
      f.contract.path = "candidate/workflow.yml";
    },
  ],
]) {
  test(`CI refuses ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => ci(f), /refused/);
  });
}

test("CI refuses replacement, newer failure and a rerun starting during the final read", () => {
  const f = fixture();
  assert.throws(() => ci(f, { ...f.run, run_attempt: 2 }), /ci-run/);
  assert.throws(
    () => ci(f, f.run, [f.run, { ...f.run, id: 101, conclusion: "failure" }]),
    /ambiguous/,
  );
  assert.throws(() => ci(f, f.run, []), /ambiguous/);
});

test("bundle verifies independent producer joins, canonical per-file and root digests", () => {
  const f = fixture();
  assert.deepEqual(bundle(f), { rootSha256: f.producer.rootSha256, bytes: 34, files: 2 });
  f.files.reverse();
  assert.equal(bundle(f).rootSha256, f.producer.rootSha256);
});

for (const [label, mutate] of [
  [
    "expired",
    (f) => {
      f.artifact.expired = true;
    },
  ],
  [
    "artifact id",
    (f) => {
      f.artifact.id++;
    },
  ],
  [
    "name-only",
    (f) => {
      delete f.artifact.id;
      f.artifact.name = "bundle";
    },
  ],
  [
    "archive digest",
    (f) => {
      f.artifact.digest = `sha256:${"e".repeat(64)}`;
    },
  ],
  [
    "run id",
    (f) => {
      f.artifact.workflow_run.id++;
    },
  ],
  [
    "head",
    (f) => {
      f.artifact.workflow_run.head_sha = "e".repeat(40);
    },
  ],
  [
    "fork",
    (f) => {
      f.artifact.workflow_run.head_repository_id++;
    },
  ],
  [
    "repository",
    (f) => {
      f.artifact.workflow_run.repository_id++;
    },
  ],
  [
    "Q replay",
    (f) => {
      f.producer.q = "e".repeat(64);
    },
  ],
  [
    "build attempt replay",
    (f) => {
      f.producer.buildRunAttempt = "2";
    },
  ],
  [
    "CI attempt replay",
    (f) => {
      f.producer.ciRunAttempt = "2";
    },
  ],
  [
    "CI run replay",
    (f) => {
      f.producer.ciRunId = "101";
    },
  ],
  [
    "extra producer field",
    (f) => {
      f.producer.promotable = true;
    },
  ],
  [
    "mutated bytes",
    (f) => {
      f.files[0].bytes[0] ^= 1;
    },
  ],
  [
    "root digest",
    (f) => {
      f.producer.rootSha256 = "e".repeat(64);
    },
  ],
  [
    "record order",
    (f) => {
      f.producer.files.reverse();
    },
  ],
  [
    "file size",
    (f) => {
      f.producer.files[0].size++;
    },
  ],
  [
    "file count",
    (f) => {
      f.producer.files.pop();
    },
  ],
  [
    "no entrypoint",
    (f) => {
      f.files[1].path = "worker/chunks/other.mjs";
    },
  ],
  [
    "oversize",
    (f) => {
      f.files[0].bytes = Buffer.alloc(16 * 1024 * 1024);
    },
  ],
  [
    "too many entries",
    (f) => {
      f.files = Array(4097).fill(f.files[0]);
      f.producer.files = Array(4097).fill(f.producer.files[0]);
    },
  ],
  [
    "empty",
    (f) => {
      f.files = [];
      f.producer.files = [];
    },
  ],
]) {
  test(`bundle refuses ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => bundle(f), /refused/);
  });
}

for (const path of [
  "../worker.mjs",
  "/worker/worker.mjs",
  "assets/../../config.json",
  "assets//file",
  "assets/./file",
  "assets\\file",
  "assets/.dev.vars",
  "assets/%2e%2e/file",
  "assets/a\u0000b",
  "assets/café",
  "assets/a\nb",
  "package.json",
  "wrangler.jsonc",
  ".github/actions/run.mjs",
  "worker/local-plugin.mjs",
  "assets/" + "a".repeat(240),
]) {
  test(`bundle refuses injected path ${JSON.stringify(path)} without echo`, () => {
    const f = fixture();
    f.files[0].path = path;
    assert.throws(() => bundle(f), { message: "Candidate staging refused: bundle-entry" });
  });
}

for (const type of ["symlink", "hardlink", "directory", "fifo", "device"]) {
  test(`bundle refuses ${type}`, () => {
    const f = fixture();
    f.files[0].type = type;
    assert.throws(() => bundle(f), /bundle-entry/);
  });
}

test("duplicate/case-colliding files refuse, and executable bytes remain inert", () => {
  for (const path of ["assets/app.css", "assets/APP.css"]) {
    const f = fixture();
    f.files[1].path = path;
    assert.throws(() => bundle(f), /bundle-collision/);
  }
  const f = fixture();
  f.files[1].bytes = Buffer.from(
    "globalThis.__candidateExecuted = true; throw new Error('never execute')",
  );
  f.producer.files[1].size = f.files[1].bytes.length;
  f.producer.files[1].sha256 = candidateSha256(f.files[1].bytes);
  f.producer.rootSha256 = candidateSha256(
    JSON.stringify(f.producer.files.map((file) => [file.path, file.size, file.sha256])),
  );
  bundle(f);
  assert.equal(globalThis.__candidateExecuted, undefined);
});

test("candidate full-CI identity is not admitted by the unchanged production staging gate", () => {
  const f = fixture();
  assert.throws(
    () =>
      deploymentTarget({
        eventName: "workflow_run",
        event: { repository: f.repository, workflow_run: f.run },
        repository: f.launcher.repository,
        ref: "refs/heads/main",
        sha: f.launcher.launcherSha,
        checkoutSha: f.selection.headSha,
      }),
    /main push/,
  );
});
