import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateGitHubReader } from "./candidate-staging-github.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
// Synthetic, non-secret value; it must never appear in a diagnostic.
const TOKEN = "fixture-token-not-a-secret";
const REFUSED = /^Error: Candidate GitHub refused: /;
const HEAD = "a".repeat(40);
const CONTROLLER = "b".repeat(40);

function fixture() {
  const selection = { prNumber: "42", headSha: HEAD, ciRunId: "100", ciRunAttempt: "1" };
  const launcher = {
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
  };
  const identity = candidateIdentity(selection, launcher);
  const repository = { id: 1234, full_name: launcher.repository, fork: false, archived: false };
  const pull = {
    number: 42,
    state: "open",
    merged: false,
    base: { ref: "main", repo: structuredClone(repository) },
    head: { sha: HEAD, repo: structuredClone(repository) },
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
    head_sha: HEAD,
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
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    steps: expected.steps.map((name, step) => ({
      name,
      number: step + 1,
      status: "completed",
      conclusion: "success",
    })),
  }));
  const build = { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) };
  const artifact = {
    id: 600,
    expired: false,
    digest: `sha256:${build.archiveSha256}`,
    workflow_run: { id: 500, repository_id: 1234, head_repository_id: 1234, head_sha: HEAD },
  };
  return { identity, repository, pull, contract, run, jobs, build, artifact };
}

function json(body, headers = { "content-type": "application/json; charset=utf-8" }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers,
  });
}

// A route is a body, a Response, or a function of the per-key call index.
// Anything unrouted is recorded and fails the request.
function api(routes) {
  const calls = [];
  const counts = new Map();
  const unexpected = [];
  async function fetchImpl(url, init) {
    assert.ok(url.startsWith(BASE), "requests stay on the fixed origin");
    const key = url.slice(BASE.length);
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    calls.push({ key, url, init });
    if (!Object.hasOwn(routes, key)) {
      unexpected.push(key);
      throw new Error(`unrouted ${key}`);
    }
    const route = typeof routes[key] === "function" ? routes[key](index) : routes[key];
    return route instanceof Response || typeof route?.status === "number" ? route : json(route);
  }
  return { fetchImpl, calls, unexpected, keys: () => calls.map((call) => call.key) };
}

function reader(fetchImpl) {
  return createCandidateGitHubReader({ token: TOKEN, fetchImpl });
}

function openStream(chunk, state) {
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

const ciList = `/actions/workflows/300/runs?head_sha=${HEAD}&per_page=100&page=1`;
const ciJobs = "/actions/runs/100/attempts/1/jobs?per_page=100&page=1";

function ciRoutes(f, overrides = {}) {
  return {
    "": f.repository,
    "/pulls/42": f.pull,
    [ciList]: { total_count: 1, workflow_runs: [f.run] },
    "/actions/runs/100": f.run,
    "/actions/runs/100/attempts/1": f.run,
    [ciJobs]: { total_count: f.jobs.length, jobs: f.jobs },
    ...overrides,
  };
}

test("reader refuses unusable tokens before any request", () => {
  for (const token of [undefined, "", 7, "a b", "a\nb", "a\x7fb", "x".repeat(4097)]) {
    assert.throws(
      () => createCandidateGitHubReader({ token, fetchImpl: () => assert.fail() }),
      /read-token/,
    );
  }
  assert.throws(() => createCandidateGitHubReader(), /read-token/);
});

test("reader refuses invalid cancellation controls before remote access", () => {
  for (const signal of [null, false, "abort", {}, { aborted: false }]) {
    assert.throws(
      () => createCandidateGitHubReader({ token: TOKEN, signal, fetchImpl: () => assert.fail() }),
      /abort-signal/,
    );
  }
});

for (const operation of ["pull", "ci", "artifact"]) {
  test(`reader refuses already cancelled ${operation} without any request`, async () => {
    const f = fixture();
    const server = api({});
    const instance = createCandidateGitHubReader({
      token: TOKEN,
      signal: AbortSignal.abort(new Error(`${TOKEN} private-url`)),
      fetchImpl: server.fetchImpl,
    });
    const pending =
      operation === "pull"
        ? instance.verifyPullRequest(f.identity)
        : operation === "ci"
          ? instance.verifyCi(f.identity, f.contract)
          : instance.readArtifact(f.identity, f.build);
    await assert.rejects(pending, /^Error: Candidate GitHub refused: request-evidence$/);
    assert.deepEqual(server.keys(), []);
  });
}

for (const source of ["parent", "request-timeout"]) {
  test(`reader refuses ${source} cancellation racing a complete final body`, async (t) => {
    const f = fixture();
    const parent = new AbortController();
    const timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => timeout.signal);
    const server = api({ "": f.repository, "/pulls/42": f.pull });
    const fetchImpl = async (url, init) => {
      const response = await server.fetchImpl(url, init);
      if (url.endsWith("/pulls/42")) {
        const body = Buffer.from(JSON.stringify(f.pull));
        let read = false;
        return {
          status: 200,
          redirected: false,
          headers: response.headers,
          body: {
            getReader() {
              return {
                async read() {
                  if (!read) {
                    read = true;
                    return { done: false, value: body };
                  }
                  return { done: true };
                },
                async cancel() {
                  state.cancelled = true;
                  (source === "parent" ? parent : timeout).abort(new Error(`${TOKEN} private-url`));
                },
                releaseLock() {
                  state.released = true;
                },
              };
            },
          },
        };
      }
      return response;
    };
    const state = { cancelled: false, released: false };
    const instance = createCandidateGitHubReader({
      token: TOKEN,
      fetchImpl,
      signal: parent.signal,
    });
    await assert.rejects(
      instance.verifyPullRequest(f.identity),
      /^Error: Candidate GitHub refused: request-evidence$/,
    );
    assert.deepEqual(state, { cancelled: true, released: true });
    assert.deepEqual(server.keys(), ["", "/pulls/42"]);
    assert.equal(server.calls.at(-1).init.signal.aborted, true);
    await assert.rejects(instance.verifyPullRequest(f.identity), REFUSED);
    assert.deepEqual(server.keys(), ["", "/pulls/42"]);
  });
}

