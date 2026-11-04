import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPromotionAncestry,
  stagingQualityJob,
  stagingQualitySteps,
} from "./production-deploy-gate.mjs";
import { resolvePromotionSha } from "./resolve-promotion-sha.mjs";

// Promotion ancestry guard: production must never be promoted to a commit that
// is behind (or diverged from) the commit it already serves. All network is
// injected; nothing here reaches GitHub or production.

const LIVE = "10099ce45e7f6a4f1ade945bbbca85278982109e";
const OLDER = "b7ef2f5f2a1dcd4075e959e9a8d68189b0615ff0";
const MIDDLE = "61cb82e136bd6f2bb3fe8e86c599bf467234f969";
const NEWER = "c".repeat(40);
const OTHER = "d".repeat(40);

const AUTOMATIC = ["workflow_run", "schedule"];

const compareBody = (live, overrides = {}) => ({
  status: "ahead",
  ahead_by: 3,
  behind_by: 0,
  total_commits: 3,
  base_commit: { sha: live },
  merge_base_commit: { sha: live },
  ...overrides,
});

// Records every request; answers the compare URL with `respond(url)`.
function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  };
  return { calls, fetchImpl };
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const compareOk = (body) => recorder(() => okJson(body));
const noFetch = () =>
  recorder(() => {
    assert.fail("no GitHub lookup is expected on this path");
  });

const envFor = (event, target, live, extra = {}) => ({
  GITHUB_EVENT_NAME: event,
  INPUT_SHA: "",
  DEPLOY_SHA: target,
  LIVE_SHA: live,
  GITHUB_REPOSITORY: "o/r",
  GITHUB_TOKEN: "t",
  ...extra,
});

const expectedUrl = (live, target) =>
  `https://api.github.com/repos/o/r/compare/${live}...${target}`;

function assertCompared(calls, live, target) {
  assert.equal(calls.length, 1, "exactly one compare lookup");
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, expectedUrl(live, target));
}

test("an ahead candidate passes on both automatic triggers and on a default dispatch", async () => {
  for (const [event, input] of [
    ["workflow_run", ""],
    ["schedule", ""],
    ["workflow_dispatch", ""],
    ["workflow_dispatch", "   \t "],
  ]) {
    const { calls, fetchImpl } = compareOk(compareBody(LIVE));
    const result = await checkPromotionAncestry(envFor(event, NEWER, LIVE, { INPUT_SHA: input }), {
      fetchImpl,
    });
    assert.equal(result, "ahead", `${event} input=${JSON.stringify(input)}`);
    assertCompared(calls, LIVE, NEWER);
  }
});

test("a candidate equal to the live commit returns equal without any lookup", async () => {
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const { calls, fetchImpl } = noFetch();
    assert.equal(await checkPromotionAncestry(envFor(event, LIVE, LIVE), { fetchImpl }), "equal");
    assert.equal(calls.length, 0, event);
  }
});

test("a candidate behind the live commit is refused", async () => {
  const bodies = [
    compareBody(LIVE, {
      status: "behind",
      ahead_by: 0,
      behind_by: 2,
      total_commits: 0,
    }),
    // A lying status alone must not pass: behind_by is checked too.
    compareBody(LIVE, { behind_by: 2 }),
  ];
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    for (const body of bodies) {
      const { calls, fetchImpl } = compareOk(body);
      await assert.rejects(
        checkPromotionAncestry(envFor(event, OLDER, LIVE), { fetchImpl }),
        Error,
        event,
      );
      assertCompared(calls, LIVE, OLDER);
    }
  }
});

test("a diverged or identical-by-API candidate is refused", async () => {
  for (const body of [
    compareBody(LIVE, { status: "diverged", ahead_by: 2, behind_by: 4, total_commits: 2 }),
    compareBody(LIVE, { status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0 }),
    compareBody(LIVE, { status: "" }),
  ]) {
    const { fetchImpl } = compareOk(body);
    await assert.rejects(
      checkPromotionAncestry(envFor("schedule", OTHER, LIVE), { fetchImpl }),
      Error,
      JSON.stringify(body),
    );
  }
});

