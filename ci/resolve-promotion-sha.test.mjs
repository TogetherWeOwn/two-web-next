import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stagingQualityJob, stagingQualitySteps } from "./production-deploy-gate.mjs";
import { resolvePromotionSha } from "./resolve-promotion-sha.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TIP = "f".repeat(40);

// Step fixtures for the staging-quality job, named from the deploy gate's own
// constants so a rename in the gate (or a stale literal in the resolver) breaks here.
const lhSteps = (conclusions) =>
  stagingQualitySteps.map((name, i) => ({ name, conclusion: conclusions[i] ?? "success" }));

// runs: newest first, as the API returns them; jobs: run id -> staging-journeys conclusion, or
// { journeys, quality, qualitySteps, qualityJobs } (quality defaults to success with both
// Lighthouse steps executed successfully; null leaves the job out, like runs before the gate existed).
function stub(runs, jobs) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      assert.equal(searchParams.get("branch"), "main");
      assert.equal(searchParams.get("event"), "workflow_run");
      assert.equal(
        searchParams.get("status"),
        null,
        "never hide failed runs behind a success filter",
      );
      const page = Number(searchParams.get("page"));
      const size = Number(searchParams.get("per_page"));
      return {
        ok: true,
        json: async () => ({ workflow_runs: runs.slice((page - 1) * size, page * size) }),
      };
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      const spec =
        typeof jobs[id] === "object" && jobs[id] !== null ? jobs[id] : { journeys: jobs[id] };
      const quality = "quality" in spec ? spec.quality : "success";
      const qualitySteps = "qualitySteps" in spec ? spec.qualitySteps : lhSteps([]);
      const qualityJobs = spec.qualityJobs ?? (quality ? 1 : 0);
      const list = [];
      if (spec.journeys) list.push({ name: "staging-journeys", conclusion: spec.journeys });
      for (let i = 0; i < qualityJobs; i++) {
        list.push({ name: stagingQualityJob, conclusion: quality, steps: qualitySteps });
      }
      return { ok: true, json: async () => ({ jobs: list }) };
    }
    assert.fail(`unexpected ${pathname}`);
  };
}
const OLD_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const run = (id, deployed, conclusion = "success", status = "completed", updated_at = OLD_AT) => ({
  id,
  // API head_sha is main's tip for workflow_run runs; only the run-name names the deployed commit.
  head_sha: TIP,
  display_title: `e2e-staging deploy ${deployed}`,
  status,
  conclusion,
  updated_at,
});
const resolve = (runs, jobs, nowMs) =>
  resolvePromotionSha({
    repository: "o/r",
    token: "t",
    fetchImpl: stub(runs, jobs),
    ...(nowMs ? { nowMs } : {}),
  });

test("promotes the deployed commit from the run-name, not the run's head_sha", async () => {
  assert.equal(await resolve([run(2, A)], { 2: "success" }), A);
});

test("skips a commit whose journeys were skipped and takes the newest verified one", async () => {
  assert.equal(await resolve([run(3, A), run(2, B)], { 3: "skipped", 2: "success" }), B);
});

test("a newer failed run of a commit is not outvoted by an older pass of the same commit", async () => {
  // Automatic promotion never rides an older green while staging is red: the
  // newer failure blocks every older candidate (manual dispatch with an
  // explicit sha still promotes B through the exact-SHA gate).
  assert.equal(
    await resolve([run(3, A, "failure"), run(2, A), run(1, B)], { 2: "success", 1: "success" }),
    null,
  );
});

test("a newer unfinished run blocks an older pass of the same commit", async () => {
  assert.equal(
    await resolve([run(3, A, null, "in_progress"), run(2, A), run(1, B)], {
      2: "success",
      1: "success",
    }),
    B,
  );
});

test("every unfinished state of the newest run blocks an older pass of its commit", async () => {
  for (const status of ["queued", "waiting", "requested", "pending", "in_progress"]) {
    assert.equal(
      await resolve([run(3, A, null, status), run(2, A), run(1, B)], {
        2: "success",
        1: "success",
      }),
      B,
      status,
    );
  }
});

test("an unfinished run is not promotable even while it carries a success conclusion", async () => {
  assert.equal(
    await resolve([run(3, A, "success", "in_progress"), run(2, A), run(1, B)], {
      3: "success",
      2: "success",
      1: "success",
    }),
    B,
  );
});

test("a commit whose only verification is unfinished is not promoted", async () => {
  assert.equal(await resolve([run(2, A, null, "queued")], {}), null);
});