test("reader propagates parent cancellation to an in-flight native-style request", async () => {
  const f = fixture();
  const controller = new AbortController();
  let calls = 0;
  const instance = createCandidateGitHubReader({
    token: TOKEN,
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        controller.abort(new Error(`${TOKEN} private-url`));
      });
    },
  });
  await assert.rejects(instance.verifyPullRequest(f.identity), REFUSED);
  assert.equal(calls, 1);
});

test("PR check reads repository and PR with fixed origin, auth and no redirects", async (t) => {
  const f = fixture();
  const signal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, "timeout", () => signal);
  const server = api({ "": f.repository, "/pulls/42": f.pull });
  const result = await reader(server.fetchImpl).verifyPullRequest(f.identity);
  assert.deepEqual(result, { repository: f.repository, pull: f.pull });
  assert.deepEqual(server.keys(), ["", "/pulls/42"]);
  assert.deepEqual(server.unexpected, []);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments),
    [[10_000], [10_000]],
  );
  for (const { init } of server.calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.signal, signal);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.match(init.headers.Accept, /^application\/vnd\.github\+json$/);
  }
});

test("PR check refuses a malformed identity before any request", async () => {
  const f = fixture();
  const server = api({});
  const broken = structuredClone(f.identity);
  broken.descriptor[4] = "e".repeat(40);
  for (const identity of [
    undefined,
    {},
    broken,
    { ...structuredClone(f.identity), q: "0".repeat(64) },
  ]) {
    await assert.rejects(reader(server.fetchImpl).verifyPullRequest(identity), /refused/);
  }
  assert.equal(server.calls.length, 0);
});

test("PR check refuses live head drift, closed PRs and foreign heads", async () => {
  for (const mutate of [
    (f) => {
      f.pull.head.sha = "e".repeat(40);
    },
    (f) => {
      f.pull.state = "closed";
    },
    (f) => {
      f.pull.head.repo.id = 1235;
    },
  ]) {
    const f = fixture();
    mutate(f);
    const server = api({ "": f.repository, "/pulls/42": f.pull });
    await assert.rejects(
      reader(server.fetchImpl).verifyPullRequest(f.identity),
      /pr-head-or-origin/,
    );
  }
});