test("an unknown or malformed live commit refuses without a lookup", async () => {
  for (const live of [
    undefined,
    "",
    "   ",
    "abc123",
    LIVE.toUpperCase(),
    ` ${LIVE}`,
    "g".repeat(40),
  ]) {
    for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
      const { calls, fetchImpl } = noFetch();
      await assert.rejects(
        checkPromotionAncestry(envFor(event, NEWER, live), { fetchImpl }),
        Error,
        `${event} live=${JSON.stringify(live)}`,
      );
      assert.equal(calls.length, 0);
    }
  }
});

test("a malformed target refuses without a lookup", async () => {
  for (const target of [undefined, "", "abc", NEWER.toUpperCase(), `${NEWER}\n`, "z".repeat(40)]) {
    const { calls, fetchImpl } = noFetch();
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_run", target, LIVE), { fetchImpl }),
      Error,
      JSON.stringify(target),
    );
    assert.equal(calls.length, 0);
  }
});

test("missing or malformed compare evidence refuses", async () => {
  const mutations = {
    "ahead_by zero": { ahead_by: 0, total_commits: 0 },
    "ahead_by negative": { ahead_by: -1, total_commits: -1 },
    "ahead_by string": { ahead_by: "3" },
    "ahead_by float": { ahead_by: 1.5, total_commits: 1.5 },
    "ahead_by unsafe": {
      ahead_by: Number.MAX_SAFE_INTEGER + 1,
      total_commits: Number.MAX_SAFE_INTEGER + 1,
    },
    "ahead_by NaN": { ahead_by: Number.NaN },
    "ahead_by missing": { ahead_by: undefined },
    "behind_by missing": { behind_by: undefined },
    "behind_by string": { behind_by: "0" },
    "total_commits mismatch": { total_commits: 2 },
    "total_commits missing": { total_commits: undefined },
    "base_commit missing": { base_commit: undefined },
    "base_commit wrong": { base_commit: { sha: OTHER } },
    "base_commit not object": { base_commit: LIVE },
    "base_commit uppercase": { base_commit: { sha: LIVE.toUpperCase() } },
    "merge_base missing": { merge_base_commit: undefined },
    "merge_base wrong": { merge_base_commit: { sha: OTHER } },
    "status missing": { status: undefined },
    "status uppercase": { status: "AHEAD" },
  };
  for (const [name, overrides] of Object.entries(mutations)) {
    const { fetchImpl } = compareOk(compareBody(LIVE, overrides));
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_run", NEWER, LIVE), { fetchImpl }),
      Error,
      name,
    );
  }
  for (const body of [null, [], "ahead", 7, {}]) {
    const { fetchImpl } = compareOk(body);
    await assert.rejects(
      checkPromotionAncestry(envFor("schedule", NEWER, LIVE), { fetchImpl }),
      Error,
      `body=${JSON.stringify(body)}`,
    );
  }
  // Positive control: the unmutated body passes.
  const { fetchImpl } = compareOk(compareBody(LIVE));
  assert.equal(
    await checkPromotionAncestry(envFor("schedule", NEWER, LIVE), { fetchImpl }),
    "ahead",
  );
});

test("HTTP, transport and decoding failures refuse instead of passing", async () => {
  for (const status of [401, 403, 404, 422, 429, 500, 502]) {
    const { fetchImpl } = recorder(() => ({ ok: false, status, json: async () => ({}) }));
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_run", NEWER, LIVE), { fetchImpl }),
      Error,
      `HTTP ${status}`,
    );
  }
  // An ok:false response never passes even when its body looks like an ahead result.
  const failing = recorder(() => ({
    ok: false,
    status: 500,
    json: async () => compareBody(LIVE),
  }));
  await assert.rejects(
    checkPromotionAncestry(envFor("workflow_run", NEWER, LIVE), { fetchImpl: failing.fetchImpl }),
    Error,
  );
  await assert.rejects(
    checkPromotionAncestry(envFor("schedule", NEWER, LIVE), {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    /fetch failed|ancestry|Promotion/i,
  );
  await assert.rejects(
    checkPromotionAncestry(envFor("schedule", NEWER, LIVE), {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token in JSON");
        },
      }),
    }),
    Error,
  );
});