test("an unfinished run on an earlier page still blocks an older pass on a later page", async () => {
  const filler = Array.from({ length: 19 }, (_, i) => ({
    ...run(100 + i, A),
    display_title: "e2e-staging",
  }));
  assert.equal(
    await resolve([...filler, run(3, A, null, "in_progress"), run(2, A), run(1, B)], {
      2: "success",
      1: "success",
    }),
    B,
  );
});

test("a newer completed pass is not blocked by an older unfinished run of its commit", async () => {
  assert.equal(await resolve([run(3, A), run(2, A, null, "in_progress")], { 3: "success" }), A);
});

test("runs without a deployed SHA in their name (pre run-name) are ignored", async () => {
  const old = { ...run(5, A), display_title: "e2e-staging" };
  assert.equal(await resolve([old], { 5: "success" }), null);
});

test("deploy.yml and e2e-staging.yml run-names carry the deployed SHA", () => {
  const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const e2e = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    deploy,
    /^run-name: deploy \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}$/m,
  );
  assert.match(
    e2e,
    /^run-name: e2e-staging \$\{\{ github\.event\.workflow_run\.display_title \|\| github\.sha \}\}$/m,
  );
});

test("deploy-production resolves through this script and gates the resolved DEPLOY_SHA", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /run: node ci\/resolve-promotion-sha\.mjs\n/);
  assert.ok(!workflow.includes("e2e-staging.yml/runs"), "no inline resolver left");
});

test("a deploy whose web quality gate failed is never promoted", async () => {
  assert.equal(
    await resolve([run(3, A), run(2, B)], {
      3: { journeys: "success", quality: "failure" },
      2: "success",
    }),
    B,
  );
});

test("a deploy without the web quality gate (older runs) is not promotable", async () => {
  assert.equal(await resolve([run(2, A)], { 2: { journeys: "success", quality: null } }), null);
});

// Executed-steps contract: the production deploy gate refuses a green
// staging-quality job whose Lighthouse steps did not execute and pass, so the
// resolver must not select a SHA the gate will refuse. A job-level success
// with skipped/failed/absent Lighthouse steps is ineligible evidence and the
// resolver falls through to an older eligible SHA (or null), like other
// valid ineligibility above.

test("a green quality job whose Lighthouse steps were skipped falls through to the older eligible SHA", async () => {
  assert.equal(
    await resolve([run(3, A), run(2, B)], {
      3: {
        journeys: "success",
        quality: "success",
        qualitySteps: lhSteps(["skipped", "skipped"]),
      },
      2: "success",
    }),
    B,
  );
});

test("either Lighthouse step skipped alone blocks resolution", async () => {
  for (const skipped of stagingQualitySteps) {
    const steps = stagingQualitySteps.map((name) => ({
      name,
      conclusion: name === skipped ? "skipped" : "success",
    }));
    assert.equal(
      await resolve([run(2, A)], {
        2: { journeys: "success", quality: "success", qualitySteps: steps },
      }),
      null,
      skipped,
    );
  }
});

test("a green quality job with a failed Lighthouse step does not resolve", async () => {
  for (const steps of [lhSteps(["failure", "success"]), lhSteps(["success", "failure"])]) {
    assert.equal(
      await resolve([run(2, A)], {
        2: { journeys: "success", quality: "success", qualitySteps: steps },
      }),
      null,
      JSON.stringify(steps),
    );
  }
});

test("a green quality job with no Lighthouse step evidence does not resolve", async () => {
  for (const qualitySteps of [[], undefined]) {
    assert.equal(
      await resolve([run(2, A)], {
        2: { journeys: "success", quality: "success", qualitySteps },
      }),
      null,
      `steps=${JSON.stringify(qualitySteps)}`,
    );
  }
});

test("ambiguous staging-quality evidence (two quality jobs) falls through to the older eligible SHA", async () => {
  assert.equal(
    await resolve([run(3, A), run(2, B)], {
      3: { journeys: "success", quality: "success", qualityJobs: 2 },
      2: "success",
    }),
    B,
  );
});