test("CI check follows the full sequence and rechecks listing and live PR last", async () => {
  const f = fixture();
  const server = api(ciRoutes(f));
  const result = await reader(server.fetchImpl).verifyCi(f.identity, f.contract);
  assert.deepEqual(result, { q: f.identity.q, runId: "100", runAttempt: "1" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(server.keys(), [
    "",
    "/pulls/42",
    ciList,
    "/actions/runs/100",
    "/actions/runs/100/attempts/1",
    ciJobs,
    "/actions/runs/100",
    ciList,
    "",
    "/pulls/42",
  ]);
  assert.deepEqual(server.unexpected, []);
});

test("CI jobs and run are read for the selected attempt, not the latest", async () => {
  const f = fixture();
  const server = api(ciRoutes(f));
  await reader(server.fetchImpl).verifyCi(f.identity, f.contract);
  assert.ok(server.keys().includes("/actions/runs/100/attempts/1"));
  assert.ok(server.keys().every((key) => !key.includes("/attempts/2")));
  assert.ok(!server.keys().some((key) => key.endsWith("/jobs") || key.includes("filter=latest")));
});

test("CI check does not mutate the caller's identity or contract", async () => {
  const f = fixture();
  const before = JSON.stringify([f.identity, f.contract]);
  await reader(api(ciRoutes(f)).fetchImpl).verifyCi(f.identity, f.contract);
  assert.equal(JSON.stringify([f.identity, f.contract]), before);
});

test("CI check refuses an installed contract without a numeric workflow ID before requests", async () => {
  const f = fixture();
  for (const workflowId of [undefined, 300, "0300", "30x"]) {
    const server = api(ciRoutes(f));
    await assert.rejects(
      reader(server.fetchImpl).verifyCi(f.identity, { ...f.contract, workflowId }),
      /workflow-id/,
    );
    assert.equal(server.calls.length, 0);
  }
});

for (const [label, mutate, pattern] of [
  [
    "a newer run in the first listing",
    (f) => ({ [ciList]: { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 101 }] } }),
    /ci-newer-or-ambiguous-run/,
  ],
  [
    "a newer run that appears in the second listing",
    (f) => ({
      [ciList]: (n) => ({
        total_count: n ? 2 : 1,
        workflow_runs: n ? [f.run, { ...f.run, id: 101 }] : [f.run],
      }),
    }),
    /ci-newer-or-ambiguous-run/,
  ],
  [
    "a second listing that lost the selected run",
    (f) => ({
      [ciList]: (n) => ({ total_count: 1, workflow_runs: [n ? { ...f.run, id: 101 } : f.run] }),
    }),
    /ci-newer-or-ambiguous-run/,
  ],
  [
    "an empty run listing",
    () => ({ [ciList]: { total_count: 0, workflow_runs: [] } }),
    /ci-newer-or-ambiguous-run/,
  ],
  [
    "an attempt record for a newer attempt",
    (f) => ({ "/actions/runs/100/attempts/1": { ...f.run, run_attempt: 2 } }),
    /ci-run/,
  ],
  [
    "a run that is re-run after the jobs were read",
    (f) => ({ "/actions/runs/100": (n) => (n ? { ...f.run, run_attempt: 2 } : f.run) }),
    /ci-run/,
  ],
  [
    "a run whose head drifts after the jobs were read",
    (f) => ({ "/actions/runs/100": (n) => (n ? { ...f.run, head_sha: "e".repeat(40) } : f.run) }),
    /ci-run/,
  ],
  [
    "a run that stops being successful after the jobs were read",
    (f) => ({ "/actions/runs/100": (n) => (n ? { ...f.run, conclusion: "failure" } : f.run) }),
    /ci-run/,
  ],
  [
    "a run with a different head",
    (f) => ({ "/actions/runs/100": { ...f.run, head_sha: "e".repeat(40) } }),
    /ci-run/,
  ],
  [
    "a job from another attempt",
    (f) => ({
      [ciJobs]: { total_count: 2, jobs: [{ ...f.jobs[0], run_attempt: 2 }, f.jobs[1]] },
    }),
    /ci-job-execution/,
  ],
  [
    "a job for another head",
    (f) => ({
      [ciJobs]: { total_count: 2, jobs: [{ ...f.jobs[0], head_sha: "e".repeat(40) }, f.jobs[1]] },
    }),
    /ci-job-execution/,
  ],
  ["a missing job", (f) => ({ [ciJobs]: { total_count: 1, jobs: [f.jobs[0]] } }), /ci-job-count/],
  [
    "a skipped job",
    (f) => ({
      [ciJobs]: { total_count: 2, jobs: [f.jobs[0], { ...f.jobs[1], conclusion: "skipped" }] },
    }),
    /ci-job-execution/,
  ],
  [
    "a duplicate job ID",
    (f) => ({
      [ciJobs]: { total_count: 2, jobs: [f.jobs[0], { ...f.jobs[1], id: f.jobs[0].id }] },
    }),
    /evidence-duplicate-or-id/,
  ],
  [
    "a skipped step",
    (f) => {
      const jobs = structuredClone(f.jobs);
      jobs[1].steps[1].conclusion = "skipped";
      return { [ciJobs]: { total_count: 2, jobs } };
    },
    /ci-heavy-step-execution/,
  ],
  [
    "a missing step",
    (f) => {
      const jobs = structuredClone(f.jobs);
      jobs[0].steps.splice(1, 1);
      return { [ciJobs]: { total_count: 2, jobs } };
    },
    /ci-job-execution/,
  ],
  [
    "a renamed step",
    (f) => {
      const jobs = structuredClone(f.jobs);
      jobs[0].steps[1].name = "Something else";
      return { [ciJobs]: { total_count: 2, jobs } };
    },
    /ci-heavy-step-execution/,
  ],
  [
    "a live PR head that drifts after CI evidence",
    (f) => ({
      "/pulls/42": (n) =>
        n >= 1 ? { ...f.pull, head: { ...f.pull.head, sha: "e".repeat(40) } } : f.pull,
    }),
    /pr-head-or-origin/,
  ],
  [
    "a PR that closes after CI evidence",
    (f) => ({ "/pulls/42": (n) => (n >= 1 ? { ...f.pull, state: "closed" } : f.pull) }),
    /pr-head-or-origin/,
  ],
]) {
  test(`CI check refuses ${label}`, async () => {
    const f = fixture();
    const server = api(ciRoutes(f, mutate(f)));
    await assert.rejects(reader(server.fetchImpl).verifyCi(f.identity, f.contract), pattern);
  });
}

test("CI check re-reads the live PR last, so a drifted PR is the final request", async () => {
  const f = fixture();
  const server = api(
    ciRoutes(f, {
      "/pulls/42": (n) => (n >= 1 ? { ...f.pull, merged: true } : f.pull),
    }),
  );
  await assert.rejects(
    reader(server.fetchImpl).verifyCi(f.identity, f.contract),
    /pr-head-or-origin/,
  );
  assert.equal(server.keys().at(-1), "/pulls/42");
});

function artifactRows(count, template) {
  return Array.from({ length: count }, (_, index) => ({ ...template, id: 700 + index }));
}

test("pagination reads every page with bounded requests and completes totals", async () => {
  const f = fixture();
  const rows = [...artifactRows(100, f.artifact), f.artifact];
  const list = "/actions/runs/500/artifacts?per_page=100&page=";
  const server = api({
    [`${list}1`]: { total_count: 101, artifacts: rows.slice(0, 100) },
    [`${list}2`]: { total_count: 101, artifacts: rows.slice(100) },
    "/actions/artifacts/600": f.artifact,
  });
  const artifact = await reader(server.fetchImpl).readArtifact(f.identity, f.build);
  assert.deepEqual(artifact, f.artifact);
  assert.deepEqual(server.keys(), [`${list}1`, `${list}2`, "/actions/artifacts/600"]);
});

test("pagination never requests more than five pages", async () => {
  const f = fixture();
  const list = "/actions/runs/500/artifacts?per_page=100&page=";
  const routes = {};
  for (let page = 1; page <= 6; page++) {
    routes[`${list}${page}`] = {
      total_count: 500,
      artifacts: artifactRows(100, f.artifact).map((row) => ({ ...row, id: page * 1000 + row.id })),
    };
  }
  const server = api(routes);
  await assert.rejects(
    reader(server.fetchImpl).readArtifact(f.identity, f.build),
    /artifact-missing/,
  );
  assert.equal(server.calls.length, 5);
});

