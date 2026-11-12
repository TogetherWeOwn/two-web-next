import assert from "node:assert/strict";
import { test } from "node:test";
import { stagingObservations, staleStagingKeys } from "./incident-staging-observation.mjs";

const source = (id, runAttempt = 1, extra = {}) => ({
  id,
  run_number: id,
  run_attempt: runAttempt,
  head_branch: "main",
  head_repository: { full_name: "TogetherWeOwn/two-web-next" },
  path: ".github/workflows/e2e-staging.yml",
  status: "completed",
  ...extra,
});
const gates = (quality, journeys = quality) => [
  { name: "staging-quality / web-quality", conclusion: quality },
  { name: "staging-journeys", conclusion: journeys },
];

function fixture({ workflowRuns, jobsByAttempt = {}, intercept } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const overridden = intercept?.(method, path, body);
    if (overridden !== undefined) return overridden;
    if (method !== "GET") throw new Error(`Unexpected fixture call: ${method} ${path}`);
    if (path.startsWith("/actions/workflows/e2e-staging.yml/runs?"))
      return { workflow_runs: await Promise.resolve(workflowRuns) };
    const jobs = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path);
    if (jobs) {
      const key = `${jobs[1]}/${jobs[2]}`;
      return { jobs: await Promise.resolve(key in jobsByAttempt ? jobsByAttempt[key] : []) };
    }
    throw new Error(`Unexpected fixture call: ${method} ${path}`);
  };
  return { api, calls };
}

// Current run identity is always the observed source attempt; newer or later
// attempts of the same source run are read from authoritative history.
const observe = (api, { id = 42, runAttempt = 1, attempt = 1 } = {}) =>
  staleStagingKeys(api, source(id, runAttempt), String(id), String(attempt));

test("staging replay freshness rejects old observations without suppressing useful failures", async () => {
  const replay = (newerJobs, { sameRun = false, newer = {}, intercept } = {}) =>
    fixture({
      workflowRuns: sameRun ? [source(42, 2)] : [{ ...source(43), ...newer }, source(42)],
      jobsByAttempt: { [`${sameRun ? "42/2" : "43/1"}`]: newerJobs },
      intercept,
    });
  for (const sameRun of [false, true]) {
    const newerRed = replay(gates("failure"), { sameRun });
    assert.deepEqual(
      [...(await observe(newerRed.api, sameRun ? { runAttempt: 2, attempt: 1 } : {}))].sort(),
      ["e2e-staging", "staging-journeys", "staging-quality"],
      "old green is stale against newer red on both run boundaries",
    );
    const newerGreen = replay(gates("success"), { sameRun });
    assert.deepEqual(
      [...(await observe(newerGreen.api, sameRun ? { runAttempt: 2, attempt: 1 } : {}))].sort(),
      ["e2e-staging", "staging-journeys", "staging-quality"],
      "old red is stale against newer green on both run boundaries",
    );
  }
  for (const newerJobs of [gates("skipped"), gates(null), gates("success", "skipped")]) {
    const useful = replay(newerJobs);
    const stale = await observe(useful.api);
    assert.equal(
      stale.has("staging-journeys"),
      newerJobs[1].conclusion === "success",
      "skipped or inconclusive newer journeys keep the older journeys failure useful",
    );
    assert.equal(
      stale.has("e2e-staging"),
      newerJobs.every((job) => job.conclusion === "success"),
      "a non-executing newer run is not aggregate recovery",
    );
    assert.equal(
      stale.has("staging-quality"),
      newerJobs[0].conclusion === "success",
      "only an executed newer green retires the quality failure",
    );
  }
  for (const status of ["queued", "in_progress", "waiting"]) {
    const pending = replay(gates("success"), { newer: { status } });
    const stale = await observe(pending.api);
    assert.equal(
      stale.size,
      0,
      "unfinished newer runs cannot hide the current failure observation",
    );
  }
  const previousAttempt = fixture({
    workflowRuns: [source(43, 2), source(42)],
    jobsByAttempt: { "43/2": gates("skipped"), "43/1": gates("failure") },
  });
  const staleRetry = await observe(previousAttempt.api);
  assert.deepEqual(
    [...staleRetry].sort(),
    ["e2e-staging", "staging-journeys", "staging-quality"],
    "a skipped retry does not erase the newer earlier-attempt failure evidence",
  );
  const secondPage = fixture({
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/actions/workflows/"))
        return {
          workflow_runs: path.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, i) => source(i + 43))
            : [source(42)],
        };
      if (
        method === "GET" &&
        /\/actions\/runs\/\d+\/attempts\/1\/jobs\?/.test(path) &&
        !path.includes("/runs/42/")
      )
        return { jobs: gates("failure") };
      return { jobs: [] };
    },
  });
  const pagedStale = await observe(secondPage.api);
  assert.equal(pagedStale.size, 3, "determinate observations stop the history read early");
  assert.ok(
    secondPage.calls.some(
      (call) => call.path.startsWith("/actions/workflows/") && call.path.endsWith("page=2"),
    ),
    "history paging continues past a full first page until the source is found",
  );
  for (const newer of [
    { head_branch: "feature" },
    { head_repository: { full_name: "untrusted/fork" } },
    { path: ".github/workflows/other.yml" },
  ]) {
    const untrusted = replay(gates("success"), { newer });
    const stale = await observe(untrusted.api);
    assert.equal(stale.size, 0, "untrusted runs cannot hide current failures");
  }
  for (const result of [
    null,
    { workflow_runs: null },
    { workflow_runs: [source(43, 0)] },
    { workflow_runs: [] },
  ]) {
    const bad = fixture({
      intercept(method, path) {
        if (method === "GET" && path.startsWith("/actions/workflows/"))
          return result === null ? Promise.reject(new Error("history unavailable")) : result;
      },
    });
    await assert.rejects(observe(bad.api));
  }
  const capped = fixture({
    workflowRuns: [source(43, 21), source(42)],
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/actions/runs/43/attempts/"))
        return { jobs: gates("skipped") };
    },
  });
  await assert.rejects(observe(capped.api), /history.*cap/i);
  const atCap = fixture({
    workflowRuns: [source(43, 20), source(42)],
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/actions/runs/43/attempts/"))
        return { jobs: gates("skipped") };
    },
  });
  assert.equal(
    (await observe(atCap.api)).size,
    0,
    "exactly 20 snapshots succeeds; the cap rejects only the 21st",
  );
  const fullJobsPage = fixture({
    workflowRuns: [source(42), source(43)],
    intercept(method, path) {
      if (method === "GET" && path.includes("/runs/43/attempts/1/jobs?")) {
        if (path.endsWith("page=1"))
          return {
            jobs: Array.from({ length: 100 }, (_, i) => ({
              name: `unit-${i}`,
              conclusion: "skipped",
            })),
          };
        return { jobs: [{ name: "staging-journeys", conclusion: "failure" }] };
      }
    },
  });
  const pagedJobs = await observe(fullJobsPage.api);
  assert.ok(
    pagedJobs.has("staging-journeys") && pagedJobs.has("e2e-staging"),
    "a full 100-job page continues to a short final page that still yields observations",
  );
  assert.ok(
    fullJobsPage.calls.some(
      (call) => call.path.includes("/runs/43/attempts/1/jobs?") && call.path.endsWith("page=2"),
    ),
    "the second jobs page was read",
  );
});