test("an unknown or missing event refuses, even with a matching input sha", async () => {
  for (const event of [
    undefined,
    "",
    "push",
    "pull_request",
    "WORKFLOW_DISPATCH",
    "workflow_call",
  ]) {
    const { calls, fetchImpl } = compareOk(compareBody(LIVE));
    await assert.rejects(
      checkPromotionAncestry(envFor(event, NEWER, LIVE, { INPUT_SHA: NEWER }), { fetchImpl }),
      Error,
      JSON.stringify(event),
    );
    assert.equal(calls.length, 0, "an unknown event never reaches the lookup");
  }
});

test("only an exact workflow_dispatch input sha is explicit", async () => {
  // Explicit means the operator named the exact commit; it skips only the
  // ancestry comparison. It does not authorize the deploy: every other gate runs.
  for (const live of [LIVE, undefined, "", "unknown"]) {
    const { calls, fetchImpl } = noFetch();
    const result = await checkPromotionAncestry(
      envFor("workflow_dispatch", OLDER, live, { INPUT_SHA: OLDER }),
      { fetchImpl },
    );
    assert.equal(result, "explicit", `live=${JSON.stringify(live)}`);
    assert.equal(calls.length, 0, "explicit dispatch performs no lookup");
  }
});

test("an explicit input sha that differs from the resolved target refuses", async () => {
  for (const input of [OTHER, MIDDLE]) {
    const { calls, fetchImpl } = compareOk(compareBody(LIVE));
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_dispatch", OLDER, LIVE, { INPUT_SHA: input }), {
        fetchImpl,
      }),
      Error,
      input,
    );
    assert.equal(calls.length, 0);
  }
});

test("a malformed non-blank dispatch input sha refuses and never falls back to the default path", async () => {
  for (const input of [
    "abc123",
    OLDER.toUpperCase(),
    "z".repeat(40),
    `${OLDER}0`,
    "main",
    "HEAD",
  ]) {
    // Target is ahead of live, so the default path would have passed.
    const { calls, fetchImpl } = compareOk(compareBody(LIVE));
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_dispatch", NEWER, LIVE, { INPUT_SHA: input }), {
        fetchImpl,
      }),
      Error,
      JSON.stringify(input),
    );
    assert.equal(calls.length, 0, `${JSON.stringify(input)} must not fall back to a lookup`);
  }
});

test("a blank dispatch input follows the default path and is refused when behind", async () => {
  for (const input of [undefined, "", " ", "\n\t "]) {
    const { calls, fetchImpl } = compareOk(
      compareBody(LIVE, { status: "behind", ahead_by: 0, behind_by: 1, total_commits: 0 }),
    );
    await assert.rejects(
      checkPromotionAncestry(envFor("workflow_dispatch", OLDER, LIVE, { INPUT_SHA: input }), {
        fetchImpl,
      }),
      Error,
      JSON.stringify(input),
    );
    assertCompared(calls, LIVE, OLDER);
  }
});

test("migrations_applied=true never bypasses the default ancestry check", async () => {
  for (const flag of ["true", true, "TRUE"]) {
    for (const key of ["MIGRATIONS_APPLIED", "INPUT_MIGRATIONS_APPLIED"]) {
      const behind = compareOk(
        compareBody(LIVE, { status: "behind", ahead_by: 0, behind_by: 1, total_commits: 0 }),
      );
      await assert.rejects(
        checkPromotionAncestry(envFor("workflow_dispatch", OLDER, LIVE, { [key]: flag }), {
          fetchImpl: behind.fetchImpl,
        }),
        Error,
        `${key}=${flag}`,
      );
      assert.equal(behind.calls.length, 1);
      // Unknown live stays refused too.
      await assert.rejects(
        checkPromotionAncestry(envFor("workflow_dispatch", OLDER, "", { [key]: flag }), {
          fetchImpl: noFetch().fetchImpl,
        }),
        Error,
      );
    }
  }
});

test("an automatic trigger cannot bypass ancestry with INPUT_SHA", async () => {
  for (const event of AUTOMATIC) {
    // Matching input, behind candidate: still compared and refused.
    const behind = compareOk(
      compareBody(LIVE, { status: "behind", ahead_by: 0, behind_by: 1, total_commits: 0 }),
    );
    await assert.rejects(
      checkPromotionAncestry(envFor(event, OLDER, LIVE, { INPUT_SHA: OLDER }), {
        fetchImpl: behind.fetchImpl,
      }),
      Error,
      event,
    );
    assertCompared(behind.calls, LIVE, OLDER);
    // Matching input, unknown live: still refused, still never "explicit".
    await assert.rejects(
      checkPromotionAncestry(envFor(event, OLDER, "", { INPUT_SHA: OLDER }), {
        fetchImpl: noFetch().fetchImpl,
      }),
      Error,
      event,
    );
    // Matching input, ahead candidate: result is "ahead", never "explicit".
    const ahead = compareOk(compareBody(LIVE));
    assert.equal(
      await checkPromotionAncestry(envFor(event, NEWER, LIVE, { INPUT_SHA: NEWER }), {
        fetchImpl: ahead.fetchImpl,
      }),
      "ahead",
    );
  }
});