test("quality job/step names stay pinned to the deploy gate, and executed steps resolve while skipped steps do not", async () => {
  assert.equal(stagingQualityJob, "staging-quality / quality");
  assert.deepEqual(stagingQualitySteps, [
    "Lighthouse performance budgets (mobile, ci/lighthouserc.cjs)",
    "Lighthouse quality scores (desktop, categories vs ci/quality-budget.json)",
  ]);
  // Positive control: exactly one quality job, both Lighthouse steps success
  // (unrelated extra steps do not matter) still resolves.
  assert.equal(
    await resolve([run(2, A)], {
      2: {
        journeys: "success",
        quality: "success",
        qualitySteps: [{ name: "Check out repository", conclusion: "success" }, ...lhSteps([])],
      },
    }),
    A,
  );
  // The same run with a skipped Lighthouse step must not resolve.
  assert.equal(
    await resolve([run(2, A)], {
      2: {
        journeys: "success",
        quality: "success",
        qualitySteps: lhSteps(["skipped", "success"]),
      },
    }),
    null,
  );
});

// Evidence-failure refusal contract: HTTP, transport, and decoding failures must
// reject instead of silently falling back to an older SHA or null. Test-only pin
// of ci/resolve-promotion-sha.mjs:47-59; no promotion-policy change.
const EVIDENCE_HTTP_STATUSES = [401, 403, 429, 500];

function failingRunsFetch(status, requested) {
  return async (url) => {
    const { pathname } = new URL(url);
    requested.push(pathname);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      return { ok: false, status, json: async () => ({}) };
    }
    assert.fail(`no job lookup should occur after workflow-list HTTP ${status}`);
  };
}

function failingJobsFetch(runsList, status, requestedJobIds) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      const page = Number(searchParams.get("page"));
      const size = Number(searchParams.get("per_page"));
      return {
        ok: true,
        json: async () => ({ workflow_runs: runsList.slice((page - 1) * size, page * size) }),
      };
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      requestedJobIds.push(id);
      if (id === "3") return { ok: false, status, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { name: "staging-journeys", conclusion: "success" },
            { name: "staging-quality / quality", conclusion: "success" },
          ],
        }),
      };
    }
    assert.fail(`unexpected ${pathname}`);
  };
}

test("workflow-list HTTP failures refuse promotion selection without a job lookup", async () => {
  for (const status of EVIDENCE_HTTP_STATUSES) {
    const requested = [];
    await assert.rejects(
      resolvePromotionSha({
        repository: "o/r",
        token: "t",
        fetchImpl: failingRunsFetch(status, requested),
      }),
      new RegExp(`Promotion lookup failed \\(HTTP ${status}\\)`),
      `workflow-list HTTP ${status}`,
    );
    assert.deepEqual(
      requested,
      ["/repos/o/r/actions/workflows/e2e-staging.yml/runs"],
      `no job lookup after workflow-list HTTP ${status}`,
    );
  }
});

test("per-run job-list HTTP failures refuse promotion instead of falling back to the older SHA", async () => {
  for (const status of EVIDENCE_HTTP_STATUSES) {
    const runs = [run(3, A), run(2, B)];
    const requestedJobIds = [];
    await assert.rejects(
      resolvePromotionSha({
        repository: "o/r",
        token: "t",
        fetchImpl: failingJobsFetch(runs, status, requestedJobIds),
      }),
      new RegExp(`Promotion lookup failed \\(HTTP ${status}\\)`),
      `job-list HTTP ${status}`,
    );
    assert.deepEqual(
      requestedJobIds,
      ["3"],
      `older SHA must not be looked up after newest job-list HTTP ${status}`,
    );
  }
  // Positive control: the same evidence with successful lookups selects the newest
  // deployed run-name SHA, and valid ineligibility (not transport failure) falls back.
  assert.equal(await resolve([run(3, A), run(2, B)], { 3: "success", 2: "success" }), A);
  assert.equal(
    await resolve([run(3, A), run(2, B)], {
      3: { journeys: "failure", quality: "success" },
      2: "success",
    }),
    B,
    "valid failure evidence for the newest candidate still falls back to the older SHA",
  );
});

test("a later workflow-list page failure refuses selection instead of returning null", async () => {
  const newestUnfinished = run(3, A, null, "in_progress");
  const olderEligible = run(2, B);
  const failingPageTwo = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      if (searchParams.get("page") === "2")
        return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ workflow_runs: [newestUnfinished] }) };
    }
    assert.fail("no job lookup should occur when the later workflow-list page fails");
  };
  await assert.rejects(
    resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl: failingPageTwo }),
    /Promotion lookup failed \(HTTP 500\)/,
  );
  // Positive control: the same two pages with a successful second page select the
  // older deployed run-name SHA once the newest is unfinished.
  const succeedingPageTwo = stub([newestUnfinished, olderEligible], { 2: "success" });
  assert.equal(
    await resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl: succeedingPageTwo }),
    B,
  );
});