test("staging observations report per-key determinate evidence without partial aggregate recovery", () => {
  assert.deepEqual([...stagingObservations(gates("success"))].sort(), [
    "e2e-staging",
    "staging-journeys",
    "staging-quality",
  ]);
  const mixed = stagingObservations([
    ...gates("success"),
    { name: "staging-quality / extra", conclusion: "skipped" },
  ]);
  assert.ok(mixed.has("staging-journeys"), "an all-green gate is a determinate observation");
  assert.equal(
    mixed.has("staging-quality"),
    false,
    "one skipped matrix leg keeps the gate's success from being determinate",
  );
  assert.equal(mixed.has("e2e-staging"), false, "partial gate success is not aggregate recovery");
  assert.deepEqual(
    [...stagingObservations(gates("failure", "skipped"))].sort(),
    ["e2e-staging", "staging-quality"],
    "one red job marks the aggregate without inventing a skipped-gate observation",
  );
});

test("staging observation identity and job pagination stay bounded and fail closed", async () => {
  for (const [mutate, runId, attempt] of [
    [(run) => ({ ...run, id: 0 }), "42", "1"],
    [(run) => ({ ...run, run_number: 0 }), "42", "1"],
    [(run) => ({ ...run, run_attempt: 0 }), "42", "1"],
    [(run) => run, "43", "1"],
    [(run) => run, "42", "0"],
    [(run) => ({ ...run, run_attempt: 0 }), "42", "1"],
    [(run) => run, "42", "3"],
  ]) {
    const api = async () => {
      throw new Error("unreachable");
    };
    await assert.rejects(
      staleStagingKeys(api, mutate(source(42)), runId, attempt),
      /Invalid staging observation identity/,
    );
  }
  const renamed = fixture({
    workflowRuns: [source(42)],
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/actions/workflows/"))
        return { workflow_runs: [{ ...source(42), run_number: 44 }] };
    },
  });
  await assert.rejects(observe(renamed.api), /Inconsistent staging observation identity/);
  const duplicated = fixture({
    workflowRuns: [{ ...source(42), id: 77 }, source(42)],
  });
  await assert.rejects(observe(duplicated.api), /Inconsistent staging observation sequence/);
  const missing = fixture({ workflowRuns: [] });
  await assert.rejects(observe(missing.api), /missing source|page cap/i);
  const malformedJobs = fixture({
    workflowRuns: [source(42), source(43)],
    jobsByAttempt: { "43/1": null },
  });
  await assert.rejects(observe(malformedJobs.api), /Malformed release jobs/);
  const paged = fixture({
    workflowRuns: [source(42), source(43)],
    intercept(method, path) {
      if (method === "GET" && path.includes("/runs/43/attempts/1/jobs?"))
        return { jobs: Array.from({ length: 100 }, () => ({ conclusion: "skipped" })) };
    },
  });
  await assert.rejects(observe(paged.api), /page cap/i);
});