for (const [label, pages, pattern] of [
  ["a total above the bound", (f) => [{ total_count: 501, artifacts: [] }], /page-count/],
  ["a non-numeric total", () => [{ total_count: "1", artifacts: [] }], /page-count/],
  ["a negative total", () => [{ total_count: -1, artifacts: [] }], /page-count/],
  ["a missing total", () => [{ artifacts: [] }], /page-count/],
  [
    "a short first page",
    (f) => [
      { total_count: 101, artifacts: artifactRows(99, f.artifact) },
      { total_count: 101, artifacts: [f.artifact] },
    ],
    /evidence-page-shape/,
  ],
  [
    "a total that changes between pages",
    (f) => [
      { total_count: 101, artifacts: artifactRows(100, f.artifact) },
      { total_count: 102, artifacts: [f.artifact] },
    ],
    /evidence-page-shape/,
  ],
  [
    "a duplicate ID across pages",
    (f) => [
      { total_count: 101, artifacts: artifactRows(100, f.artifact) },
      { total_count: 101, artifacts: [{ ...f.artifact, id: 700 }] },
    ],
    /evidence-duplicate-or-id/,
  ],
  [
    "a non-numeric row ID",
    (f) => [{ total_count: 1, artifacts: [{ ...f.artifact, id: "600" }] }],
    /evidence-duplicate-or-id/,
  ],
  ["a wrong row field", (f) => [{ total_count: 1, jobs: [f.artifact] }], /evidence-page-shape/],
]) {
  test(`pagination refuses ${label}`, async () => {
    const f = fixture();
    const list = "/actions/runs/500/artifacts?per_page=100&page=";
    const routes = Object.fromEntries(pages(f).map((page, index) => [`${list}${index + 1}`, page]));
    const server = api(routes);
    await assert.rejects(reader(server.fetchImpl).readArtifact(f.identity, f.build), pattern);
  });
}

test("transport refuses unexpected paths only through the fixed origin", async () => {
  const f = fixture();
  const server = api({ "": f.repository, "/pulls/42": f.pull });
  await reader(server.fetchImpl).verifyPullRequest(f.identity);
  assert.ok(server.calls.every((call) => call.url.startsWith(`${BASE}`)));
});

test("transport aborts after ten seconds and redacts the cause", async (t) => {
  const f = fixture();
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(`timed out ${TOKEN} ${BASE}`)));
    });
  const pending = reader(fetchImpl).verifyPullRequest(f.identity);
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "Candidate GitHub refused: request-evidence");
    return true;
  });
  assert.equal(timeout.mock.calls[0].arguments[0], 10_000);
});