// The incident this guard exists for. Staging runs, newest first (run ids are
// the real ones). Skipped-journeys title runs for the live commit and for the
// commit before it suppress their own older passes (the newest run of a commit
// decides it), leaving only an older candidate that is behind production.
const AT = Date.parse("2026-11-04T12:00:00Z");
const SOAKED = new Date(AT - 2 * 60 * 60 * 1000).toISOString();
const TIP = "f".repeat(40);

const incidentRuns = [
  [41812145125, LIVE],
  [41666047288, LIVE],
  [41619180413, MIDDLE],
  [41584725863, MIDDLE],
  [41547357384, OLDER],
].map(([id, sha]) => ({
  id,
  head_sha: TIP,
  display_title: `e2e-staging deploy ${sha}`,
  status: "completed",
  conclusion: [41812145125, 41619180413].includes(id) ? "skipped" : "success",
  updated_at: SOAKED,
}));
const incidentJourneys = {
  41812145125: "skipped",
  41666047288: "success",
  41619180413: "skipped",
  41584725863: "success",
  41547357384: "success",
};

function incidentStaging() {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      const page = Number(searchParams.get("page"));
      const size = Number(searchParams.get("per_page"));
      return okJson({ workflow_runs: incidentRuns.slice((page - 1) * size, page * size) });
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      assert.equal(id, "41547357384", "skipped tips suppress older passes before job lookup");
      return okJson({
        jobs: [
          { name: "staging-journeys", conclusion: incidentJourneys[id] },
          {
            name: stagingQualityJob,
            conclusion: "success",
            steps: stagingQualitySteps.map((name) => ({ name, conclusion: "success" })),
          },
        ],
      });
    }
    assert.fail(`unexpected ${pathname}`);
  };
}

test("incident: the resolver picks the older passing candidate and the guard refuses it as behind live", async () => {
  const resolved = await resolvePromotionSha({
    repository: "o/r",
    token: "t",
    fetchImpl: incidentStaging(),
    nowMs: AT,
  });
  // The newer skipped runs suppress the passes 41666047288 and 41584725863;
  // the older passing run 41547357384 is what remains resolved.
  assert.equal(resolved, OLDER);

  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const { calls, fetchImpl } = compareOk(
      compareBody(LIVE, { status: "behind", ahead_by: 0, behind_by: 2, total_commits: 0 }),
    );
    await assert.rejects(
      checkPromotionAncestry(envFor(event, resolved, LIVE), { fetchImpl }),
      Error,
      event,
    );
    assertCompared(calls, LIVE, OLDER);
  }
});

// A refusal must stop the deploy chain: GitHub runs each step with `bash -e`
// semantics, so a nonzero ancestry step skips every later step. The sentinel
// stands in for the downstream callback/deploy steps.
function runGuardThenSentinel(env, stub) {
  const dir = mkdtempSync(join(tmpdir(), "ancestry-chain-"));
  const sentinel = join(dir, "deployed");
  const result = spawnSync(
    "bash",
    [
      "-e",
      "-c",
      `"$NODE" --import ./ci/test-fetch-stub.mjs ci/production-deploy-gate.mjs --check-ancestry\ntouch "$SENTINEL"`,
    ],
    {
      env: {
        ...process.env,
        NODE: process.execPath,
        SENTINEL: sentinel,
        FETCH_STUB_JSON: JSON.stringify(stub),
        ...env,
      },
      encoding: "utf8",
    },
  );
  return { ...result, deployed: existsSync(sentinel) };
}

const behindStub = [
  {
    match: "/compare/",
    body: compareBody(LIVE, { status: "behind", ahead_by: 0, behind_by: 2, total_commits: 0 }),
  },
];
const aheadStub = [{ match: "/compare/", body: compareBody(LIVE) }];