test("fetch rejection refuses promotion selection on both lookups", async () => {
  const runsFetchRejected = [];
  await assert.rejects(
    resolvePromotionSha({
      repository: "o/r",
      token: "t",
      fetchImpl: async (url) => {
        runsFetchRejected.push(new URL(url).pathname);
        throw new TypeError("fetch failed");
      },
    }),
    /fetch failed/,
  );
  assert.deepEqual(runsFetchRejected, ["/repos/o/r/actions/workflows/e2e-staging.yml/runs"]);

  const requestedJobIds = [];
  const jobsFetchRejected = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      const page = Number(searchParams.get("page"));
      const size = Number(searchParams.get("per_page"));
      const runs = [run(3, A), run(2, B)];
      return {
        ok: true,
        json: async () => ({ workflow_runs: runs.slice((page - 1) * size, page * size) }),
      };
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      requestedJobIds.push(id);
      throw new TypeError("fetch failed");
    }
    assert.fail(`unexpected ${pathname}`);
  };
  await assert.rejects(
    resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl: jobsFetchRejected }),
    /fetch failed/,
  );
  assert.deepEqual(requestedJobIds, ["3"], "older SHA must not be looked up after fetch rejection");
});

test("JSON decoding rejection refuses promotion selection on both lookups", async () => {
  await assert.rejects(
    resolvePromotionSha({
      repository: "o/r",
      token: "t",
      fetchImpl: async (url) => {
        const { pathname } = new URL(url);
        if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
          return {
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token in JSON");
            },
          };
        }
        assert.fail("no job lookup should occur after workflow-list JSON failure");
      },
    }),
    /Unexpected token in JSON/,
  );

  const requestedJobIds = [];
  const jobsJsonRejected = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      const page = Number(searchParams.get("page"));
      const size = Number(searchParams.get("per_page"));
      const runs = [run(3, A), run(2, B)];
      return {
        ok: true,
        json: async () => ({ workflow_runs: runs.slice((page - 1) * size, page * size) }),
      };
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      requestedJobIds.push(id);
      if (id === "3") {
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError("Unexpected token in JSON");
          },
        };
      }
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { name: "staging-journeys", conclusion: "success" },
            { name: "staging-quality / quality", conclusion: "success" },
          ],
        }),
      };
    }
    assert.fail(`unexpected ${pathname}`);
  };
  await assert.rejects(
    resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl: jobsJsonRejected }),
    /Unexpected token in JSON/,
  );
  assert.deepEqual(requestedJobIds, ["3"], "older SHA must not be looked up after JSON failure");
});

test("negative control: catch-and-continue would silently return the older SHA", async () => {
  // Proves the newest-failure/older-eligible scenario above is discriminating: a
  // resolver that swallowed the newest job-lookup failure and continued would
  // return B, so the assert.rejects refusal tests detect that mutation.
  const runs = [run(3, A), run(2, B)];
  const requestedJobIds = [];
  const fetchImpl = failingJobsFetch(runs, 500, requestedJobIds);
  async function catchAndContinue() {
    try {
      return await resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl });
    } catch {
      return B;
    }
  }
  assert.equal(await catchAndContinue(), B);
  assert.deepEqual(requestedJobIds, ["3"]);
});

// Automatic-promotion soak and red-run rules: a green must be 30 minutes old
// and no newer red run may exist. Pinned to PROMOTION_SOAK_MS so a window
// change breaks here.
const { PROMOTION_SOAK_MS } = await import("./resolve-promotion-sha.mjs");

test("soak window is 30 minutes", () => {
  assert.equal(PROMOTION_SOAK_MS, 30 * 60 * 1000);
});

test("a fresh green (under 30 minutes old) falls through to the older soaked green", async () => {
  const now = Date.now();
  const freshAt = new Date(now - 10 * 60 * 1000).toISOString();
  const oldAt = new Date(now - 60 * 60 * 1000).toISOString();
  assert.equal(
    await resolve(
      [run(3, A, "success", "completed", freshAt), run(2, B, "success", "completed", oldAt)],
      {
        3: "success",
        2: "success",
      },
      now,
    ),
    B,
  );
});

test("a fresh green with no older soaked green resolves nothing", async () => {
  const now = Date.now();
  const freshAt = new Date(now - 5 * 60 * 1000).toISOString();
  assert.equal(
    await resolve([run(2, A, "success", "completed", freshAt)], { 2: "success" }, now),
    null,
  );
});