for (const [label, make] of [
  ["a thrown network error", () => Promise.reject(new Error(`boom ${TOKEN} ${BASE}/pulls/42`))],
  [
    "a 401",
    () =>
      new Response(`{"message":"bad ${TOKEN}"}`, {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "a 404",
    () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
  ],
  [
    "a 500",
    () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
  ],
  [
    "a 301",
    () =>
      new Response("{}", {
        status: 301,
        headers: { location: "https://example.invalid/", "content-type": "application/json" },
      }),
  ],
  ["a 204", () => new Response(null, { status: 204 })],
  [
    "a body-less 200",
    () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    }),
  ],
  [
    "a followed redirect",
    () => ({
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: new Response("{}").body,
    }),
  ],
  ["text/html", () => json("{}", { "content-type": "text/html" })],
  ["a missing content type", () => json("{}", {})],
  ["a lookalike JSON type", () => json("{}", { "content-type": "application/jsonp" })],
  [
    "a non-numeric content length",
    () => json("{}", { "content-type": "application/json", "content-length": "x" }),
  ],
  [
    "a declared oversize length",
    () =>
      json("{}", {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      }),
  ],
  ["invalid JSON", () => json(`{"leak":"${TOKEN}"`)],
  [
    "invalid UTF-8",
    () =>
      new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ],
]) {
  test(`transport refuses ${label} with a redacted diagnostic and no retry`, async () => {
    const f = fixture();
    const calls = [];
    const fetchImpl = (url, init) => {
      calls.push({ url, init });
      return make();
    };
    await assert.rejects(reader(fetchImpl).verifyPullRequest(f.identity), (error) => {
      assert.equal(error.message, "Candidate GitHub refused: request-evidence");
      assert.ok(!error.message.includes(TOKEN));
      assert.equal(String(error), "Error: Candidate GitHub refused: request-evidence");
      assert.equal(error.cause, undefined);
      return true;
    });
    // One credentialed attempt: no retry, no second credential, no fallback.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  });
}

test("transport accepts the GitHub JSON media type with parameters", async () => {
  const f = fixture();
  const server = api({
    "": json(f.repository, { "content-type": "application/vnd.github+json; charset=utf-8" }),
    "/pulls/42": json(f.pull, { "content-type": "Application/JSON" }),
  });
  await reader(server.fetchImpl).verifyPullRequest(f.identity);
});

test("transport cancels streams it refuses before reading to the end", async () => {
  const f = fixture();
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const cases = [
    [
      "oversize stream",
      (state) =>
        new Response(openStream(chunk, state), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "non-200 status",
      (state) =>
        new Response(openStream(chunk, state), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "bad content type",
      (state) =>
        new Response(openStream(chunk, state), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "oversize content length",
      (state) =>
        new Response(openStream(chunk, state), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "3145728" },
        }),
    ],
  ];
  for (const [label, make] of cases) {
    const state = { cancelled: false };
    await assert.rejects(
      reader(() => make(state)).verifyPullRequest(f.identity),
      /request-evidence/,
      label,
    );
    assert.equal(state.cancelled, true, label);
  }
});

test("transport admits a body exactly at the limit but not a byte over", async () => {
  const f = fixture();
  const limit = 2 * 1024 * 1024;
  const pad = (size) =>
    JSON.stringify({
      ...f.repository,
      pad: "x".repeat(size - JSON.stringify({ ...f.repository, pad: "" }).length),
    });
  const ok = pad(limit);
  assert.equal(Buffer.byteLength(ok), limit);
  const server = api({ "": ok, "/pulls/42": f.pull });
  await reader(server.fetchImpl).verifyPullRequest(f.identity);
  const over = api({ "": pad(limit + 1), "/pulls/42": f.pull });
  await assert.rejects(reader(over.fetchImpl).verifyPullRequest(f.identity), /request-evidence/);
});

test("artifact check reads list and detail and returns the consistent metadata", async () => {
  const f = fixture();
  const server = api({
    "/actions/runs/500/artifacts?per_page=100&page=1": { total_count: 1, artifacts: [f.artifact] },
    "/actions/artifacts/600": f.artifact,
  });
  assert.deepEqual(await reader(server.fetchImpl).readArtifact(f.identity, f.build), f.artifact);
  assert.deepEqual(server.unexpected, []);
});

for (const [label, build] of [
  ["a numeric run ID", (b) => ({ ...b, runId: 500 })],
  ["a leading-zero artifact ID", (b) => ({ ...b, artifactId: "0600" })],
  ["a zero attempt", (b) => ({ ...b, runAttempt: "0" })],
  ["a path-shaped artifact ID", (b) => ({ ...b, artifactId: "600/../1" })],
  ["an upper-case digest", (b) => ({ ...b, archiveSha256: "D".repeat(64) })],
  ["a short digest", (b) => ({ ...b, archiveSha256: "d".repeat(63) })],
  ["an unknown key", (b) => ({ ...b, url: "https://example.invalid/" })],
  ["a missing key", ({ runAttempt, ...rest }) => rest],
  ["a non-object", () => null],
]) {
  test(`artifact selection refuses ${label} before any request`, async () => {
    const f = fixture();
    const server = api({});
    await assert.rejects(
      reader(server.fetchImpl).readArtifact(f.identity, build(f.build)),
      /artifact-selection/,
    );
    assert.equal(server.calls.length, 0);
  });
}

for (const [label, mutate, pattern, both] of [
  [
    "a missing artifact",
    (f, list) => {
      list.artifacts = [];
      list.total_count = 0;
    },
    /artifact-missing/,
  ],
  [
    "a duplicated artifact ID",
    (f, list) => {
      list.artifacts = [f.artifact, { ...f.artifact }];
      list.total_count = 2;
    },
    /evidence-duplicate-or-id/,
  ],
  [
    "a string artifact ID",
    (f) => {
      f.artifact.id = "600";
    },
    /evidence-duplicate-or-id/,
    true,
  ],
  [
    "an expired artifact",
    (f) => {
      f.artifact.expired = true;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "an unknown expiry",
    (f) => {
      f.artifact.expired = undefined;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a digest mismatch",
    (f) => {
      f.artifact.digest = `sha256:${"e".repeat(64)}`;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a missing digest",
    (f) => {
      delete f.artifact.digest;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a bare digest",
    (f) => {
      f.artifact.digest = "d".repeat(64);
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a head mismatch",
    (f) => {
      f.artifact.workflow_run.head_sha = "e".repeat(40);
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a run mismatch",
    (f) => {
      f.artifact.workflow_run.id = 501;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a string run ID",
    (f) => {
      f.artifact.workflow_run.id = "500";
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a foreign repository",
    (f) => {
      f.artifact.workflow_run.repository_id = 1235;
    },
    /artifact-provenance/,
    true,
  ],
  [
    "a fork head repository",
    (f) => {
      f.artifact.workflow_run.head_repository_id = 1235;
    },
    /artifact-provenance/,
    true,
  ],
]) {
  test(`artifact check refuses ${label}`, async () => {
    const f = fixture();
    const list = { total_count: 1, artifacts: [f.artifact] };
    mutate(f, list);
    const server = api({
      "/actions/runs/500/artifacts?per_page=100&page=1": both
        ? { total_count: 1, artifacts: [f.artifact] }
        : list,
      "/actions/artifacts/600": f.artifact,
    });
    await assert.rejects(reader(server.fetchImpl).readArtifact(f.identity, f.build), pattern);
  });
}

test("artifact list and detail must each agree with the selection", async () => {
  for (const side of ["list", "detail"]) {
    const f = fixture();
    const drifted = { ...f.artifact, digest: `sha256:${"e".repeat(64)}` };
    const server = api({
      "/actions/runs/500/artifacts?per_page=100&page=1": {
        total_count: 1,
        artifacts: [side === "list" ? drifted : f.artifact],
      },
      "/actions/artifacts/600": side === "detail" ? drifted : f.artifact,
    });
    await assert.rejects(
      reader(server.fetchImpl).readArtifact(f.identity, f.build),
      /artifact-provenance/,
      side,
    );
  }
});

function blobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function wrapBase64(bytes) {
  return `${bytes.toString("base64").replace(/.{60}/g, "$&\n")}\n`;
}

const ROOT_TREE = "1".repeat(40);
const CI_TREE = "2".repeat(40);

// Builds an installed-source world. The inert source would set a global and
// throw if anything ever evaluated it.
function sourceWorld(f, { manifest: editManifest, data: editData } = {}) {
  const sources = [
    {
      path: "ci/run.mjs",
      mode: "100644",
      bytes: Buffer.from(
        "globalThis.__candidateSourceExecuted = true;\nthrow new Error('executed');\n",
      ),
    },
    { path: "top.mjs", mode: "100755", bytes: Buffer.from("export default 12;\n// ?>>\n") },
  ];
  const data = {
    commit: { sha: CONTROLLER, tree: { sha: ROOT_TREE } },
    trees: {
      [ROOT_TREE]: {
        sha: ROOT_TREE,
        truncated: false,
        tree: [
          { path: "ci", type: "tree", mode: "040000", sha: CI_TREE },
          {
            path: "top.mjs",
            type: "blob",
            mode: "100755",
            sha: blobSha(sources[1].bytes),
            size: sources[1].bytes.length,
          },
        ],
      },
      [CI_TREE]: {
        sha: CI_TREE,
        truncated: false,
        tree: [
          {
            path: "run.mjs",
            type: "blob",
            mode: "100644",
            sha: blobSha(sources[0].bytes),
            size: sources[0].bytes.length,
          },
        ],
      },
    },
    contents: Object.fromEntries(
      sources.map((source) => [
        source.path,
        {
          type: "file",
          path: source.path,
          sha: blobSha(source.bytes),
          size: source.bytes.length,
          encoding: "base64",
          content: wrapBase64(source.bytes),
        },
      ]),
    ),
  };
  const manifest = {
    schema: "two.candidate-controller-sources.v1",
    controllerSha: CONTROLLER,
    files: sources.map((source) => ({
      path: source.path,
      gitBlobSha: blobSha(source.bytes),
      sha256: candidateSha256(source.bytes),
      size: source.bytes.length,
    })),
  };
  editManifest?.(manifest);
  editData?.(data);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const server = api({
    [`/git/commits/${CONTROLLER}`]: data.commit,
    [`/git/trees/${ROOT_TREE}`]: data.trees[ROOT_TREE],
    [`/git/trees/${CI_TREE}`]: data.trees[CI_TREE],
    [`/contents/ci/run.mjs?ref=${CONTROLLER}`]: data.contents["ci/run.mjs"],
    [`/contents/top.mjs?ref=${CONTROLLER}`]: data.contents["top.mjs"],
  });
  return {
    sources,
    data,
    manifest,
    manifestBytes,
    digest: candidateSha256(manifestBytes),
    server,
    f,
  };
}

function verifySources(world, { bytes = world.manifestBytes, digest = world.digest } = {}) {
  return reader(world.server.fetchImpl).verifyInstalledSources(world.f.identity, bytes, digest);
}

test("installed sources verify against the pinned manifest and return inert bytes", async () => {
  const world = sourceWorld(fixture());
  const files = await verifySources(world);
  assert.deepEqual(
    files.map((file) => file.path),
    ["ci/run.mjs", "top.mjs"],
  );
  for (const [index, file] of files.entries()) {
    assert.ok(Buffer.isBuffer(file.bytes));
    assert.deepEqual(file.bytes, world.sources[index].bytes);
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "path"]);
  }
  assert.equal(globalThis.__candidateSourceExecuted, undefined);
  assert.deepEqual(world.server.unexpected, []);
  for (const { init } of world.server.calls) assert.equal(init.redirect, "error");
});

test("installed sources are fetched by commit, tree walk and ref-pinned content path", async () => {
  const world = sourceWorld(fixture());
  await verifySources(world);
  assert.deepEqual(world.server.keys(), [
    `/git/commits/${CONTROLLER}`,
    `/git/trees/${ROOT_TREE}`,
    `/git/trees/${CI_TREE}`,
    `/contents/ci/run.mjs?ref=${CONTROLLER}`,
    `/contents/top.mjs?ref=${CONTROLLER}`,
  ]);
});

test("installed sources never evaluate returned source text", async (t) => {
  const world = sourceWorld(fixture());
  const evaluated = t.mock.method(globalThis, "eval", () => assert.fail("eval called"));
  await verifySources(world);
  assert.equal(evaluated.mock.callCount(), 0);
  assert.equal(globalThis.__candidateSourceExecuted, undefined);
});

test("installed manifest must match the digest pinned by the reviewed installation", async () => {
  const world = sourceWorld(fixture());
  for (const digest of ["0".repeat(64), world.digest.toUpperCase(), "", null, `${world.digest}0`]) {
    await assert.rejects(verifySources(world, { digest }), /installed-manifest-digest/);
  }
  const tampered = Buffer.concat([world.manifestBytes, Buffer.from(" ")]);
  await assert.rejects(verifySources(world, { bytes: tampered }), /installed-manifest-digest/);
  assert.equal(world.server.calls.length, 0);
});

test("installed manifest refuses non-buffer, empty and oversize bytes", async () => {
  const world = sourceWorld(fixture());
  const huge = Buffer.alloc(64 * 1024 + 1, 0x20);
  for (const bytes of [
    world.manifestBytes.toString(),
    new Uint8Array(world.manifestBytes),
    Buffer.alloc(0),
    huge,
    null,
  ]) {
    await assert.rejects(
      verifySources(world, {
        bytes,
        digest: Buffer.isBuffer(bytes) ? candidateSha256(bytes) : world.digest,
      }),
      /installed-manifest-digest/,
    );
  }
  assert.equal(world.server.calls.length, 0);
});

test("installed manifest refuses invalid JSON and invalid UTF-8", async () => {
  const world = sourceWorld(fixture());
  for (const bytes of [Buffer.from("{not json"), Buffer.from([0x7b, 0xff, 0x7d])]) {
    await assert.rejects(
      verifySources(world, { bytes, digest: candidateSha256(bytes) }),
      /installed-manifest-json/,
    );
  }
  assert.equal(world.server.calls.length, 0);
});

const longPath = `${"a/".repeat(4)}${"b".repeat(240)}`;
const manifestCases = [
  [
    "a wrong schema",
    (m) => {
      m.schema = "two.candidate-controller-sources.v2";
    },
    /installed-manifest-shape/,
  ],
  [
    "a foreign controller SHA",
    (m) => {
      m.controllerSha = "e".repeat(40);
    },
    /installed-manifest-shape/,
  ],
  [
    "an unknown top-level key",
    (m) => {
      m.extra = true;
    },
    /installed-manifest-shape/,
  ],
  [
    "a missing files key",
    (m) => {
      delete m.files;
    },
    /installed-manifest-shape/,
  ],
  [
    "a non-array files key",
    (m) => {
      m.files = {};
    },
    /installed-manifest-shape/,
  ],
  [
    "no files",
    (m) => {
      m.files = [];
    },
    /installed-manifest-shape/,
  ],
  [
    "too many files",
    (m) => {
      m.files = Array.from({ length: 129 }, (_, i) => ({ ...m.files[0], path: `f${i}.mjs` }));
    },
    /installed-manifest-shape/,
  ],
  [
    "an unknown file key",
    (m) => {
      m.files[0].mode = "100644";
    },
    /installed-file-shape/,
  ],
  [
    "a missing file key",
    (m) => {
      delete m.files[0].size;
    },
    /installed-file-shape/,
  ],
  [
    "a parent path",
    (m) => {
      m.files[0].path = "../ci/run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "an absolute path",
    (m) => {
      m.files[0].path = "/ci/run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "a dot segment",
    (m) => {
      m.files[0].path = "ci/./run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "an empty segment",
    (m) => {
      m.files[0].path = "ci//run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "a trailing slash",
    (m) => {
      m.files[0].path = "ci/run.mjs/";
    },
    /installed-file-shape/,
  ],
  [
    "a backslash path",
    (m) => {
      m.files[0].path = "ci\\run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "a path with a space",
    (m) => {
      m.files[0].path = "ci/run file.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "a non-string path",
    (m) => {
      m.files[0].path = ["ci/run.mjs"];
    },
    /installed-file-shape/,
  ],
  [
    "an over-long path",
    (m) => {
      m.files[0].path = longPath;
    },
    /installed-file-shape/,
  ],
  [
    "a case collision",
    (m) => {
      m.files[1].path = "CI/Run.mjs";
    },
    /installed-file-shape/,
  ],
  [
    "a duplicate path",
    (m) => {
      m.files[1].path = m.files[0].path;
    },
    /installed-file-shape/,
  ],
  [
    "an upper-case blob SHA",
    (m) => {
      m.files[0].gitBlobSha = m.files[0].gitBlobSha.toUpperCase();
    },
    /installed-file-shape/,
  ],
  [
    "a short sha256",
    (m) => {
      m.files[0].sha256 = "a".repeat(63);
    },
    /installed-file-shape/,
  ],
  [
    "a negative size",
    (m) => {
      m.files[0].size = -1;
    },
    /installed-file-shape/,
  ],
  [
    "a fractional size",
    (m) => {
      m.files[0].size = 1.5;
    },
    /installed-file-shape/,
  ],
  [
    "a string size",
    (m) => {
      m.files[0].size = "10";
    },
    /installed-file-shape/,
  ],
  [
    "a file over the per-file bound",
    (m) => {
      m.files[0].size = 512 * 1024 + 1;
    },
    /installed-file-shape/,
  ],
  [
    "a total over the aggregate bound",
    (m) => {
      m.files = Array.from({ length: 9 }, (_, i) => ({
        ...m.files[0],
        path: `f${i}.mjs`,
        size: 512 * 1024,
      }));
    },
    /installed-source-size/,
  ],
];

for (const [label, mutate, pattern] of manifestCases) {
  test(`installed manifest refuses ${label} before any request`, async () => {
    const world = sourceWorld(fixture(), { manifest: mutate });
    await assert.rejects(verifySources(world), pattern);
    assert.equal(world.server.calls.length, 0);
  });
}

test("exact aggregate source bound is admitted before tree membership checking", async () => {
  // Eight 512 KiB files total exactly 4 MiB. Their absent tree membership, not
  // the size gate, must cause refusal after the commit and root-tree reads.
  const world = sourceWorld(fixture(), {
    manifest(m) {
      m.files = Array.from({ length: 8 }, (_, i) => ({
        ...m.files[0],
        path: `f${i}.mjs`,
        size: 512 * 1024,
      }));
    },
  });
  await assert.rejects(verifySources(world), /installed-tree-entry$/);
  assert.deepEqual(world.server.keys(), [`/git/commits/${CONTROLLER}`, `/git/trees/${ROOT_TREE}`]);
});

const dataCases = [
  [
    "a commit SHA mismatch",
    (d) => {
      d.commit.sha = "e".repeat(40);
    },
    /installed-commit/,
  ],
  [
    "a commit without a tree",
    (d) => {
      d.commit.tree = {};
    },
    /installed-commit/,
  ],
  [
    "a tree SHA mismatch",
    (d) => {
      d.trees[ROOT_TREE].sha = "e".repeat(40);
    },
    /installed-tree/,
  ],
  [
    "a truncated tree",
    (d) => {
      d.trees[ROOT_TREE].truncated = true;
    },
    /installed-tree/,
  ],
  [
    "a missing truncation flag",
    (d) => {
      delete d.trees[ROOT_TREE].truncated;
    },
    /installed-tree/,
  ],
  [
    "an oversize tree",
    (d) => {
      d.trees[CI_TREE].tree.push(
        ...Array.from({ length: 4096 }, (_, i) => ({ path: `n${i}`, type: "blob" })),
      );
    },
    /installed-tree/,
  ],
  [
    "a missing tree entry",
    (d) => {
      d.trees[CI_TREE].tree = [];
    },
    /installed-tree-entry/,
  ],
  [
    "a duplicate tree entry",
    (d) => {
      d.trees[CI_TREE].tree.push({ ...d.trees[CI_TREE].tree[0] });
    },
    /installed-tree-entry/,
  ],
  [
    "a symlink entry",
    (d) => {
      d.trees[CI_TREE].tree[0].mode = "120000";
    },
    /installed-file-mode/,
  ],
  [
    "a submodule entry",
    (d) => {
      Object.assign(d.trees[CI_TREE].tree[0], { mode: "160000", type: "commit" });
    },
    /installed-file-mode/,
  ],
  [
    "a group-writable mode",
    (d) => {
      d.trees[CI_TREE].tree[0].mode = "100664";
    },
    /installed-file-mode/,
  ],
  [
    "a directory where a blob is expected",
    (d) => {
      Object.assign(d.trees[CI_TREE].tree[0], { type: "tree", mode: "040000" });
    },
    /installed-file-mode/,
  ],
  [
    "a blob where a directory is expected",
    (d) => {
      Object.assign(d.trees[ROOT_TREE].tree[0], { type: "blob", mode: "100644" });
    },
    /installed-directory-mode/,
  ],
  [
    "a symlinked directory",
    (d) => {
      d.trees[ROOT_TREE].tree[0].mode = "120000";
    },
    /installed-directory-mode/,
  ],
  [
    "a tree blob SHA mismatch",
    (d) => {
      d.trees[CI_TREE].tree[0].sha = "e".repeat(40);
    },
    /installed-file-mode/,
  ],
  [
    "a tree size mismatch",
    (d) => {
      d.trees[CI_TREE].tree[0].size += 1;
    },
    /installed-file-mode/,
  ],
  [
    "a non-file content type",
    (d) => {
      d.contents["top.mjs"].type = "symlink";
    },
    /installed-file-response/,
  ],
  [
    "a content path mismatch",
    (d) => {
      d.contents["top.mjs"].path = "other.mjs";
    },
    /installed-file-response/,
  ],
  [
    "a content SHA mismatch",
    (d) => {
      d.contents["top.mjs"].sha = "e".repeat(40);
    },
    /installed-file-response/,
  ],
  [
    "a content size mismatch",
    (d) => {
      d.contents["top.mjs"].size += 1;
    },
    /installed-file-response/,
  ],
  [
    "a non-base64 encoding",
    (d) => {
      d.contents["top.mjs"].encoding = "none";
    },
    /installed-file-response/,
  ],
  [
    "a non-string content",
    (d) => {
      d.contents["top.mjs"].content = null;
    },
    /installed-file-response/,
  ],
  [
    "a symlink target field",
    (d) => {
      d.contents["top.mjs"].target = "../secret";
    },
    /installed-file-response/,
  ],
  [
    "a submodule URL",
    (d) => {
      d.contents["top.mjs"].submodule_git_url = "https://example.invalid/x.git";
    },
    /installed-file-response/,
  ],
  [
    "a non-canonical unpadded base64",
    (d) => {
      const c = d.contents["top.mjs"];
      assert.match(c.content, /=\n$/);
      c.content = c.content.replace(/=*\n?$/, "");
    },
    /installed-file-digest/,
  ],
  [
    "base64 with trailing junk",
    (d) => {
      d.contents["top.mjs"].content += "!!";
    },
    /installed-file-digest/,
  ],
  [
    "base64 with embedded spaces",
    (d) => {
      d.contents["top.mjs"].content = d.contents["top.mjs"].content.replace(/^(.{4})/, "$1 ");
    },
    /installed-file-digest/,
  ],
  [
    "a url-safe base64 alphabet",
    (d) => {
      const standard = d.contents["top.mjs"].content.replaceAll("\n", "");
      assert.match(standard, /[+/]/, "fixture must exercise the alphabet difference");
      d.contents["top.mjs"].content = standard.replaceAll("+", "-").replaceAll("/", "_");
    },
    /installed-file-digest/,
  ],
  [
    "same-size content with a different digest",
    (d) => {
      const bytes = Buffer.from("export default 13;\n// ?>>\n");
      d.contents["top.mjs"].content = wrapBase64(bytes);
    },
    /installed-file-digest/,
  ],
];

for (const [label, mutate, pattern] of dataCases) {
  test(`installed sources refuse ${label}`, async () => {
    const world = sourceWorld(fixture(), { data: mutate });
    await assert.rejects(verifySources(world), pattern);
    assert.equal(globalThis.__candidateSourceExecuted, undefined);
  });
}

test("installed sources check the SHA-1 blob ID, SHA-256 and size independently", async () => {
  // Content hashes to the manifest sha256 only if the bytes are unchanged, and
  // to the Git blob ID only if the size header agrees; each manifest field is
  // tampered alone while the API data remains self-consistent.
  for (const field of ["gitBlobSha", "sha256", "size"]) {
    const world = sourceWorld(fixture(), {
      manifest(m) {
        m.files[1][field] =
          field === "size"
            ? m.files[1].size + 1
            : field === "sha256"
              ? "e".repeat(64)
              : "e".repeat(40);
      },
    });
    await assert.rejects(verifySources(world), /refused/, field);
  }
});

test("installed source failures redact credentials, URLs and source text", async () => {
  const world = sourceWorld(fixture(), {
    data(d) {
      d.contents["top.mjs"].content = wrapBase64(Buffer.from(`secret ${TOKEN}`));
    },
  });
  await assert.rejects(verifySources(world), (error) => {
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes("secret"));
    assert.equal(String(error), "Error: Candidate GitHub refused: installed-file-digest");
    assert.match(String(error), REFUSED);
    return true;
  });
});

test("installed source requests never leave the repository-local path", async () => {
  const world = sourceWorld(fixture());
  await verifySources(world);
  for (const { url, init } of world.server.calls) {
    assert.ok(url.startsWith(`${BASE}/`));
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});
