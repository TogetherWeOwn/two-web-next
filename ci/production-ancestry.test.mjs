import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPromotionAncestry,
  stagingQualityJob,
  stagingQualitySteps,
} from "./production-deploy-gate.mjs";
import { resolvePromotionSha } from "./resolve-promotion-sha.mjs";
import { checkRollbackTarget, liveVersion } from "./rollback-target.mjs";

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
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Exercise the live-output handoff as well as admission, without real network.
function runLiveAdmission(
  event,
  sequence,
  { target = NEWER, comparison = compareBody(LIVE) } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "live-admission-"));
  const output = join(dir, "output");
  const log = join(dir, "fetches");
  const checkedOut = join(dir, "checked-out");
  const deployed = join(dir, "deployed");
  try {
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-c",
        `"$NODE" --import ./ci/test-fetch-stub.mjs ci/production-deploy-gate.mjs --already-live
source "$GITHUB_OUTPUT"
export LIVE_SHA="$live_sha"
"$NODE" --import ./ci/test-fetch-stub.mjs ci/production-deploy-gate.mjs --check-ancestry
if [ "$already_live" != true ]; then
  touch "$CHECKED_OUT"
  touch "$DEPLOYED"
fi`,
      ],
      {
        env: {
          ...process.env,
          ...envFor(event, target, "", { MIGRATIONS_APPLIED: "true" }),
          NODE: process.execPath,
          PRODUCTION_ORIGIN: "https://stub.invalid",
          GITHUB_OUTPUT: output,
          FETCH_STUB_LOG: log,
          CHECKED_OUT: checkedOut,
          DEPLOYED: deployed,
          FETCH_STUB_JSON: JSON.stringify([
            { match: "/up", sequence },
            { match: "/compare/", body: comparison },
          ]),
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    return {
      ...result,
      written: readFileSync(output, "utf8"),
      calls: readFileSync(log, "utf8").trim().split("\n"),
      checkedOut: existsSync(checkedOut),
      deployed: existsSync(deployed),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const liveBody = (commit) => ({ body: { revision: { commit } } });
const upCalls = (result) => result.calls.filter((url) => url.endsWith("/up"));
const compareCalls = (result) => result.calls.filter((url) => url.includes("/compare/"));

test("live identity admission retries a transient failure before checking recovered ancestry", () => {
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const result = runLiveAdmission(event, [{ fail: true }, liveBody(LIVE)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(upCalls(result).length, 2, event);
    assert.equal(result.written, `already_live=false\nlive_sha=${LIVE}\n`);
    assert.deepEqual(compareCalls(result), [expectedUrl(LIVE, NEWER)]);
    assert.equal(result.checkedOut, true, event);
    assert.equal(result.deployed, true, event);
  }
});

test("live identity admission retries malformed identities through the third read", () => {
  const result = runLiveAdmission("schedule", [liveBody("bad"), liveBody(null), liveBody(LIVE)]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(upCalls(result).length, 3);
  assert.equal(result.written, `already_live=false\nlive_sha=${LIVE}\n`);
  assert.deepEqual(compareCalls(result), [expectedUrl(LIVE, NEWER)]);
  assert.equal(result.deployed, true);
});

test("live identity admission exhausts three invalid reads before refusing checkout and deployment", () => {
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    for (const sequence of [[{ fail: true }], [liveBody("bad"), liveBody(null), { body: {} }]]) {
      const result = runLiveAdmission(event, sequence);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(upCalls(result).length, 3, event);
      assert.equal(result.written, "already_live=false\nlive_sha=\n");
      assert.match(result.stderr, /known full 40-hex live production SHA/);
      assert.deepEqual(compareCalls(result), []);
      assert.equal(result.checkedOut, false, event);
      assert.equal(result.deployed, false, event);
    }
  }
});

test("live identity admission stops reading after the first valid identity", () => {
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    const result = runLiveAdmission(event, [liveBody(LIVE), { fail: true }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(upCalls(result).length, 1, event);
    assert.equal(result.written, `already_live=false\nlive_sha=${LIVE}\n`);
    assert.deepEqual(compareCalls(result), [expectedUrl(LIVE, NEWER)]);
    assert.equal(result.deployed, true, event);
  }
  const equal = runLiveAdmission("schedule", [liveBody(LIVE), { fail: true }], { target: LIVE });
  assert.equal(equal.status, 0, equal.stderr);
  assert.equal(upCalls(equal).length, 1);
  assert.equal(equal.written, `already_live=true\nlive_sha=${LIVE}\n`);
  assert.deepEqual(compareCalls(equal), []);
  assert.equal(equal.checkedOut, false);
  assert.equal(equal.deployed, false);
});

test("a recovered live identity still refuses a backward candidate before checkout", () => {
  const result = runLiveAdmission("workflow_run", [{ fail: true }, liveBody(LIVE)], {
    target: OLDER,
    comparison: compareBody(LIVE, {
      status: "behind",
      ahead_by: 0,
      behind_by: 2,
      total_commits: 0,
    }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(upCalls(result).length, 2);
  assert.deepEqual(compareCalls(result), [expectedUrl(LIVE, OLDER)]);
  assert.equal(result.checkedOut, false);
  assert.equal(result.deployed, false);
});

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

test("deploy-production runs --check-ancestry for initial and recorded live commits in preflight", () => {
  assert.equal(
    preflightSteps.filter((step) => step.includes("--check-ancestry")).length,
    2,
    "initial admission plus rollback-snapshot admission in preflight",
  );
  assert.equal(
    workflow.split("--check-ancestry").length - 1,
    2,
    "both guards run before leaving workflow-head preflight",
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

const recordedAncestryIndex = preflightSteps.findIndex(
  (step) =>
    step.includes("--check-ancestry") && step.includes("steps.rollback-target.outputs.commit"),
);

test("recorded-live ancestry is a hard workflow-head gate after capture and before candidate checkout", () => {
  const rollback = indexOfStep("--check-target");
  const candidateCheckout = preflightSteps.findIndex(
    (step) =>
      step.startsWith("uses: actions/checkout") && step.includes("steps.target.outputs.sha }}"),
  );
  assert.ok(recordedAncestryIndex > rollback, "re-admit against the captured rollback commit");
  assert.ok(recordedAncestryIndex < candidateCheckout, "still runs from workflow-head source");
  const step = preflightSteps[recordedAncestryIndex];
  assert.match(step, /run: node ci\/production-deploy-gate\.mjs --check-ancestry\n/);
  assert.match(step, /LIVE_SHA: \$\{\{ steps\.rollback-target\.outputs\.commit \}\}/);
  assert.match(step, /DEPLOY_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(step, /INPUT_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(step, /GITHUB_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    step,
    /if: steps\.target\.outputs\.sha != '' && steps\.live\.outputs\.already_live != 'true'\n/,
  );
  assert.ok(!/continue-on-error|always\(\)|failure\(\)|cancelled\(\)/.test(step));
  assert.ok(!/MIGRATIONS_APPLIED|migrations_applied/.test(step));
  const deploy = jobBlock("deploy-production");
  assert.match(deploy, /if \[ "\$live" != "\$ROLLBACK_VERSION_ID" \]; then/);
  assert.match(
    deploy,
    /ROLLBACK_VERSION_ID: \$\{\{ needs\.preflight\.outputs\.rollback_version_id \}\}/,
  );
  assert.match(deploy, /group: production-worker-mutation/);
});

test("interleaving: a recovery to a descendant before rollback capture cannot reach deployment", async () => {
  // A -> B -> C. Initially A serves and B is admitted; a recovery can restore C
  // before rollback capture. Locked version freshness alone then accepts C.
  for (const event of [...AUTOMATIC, "workflow_dispatch"]) {
    for (const [capturedCommit, explicit] of [
      [LIVE, false],
      [NEWER, false],
      [NEWER, true],
    ]) {
      if (explicit && event !== "workflow_dispatch") continue;
      const env = envFor(event, MIDDLE, LIVE, { INPUT_SHA: explicit ? MIDDLE : "" });
      const initial = await checkPromotionAncestry(env, {
        fetchImpl: compareOk(compareBody(LIVE)).fetchImpl,
      });
      assert.equal(initial, explicit ? "explicit" : "ahead");
      const versionId = "11111111-1111-4111-8111-111111111111";
      const captured = await checkRollbackTarget({
        origin: "https://production.example",
        repository: "o/r",
        targetSha: MIDDLE,
        token: "fixture-only",
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/up") {
            return okJson({ revision: { version_id: versionId, commit: capturedCommit } });
          }
          assert.ok(parsed.pathname.endsWith("/contents/drizzle/meta/_journal.json"));
          assert.ok([MIDDLE, capturedCommit].includes(parsed.searchParams.get("ref")));
          return okJson({
            encoding: "base64",
            content: Buffer.from(
              JSON.stringify({ entries: [{ tag: "1000_a", when: 1000 }] }),
            ).toString("base64"),
          });
        },
      });
      assert.equal(captured.commit, capturedCommit);
      assert.equal(
        liveVersion([
          {
            created_on: "2026-11-05T00:00:00Z",
            versions: [{ version_id: versionId, percentage: 100 }],
          },
        ]),
        captured.versionId,
        "the locked freshness check accepts the captured version even after A -> C",
      );
      assert.ok(recordedAncestryIndex >= 0, "workflow must re-admit the recorded commit");
      const relation = compareBody(
        captured.commit,
        captured.commit === LIVE
          ? {}
          : {
              status: "behind",
              ahead_by: 0,
              behind_by: 1,
              total_commits: 0,
            },
      );
      const result = runGuardThenSentinel({ ...env, LIVE_SHA: captured.commit }, [
        { match: "/compare/", body: relation },
      ]);
      const shouldDeploy = capturedCommit === LIVE || explicit;
      assert.equal(result.status === 0, shouldDeploy, result.stderr);
      assert.equal(
        result.deployed,
        shouldDeploy,
        `${event}: captured=${capturedCommit}, explicit=${explicit}`,
      );
      if (!shouldDeploy) assert.match(result.stderr, /not a verified forward descendant/);
    }
  }
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