test("a guard refusal prevents the downstream deploy sentinel on every default event", () => {
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const refused = runGuardThenSentinel(envFor(event, OLDER, LIVE), behindStub);
    assert.notEqual(refused.status, 0, event);
    assert.equal(refused.deployed, false, `${event} must not reach downstream steps`);
    assert.ok(refused.stderr.length > 0, `${event} explains the refusal on stderr`);
  }
  // Positive control: an ahead candidate reaches the sentinel.
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const passed = runGuardThenSentinel(envFor(event, NEWER, LIVE), aheadStub);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.deployed, true, event);
  }
});

test("a default dispatch with migrations_applied=true is still stopped before the sentinel", () => {
  const refused = runGuardThenSentinel(
    envFor("workflow_dispatch", OLDER, LIVE, {
      MIGRATIONS_APPLIED: "true",
      INPUT_MIGRATIONS_APPLIED: "true",
    }),
    behindStub,
  );
  assert.notEqual(refused.status, 0);
  assert.equal(refused.deployed, false);
});

// Spawned CLI: stdout/stderr and exit codes, with the stub as the only network.
function spawnAncestryCli(env, stub) {
  return spawnSync(
    process.execPath,
    ["--import", "./ci/test-fetch-stub.mjs", "ci/production-deploy-gate.mjs", "--check-ancestry"],
    {
      env: { ...process.env, FETCH_STUB_JSON: JSON.stringify(stub), ...env },
      encoding: "utf8",
    },
  );
}

test("--check-ancestry prints the result and exits 0 for ahead, equal and explicit", () => {
  const ahead = spawnAncestryCli(envFor("schedule", NEWER, LIVE), aheadStub);
  assert.equal(ahead.status, 0, ahead.stderr);
  assert.match(ahead.stdout, /ahead/);

  const equal = spawnAncestryCli(envFor("workflow_run", LIVE, LIVE), []);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /equal/);

  const explicit = spawnAncestryCli(
    envFor("workflow_dispatch", OLDER, LIVE, { INPUT_SHA: OLDER }),
    [],
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /explicit/i);
});

test("--check-ancestry exits nonzero with an error for behind, error, malformed and unknown cases", () => {
  const cases = [
    [envFor("schedule", OLDER, LIVE), behindStub],
    [envFor("workflow_run", NEWER, LIVE), [{ match: "/compare/", status: 500, body: {} }]],
    [envFor("workflow_run", NEWER, LIVE), [{ match: "/compare/", fail: true }]],
    [envFor("workflow_run", NEWER, LIVE), [{ match: "/compare/", body: { status: "ahead" } }]],
    [envFor("workflow_dispatch", NEWER, ""), aheadStub],
    [envFor("workflow_dispatch", NEWER, LIVE, { INPUT_SHA: OTHER }), aheadStub],
    [envFor("push", NEWER, LIVE), aheadStub],
  ];
  for (const [env, stub] of cases) {
    const result = spawnAncestryCli(env, stub);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.ok(result.stderr.length > 0, "the refusal is reported on stderr");
  }
});

// Structural pins on the workflow: the guard must run from the tip checkout,
// after the live commit is known and before anything is checked out, migrated,
// drilled or recorded for the candidate; and nothing downstream may bypass it.
const workflow = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);
const jobBlock = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const stepBlocks = (job) => job.split(/\n {6}- /).slice(1);
const preflightSteps = stepBlocks(jobBlock("preflight"));
const ancestryIndex = preflightSteps.findIndex((step) => step.includes("--check-ancestry"));
const indexOfStep = (needle) => preflightSteps.findIndex((step) => step.includes(needle));

test("deploy-production runs --check-ancestry exactly once, as a preflight step", () => {
  assert.equal(
    preflightSteps.filter((step) => step.includes("--check-ancestry")).length,
    1,
    "exactly one ancestry step in preflight",
  );
  assert.equal(
    workflow.split("--check-ancestry").length - 1,
    1,
    "the flag is not used outside the single preflight step",
  );
  assert.ok(ancestryIndex >= 0);
  assert.match(
    preflightSteps[ancestryIndex],
    /run: node ci\/production-deploy-gate\.mjs --check-ancestry\n/,
  );
});

