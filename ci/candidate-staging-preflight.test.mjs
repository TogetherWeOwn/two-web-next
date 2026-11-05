import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { readCandidatePreflight } from "./candidate-staging-preflight.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const REPOSITORY = "TogetherWeOwn/two-web-next";
const PATH = ".github/workflows/candidate-staging.yml";
const SOURCE = "b".repeat(40);
const HEAD = "a".repeat(40);
const TOKEN = "synthetic-preflight-token";
const REFUSED = /^Error: Candidate preflight refused$/;

function fixture() {
  const selection = { prNumber: "42", headSha: HEAD, ciRunId: "100", ciRunAttempt: "1" };
  const context = {
    actions: "true",
    checkoutSha: SOURCE,
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    repository: REPOSITORY,
    repositoryId: "1234",
    runAttempt: "1",
    runId: "200",
    sha: SOURCE,
    workflowRef: `${REPOSITORY}/${PATH}@refs/heads/main`,
    workflowSha: SOURCE,
  };
  const repository = { id: 1234, full_name: REPOSITORY, fork: false, archived: false };
  const pull = {
    number: 42,
    state: "open",
    merged: false,
    base: { ref: "main", repo: structuredClone(repository) },
    head: { sha: HEAD, repo: structuredClone(repository) },
  };
  const workflow = { id: 300, path: PATH, state: "active" };
  const run = {
    id: 200,
    run_attempt: 1,
    workflow_id: 300,
    path: PATH,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: SOURCE,
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    status: "in_progress",
    conclusion: null,
  };
  const calls = [];
  const routes = {
    "": repository,
    "/pulls/42": pull,
    "/actions/workflows/candidate-staging.yml": workflow,
    "/actions/runs/200": run,
    "/actions/runs/200/attempts/1": run,
  };
  const counts = new Map();
  const options = {
    token: TOKEN,
    selection,
    context,
    async fetchImpl(url, init) {
      assert.ok(url.startsWith(BASE));
      const path = url.slice(BASE.length);
      assert.ok(Object.hasOwn(routes, path), `no unadmitted endpoint: ${path}`);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.body, undefined);
      assert.ok(init.signal instanceof AbortSignal);
      const count = counts.get(path) ?? 0;
      counts.set(path, count + 1);
      calls.push(path);
      const value = typeof routes[path] === "function" ? routes[path](count) : routes[path];
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    },
  };
  return { options, context, selection, run, workflow, repository, pull, calls, routes };
}