test("a green exactly 30 minutes old is promotable", async () => {
  const now = Date.now();
  const soakedAt = new Date(now - PROMOTION_SOAK_MS).toISOString();
  assert.equal(
    await resolve([run(2, A, "success", "completed", soakedAt)], { 2: "success" }, now),
    A,
  );
});

test("a green with a missing timestamp is not promotable", async () => {
  const missing = { ...run(2, A), updated_at: undefined, created_at: undefined };
  assert.equal(await resolve([missing], { 2: "success" }), null);
});

test("a newer timed_out run blocks every older green like a failure", async () => {
  assert.equal(await resolve([run(3, A, "timed_out"), run(2, B)], { 2: "success" }), null);
});

test("a newer red run for a different commit blocks the older green", async () => {
  // Staging is currently red (newest run failed for C); even a soaked green
  // B must wait for staging to go green again.
  const C = "c".repeat(40);
  assert.equal(await resolve([run(4, C, "failure"), run(3, B)], { 3: "success" }), null);
});

test("a newer cancelled run does not block the older green", async () => {
  assert.equal(await resolve([run(3, A, "cancelled"), run(2, B)], { 2: "success" }), B);
});

// Spawned resolver CLI tests: per-event behavior pins, not source greps.
// Inverting the empty-input clean skip (automatic exit 0 with an empty sha)
// or breaking explicit-sha dispatch must fail here.
function spawnResolverCli(env, stub) {
  const dir = mkdtempSync(join(tmpdir(), "resolver-cli-"));
  const output = join(dir, "output");
  const result = spawnSync(
    process.execPath,
    ["--import", "./ci/test-fetch-stub.mjs", "ci/resolve-promotion-sha.mjs"],
    {
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        FETCH_STUB_JSON: JSON.stringify(stub),
        ...env,
      },
      encoding: "utf8",
    },
  );
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    written = "";
  }
  return { ...result, written };
}

function cliRun(id, deployed, at) {
  return {
    id,
    head_sha: TIP,
    display_title: `e2e-staging deploy ${deployed}`,
    status: "completed",
    conclusion: "success",
    updated_at: at,
  };
}

function cliJobs(runId) {
  return {
    match: `/actions/runs/${runId}/jobs`,
    body: {
      jobs: [
        { name: "staging-journeys", conclusion: "success" },
        {
          name: stagingQualityJob,
          conclusion: "success",
          steps: stagingQualitySteps.map((name) => ({ name, conclusion: "success" })),
        },
      ],
    },
  };
}

const cliBase = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", INPUT_SHA: "" };

test("resolver CLI promotes a soaked green on automatic triggers", () => {
  const oldAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const result = spawnResolverCli({ ...cliBase, GITHUB_EVENT_NAME: "schedule" }, [
    {
      match: "/actions/workflows/e2e-staging.yml/runs",
      body: { workflow_runs: [cliRun(7, A, oldAt)] },
    },
    cliJobs(7),
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.written, `sha=${A}\n`);
  assert.match(result.stdout, /Promoting/);
});

test("resolver CLI skips cleanly on automatic triggers with nothing soaked and green", () => {
  // A fresh green is not promotable yet and there is no older candidate: the
  // run stays green with an empty sha instead of going red.
  const freshAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  for (const event of ["workflow_run", "schedule"]) {
    const result = spawnResolverCli({ ...cliBase, GITHUB_EVENT_NAME: event }, [
      {
        match: "/actions/workflows/e2e-staging.yml/runs",
        body: { workflow_runs: [cliRun(7, A, freshAt)] },
      },
      cliJobs(7),
    ]);
    assert.equal(result.status, 0, event);
    assert.equal(result.written, "sha=\n", event);
    assert.match(result.stdout, /skipping/, event);
  }
});

test("resolver CLI refuses a manual dispatch with nothing to promote", () => {
  const freshAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = spawnResolverCli({ ...cliBase, GITHUB_EVENT_NAME: "workflow_dispatch" }, [
    {
      match: "/actions/workflows/e2e-staging.yml/runs",
      body: { workflow_runs: [cliRun(7, A, freshAt)] },
    },
    cliJobs(7),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No commit to promote/);
});

test("resolver CLI deploys an explicit input sha without any staging lookup", () => {
  const result = spawnResolverCli(
    { ...cliBase, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_SHA: B },
    [],
  );
  assert.equal(result.status, 0);
  assert.equal(result.written, `sha=${B}\n`);
  assert.match(result.stdout, /requested commit/);
});