test("the ancestry step runs after --already-live and before the candidate checkout, migrations, drill and rollback target", () => {
  const alreadyLive = indexOfStep("--already-live");
  const migrations = indexOfStep("--check-migrations");
  const drill = indexOfStep("--check-drill");
  const rollback = indexOfStep("--check-target");
  const candidateCheckout = preflightSteps.findIndex(
    (step) =>
      step.startsWith("uses: actions/checkout") && step.includes("steps.target.outputs.sha }}"),
  );
  const tipCheckout = preflightSteps.findIndex(
    (step) => step.startsWith("uses: actions/checkout") && step.includes("ref: ${{ github.sha }}"),
  );
  for (const [name, index] of Object.entries({
    alreadyLive,
    migrations,
    drill,
    rollback,
    candidateCheckout,
    tipCheckout,
  })) {
    assert.ok(index >= 0, `${name} step found`);
  }
  assert.ok(tipCheckout < ancestryIndex, "runs from the github.sha checkout");
  assert.ok(alreadyLive < ancestryIndex, "after --already-live has published live_sha");
  assert.ok(ancestryIndex < candidateCheckout, "before the candidate checkout");
  assert.ok(ancestryIndex < migrations, "before the migration check");
  assert.ok(ancestryIndex < drill, "before the rollback drill hold");
  assert.ok(ancestryIndex < rollback, "before the rollback target record");
  // No candidate checkout sits between the tip checkout and the guard.
  for (let i = tipCheckout + 1; i < ancestryIndex; i += 1) {
    assert.ok(
      !preflightSteps[i].includes("steps.target.outputs.sha }}\n") ||
        !preflightSteps[i].startsWith("uses: actions/checkout"),
      "no candidate checkout before the guard",
    );
  }
});

test("the ancestry step receives the target, live commit, input, event and token, and is a hard failure", () => {
  const step = preflightSteps[ancestryIndex];
  assert.match(step, /DEPLOY_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(step, /LIVE_SHA: \$\{\{ steps\.live\.outputs\.live_sha \}\}/);
  assert.match(step, /INPUT_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(step, /GITHUB_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(!/continue-on-error/.test(step), "a failed guard must fail the job");
  assert.ok(!/always\(\)|failure\(\)|cancelled\(\)/.test(step), "no status-function override");
  assert.ok(
    !/MIGRATIONS_APPLIED|migrations_applied/.test(step),
    "migrations_applied is not an input",
  );
});

test("the ancestry step is conditioned only on a nonempty candidate", () => {
  const step = preflightSteps[ancestryIndex];
  const conditions = [...step.matchAll(/^ {8}if: (.*)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(conditions, ["steps.target.outputs.sha != ''"]);
  assert.ok(!/already_live/.test(step.split("run:")[0]), "not skipped by already_live");
});

test("downstream deploy jobs depend on preflight with no always() bypass", () => {
  const preflight = jobBlock("preflight");
  assert.ok(!/continue-on-error/.test(preflight), "preflight has no continue-on-error");
  for (const name of ["staging-soak", "regression", "deploy-production"]) {
    const job = jobBlock(name);
    const needs = job.match(/^ {4}needs: (.*)$/m)?.[1] ?? "";
    assert.match(needs, /\bpreflight\b/, `${name} needs preflight`);
    const condition = job.match(/^ {4}if: ([\s\S]*?)(?=\n {4}[a-z-]+:)/m)?.[1] ?? "";
    assert.ok(
      condition.includes("needs.preflight.outputs.sha != ''"),
      `${name} requires a candidate`,
    );
    assert.ok(
      !/always\(\)|failure\(\)|cancelled\(\)/.test(condition),
      `${name} has no status bypass`,
    );
    assert.ok(
      !/continue-on-error/.test(job.split("steps:")[0]),
      `${name} job is not continue-on-error`,
    );
  }
  // deploy-production reaches preflight through regression and directly.
  assert.match(jobBlock("deploy-production"), /needs: \[preflight, regression\]/);
  assert.match(jobBlock("regression"), /needs: \[preflight, staging-soak\]/);
  assert.match(jobBlock("staging-soak"), /needs: preflight\n/);
});

test("blocking CI runs the ancestry admission selftest", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: node --test ci\/production-ancestry\.test\.mjs\n/);
});