test("preflight observes the main-only launcher and final exact same-repo head, not CI", async () => {
  const f = fixture();
  const result = await readCandidatePreflight(f.options);
  assert.deepEqual(f.calls, [
    "/actions/workflows/candidate-staging.yml",
    "/actions/runs/200",
    "/actions/runs/200/attempts/1",
    "",
    "/pulls/42",
    "/actions/runs/200",
    "",
    "/pulls/42",
  ]);
  assert.deepEqual(Object.keys(result), [
    "schema",
    "promotable",
    "scope",
    "qualification",
    "q",
    "repositoryId",
    "repository",
    "prNumber",
    "headSha",
    "controllerSha",
    "launcherSha",
    "workflowId",
    "runId",
    "runAttempt",
    "selectedCiRunId",
    "selectedCiRunAttempt",
  ]);
  assert.equal(result.schema, "two.candidate-preflight.v1");
  assert.equal(result.promotable, false);
  assert.equal(result.qualification, false);
  assert.equal(result.scope, "launcher-and-pr-only");
  assert.equal(result.headSha, HEAD);
  assert.equal(result.controllerSha, SOURCE);
  assert.equal(result.launcherSha, SOURCE);
  assert.equal(result.selectedCiRunId, "100");
  assert.equal(result.selectedCiRunAttempt, "1");
  assert.equal(result.runId, "200");
  assert.equal(result.runAttempt, "1");
  assert.match(result.q, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(result));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

for (const [label, change] of [
  ["not Actions", (f) => (f.context.actions = "false")],
  ["fork context", (f) => (f.context.repository = "outsider/two-web-next")],
  ["candidate ref", (f) => (f.context.ref = "refs/heads/topic")],
  ["PR merge ref", (f) => (f.context.ref = "refs/pull/42/merge")],
  ["pull request target", (f) => (f.context.event = "pull_request_target")],
  ["input context field", (f) => (f.context.accountId = "not-allowed")],
  ["missing runner field", (f) => delete f.context.actions],
  ["missing workflow SHA", (f) => delete f.context.workflowSha],
  ["candidate workflow revision", (f) => (f.context.workflowSha = HEAD)],
  ["wrong checkout", (f) => (f.context.checkoutSha = HEAD)],
  ["wrong runner SHA", (f) => (f.context.sha = HEAD)],
  [
    "wrong workflow path",
    (f) => (f.context.workflowRef = `${REPOSITORY}/other.yml@refs/heads/main`),
  ],
  ["wrong launcher ref", (f) => (f.context.workflowRef = `${REPOSITORY}/${PATH}@refs/heads/topic`)],
  ["missing selection", (f) => (f.options.selection = undefined)],
  ["extra dispatch policy", (f) => (f.selection.profile = "production")],
  ["input injection", (f) => (f.selection.prNumber = "42; exit 0")],
  ["noncanonical PR", (f) => (f.selection.prNumber = "042")],
  ["uppercase head", (f) => (f.selection.headSha = "A".repeat(40))],
  ["arbitrary ref", (f) => (f.selection.headSha = "main")],
  ["invalid CI run", (f) => (f.selection.ciRunId = 100)],
  ["invalid CI attempt", (f) => (f.selection.ciRunAttempt = "0")],
  ["invalid run", (f) => (f.context.runId = "200/attempts/1")],
  ["invalid attempt", (f) => (f.context.runAttempt = "0")],
  ["invalid repo ID", (f) => (f.context.repositoryId = "unknown")],
  ["missing token", (f) => (f.options.token = undefined)],
]) {
  test(`preflight refuses ${label} before remote access`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
    assert.deepEqual(f.calls, []);
  });
}

for (const [label, change] of [
  ["wrong workflow ID", (f) => (f.run.workflow_id = 301)],
  ["disabled workflow", (f) => (f.workflow.state = "disabled_manually")],
  ["wrong workflow path", (f) => (f.workflow.path = ".github/workflows/deploy.yml")],
  ["invalid workflow ID", (f) => (f.workflow.id = "300")],
  ["wrong run path", (f) => (f.run.path = ".github/workflows/deploy.yml")],
  ["wrong run ID", (f) => (f.run.id = 201)],
  ["newer attempt", (f) => (f.run.run_attempt = 2)],
  ["branch mismatch", (f) => (f.run.head_branch = "topic")],
  ["controller mismatch", (f) => (f.run.head_sha = HEAD)],
  ["wrong event", (f) => (f.run.event = "pull_request_target")],
  ["repository mismatch", (f) => (f.run.repository.id = 1235)],
  ["foreign head repository", (f) => (f.run.head_repository.full_name = "other/repo")],
  ["fork head repository", (f) => (f.run.head_repository.fork = true)],
  ["queued run", (f) => (f.run.status = "queued")],
  ["completed run", (f) => (f.run.status = "completed")],
  ["cancelled run", (f) => (f.run.conclusion = "cancelled")],
  ["forged success", (f) => (f.run.conclusion = "success")],
  ["archived repository", (f) => (f.repository.archived = true)],
  ["fork PR", (f) => (f.pull.head.repo.fork = true)],
  ["closed PR", (f) => (f.pull.state = "closed")],
  ["merged PR", (f) => (f.pull.merged = true)],
  ["retargeted PR", (f) => (f.pull.base.ref = "release")],
  ["moved head", (f) => (f.pull.head.sha = "d".repeat(40))],
]) {
  test(`preflight refuses authenticated ${label}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
    assert.ok(f.calls.length > 0);
  });
}

for (const path of ["/actions/runs/200", "/actions/runs/200/attempts/1"]) {
  test(`preflight refuses current/explicit-attempt disagreement at ${path}`, async () => {
    const f = fixture();
    f.routes[path] = { ...f.run, run_attempt: 2 };
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
  });
}

test("preflight refuses a rerun appearing after PR admission", async () => {
  const f = fixture();
  f.routes["/actions/runs/200"] = (count) => ({ ...f.run, run_attempt: count === 0 ? 1 : 2 });
  await assert.rejects(readCandidatePreflight(f.options), REFUSED);
  assert.equal(f.calls.at(-1), "/actions/runs/200");
});

test("preflight refuses head movement at the final live observation", async () => {
  const f = fixture();
  f.routes["/pulls/42"] = (count) => ({
    ...f.pull,
    head: { ...f.pull.head, sha: count === 0 ? HEAD : "e".repeat(40) },
  });
  await assert.rejects(readCandidatePreflight(f.options), REFUSED);
  assert.equal(f.calls.at(-1), "/pulls/42");
});

test("preflight fixes selection and context before the first await", async () => {
  const f = fixture();
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (...args) => {
    f.selection.headSha = "e".repeat(40);
    f.context.runAttempt = "2";
    return original(...args);
  };
  const result = await readCandidatePreflight(f.options);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.runAttempt, "1");
});

for (const status of [301, 302, 401, 403, 404, 429, 500]) {
  test(`preflight refuses HTTP ${status} once without credential retry`, async () => {
    const f = fixture();
    f.routes["/actions/workflows/candidate-staging.yml"] = new Response("private provider detail", {
      status,
      headers: { "content-type": "application/json", location: "https://other.invalid/private" },
    });
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
    assert.equal(f.calls.length, 1);
  });
}

test("preflight discards network error messages and never returns raw metadata", async () => {
  const f = fixture();
  f.options.fetchImpl = async () => {
    throw new Error(`${TOKEN} private-url`);
  };
  await assert.rejects(readCandidatePreflight(f.options), REFUSED);
});

for (const signal of [null, false, {}, { aborted: false }, "not-a-signal"]) {
  test(`preflight refuses invalid cancellation signal ${JSON.stringify(signal)}`, async () => {
    const f = fixture();
    f.options.signal = signal;
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
    assert.deepEqual(f.calls, []);
  });
}

test("preflight refuses cancellation before any request without exposing the reason", async () => {
  const f = fixture();
  f.options.signal = AbortSignal.abort(new Error(`${TOKEN} private-url`));
  await assert.rejects(readCandidatePreflight(f.options), REFUSED);
  assert.deepEqual(f.calls, []);
});

for (let cancelledAt = 1; cancelledAt <= 8; cancelledAt++) {
  test(`preflight refuses cancellation at request ${cancelledAt} without another request`, async () => {
    const f = fixture();
    const controller = new AbortController();
    f.options.signal = controller.signal;
    const original = f.options.fetchImpl;
    f.options.fetchImpl = async (...args) => {
      const response = await original(...args);
      if (f.calls.length === cancelledAt) controller.abort(new Error(`${TOKEN} private-url`));
      return response;
    };
    await assert.rejects(readCandidatePreflight(f.options), REFUSED);
    assert.equal(f.calls.length, cancelledAt);
  });
}

test("preflight creates one nonrenewing total deadline and combines every request timeout", async (t) => {
  const f = fixture();
  const total = new AbortController();
  const request = new AbortController();
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeouts.push(milliseconds);
    return milliseconds === 120_000 ? total.signal : request.signal;
  });
  const original = f.options.fetchImpl;
  const signals = [];
  f.options.fetchImpl = async (url, init) => {
    signals.push(init.signal);
    return original(url, init);
  };
  const result = await readCandidatePreflight(f.options);
  assert.equal(result.qualification, false);
  assert.deepEqual(timeouts, [120_000, ...Array(8).fill(10_000)]);
  assert.equal(signals.length, 8);
  for (const signal of signals) assert.equal(signal.aborted, false);
  total.abort();
  for (const signal of signals) assert.equal(signal.aborted, true);
});

test("preflight refuses total deadline expiry at the final response", async (t) => {
  const f = fixture();
  const total = new AbortController();
  const request = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds) =>
    milliseconds === 120_000 ? total.signal : request.signal,
  );
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (...args) => {
    const response = await original(...args);
    if (f.calls.length === 8) total.abort(new DOMException("private-url", "TimeoutError"));
    return response;
  };
  await assert.rejects(readCandidatePreflight(f.options), REFUSED);
  assert.equal(f.calls.length, 8);
});

test("read-only workflow pins its builtin-only main closure, no environment or mutation permission", () => {
  const workflow = YAML.parse(readFileSync(new URL(`../${PATH}`, import.meta.url), "utf8"));
  assert.equal(workflow.name, "Candidate read-only admission");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "prNumber",
    "headSha",
    "ciRunId",
    "ciRunAttempt",
  ]);
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    assert.equal(input.type, "string");
    assert.equal(input.required, true);
    assert.equal(input.default, undefined);
  }
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["preflight"]);
  const job = workflow.jobs.preflight;
  assert.equal(job.name, "candidate-read-only-preflight");
  assert.equal(
    job.if,
    "github.repository == 'TogetherWeOwn/two-web-next' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  assert.equal(job.environment, undefined);
  assert.equal(job.permissions, undefined);
  assert.equal(job.timeoutMinutes, undefined);
  assert.equal(job["timeout-minutes"], 3);
  assert.equal(job.steps.length, 3);
  const [checkout, node, observe] = job.steps;
  assert.equal(checkout.uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with["sparse-checkout-cone-mode"], false);
  assert.deepEqual(checkout.with["sparse-checkout"].trim().split("\n"), [
    "ci/candidate-staging-preflight.mjs",
    "ci/candidate-staging-admission.mjs",
    "ci/candidate-staging-github.mjs",
  ]);
  assert.equal(node.uses, "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  assert.equal(node.with["node-version"], 24);
  assert.equal(observe.run, "node ci/candidate-staging-preflight.mjs");
  assert.deepEqual(observe.env, {
    GITHUB_TOKEN: "${{ github.token }}",
    CANDIDATE_SELECTION: "${{ toJSON(inputs) }}",
  });
  assert.ok(!JSON.stringify(workflow).includes("secrets."));
  assert.ok(!JSON.stringify(workflow).includes("staging-application-exclusive"));
});

test("the exact three-file sparse CLI closure imports with no dependencies and sanitizes refusal", () => {
  const directory = mkdtempSync(join(tmpdir(), "candidate-preflight-"));
  try {
    for (const file of ["preflight", "admission", "github"]) {
      const name = `candidate-staging-${file}.mjs`;
      copyFileSync(new URL(name, import.meta.url), join(directory, name));
    }
    const result = spawnSync(
      process.execPath,
      [join(directory, "candidate-staging-preflight.mjs"), "unexpected"],
      {
        cwd: directory,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Candidate preflight refused\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
