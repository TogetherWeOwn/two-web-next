import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PASSIVE_LEDGER_MAX_BYTES,
  SOAK_ERROR_RATE_FLOOR,
  SOAK_ERROR_RATE_MARGIN,
  buildScriptErrorQuery,
  checkRegression,
  evaluateSoakErrorRate,
  fetchPassiveLedgers,
  journeyOutcomes,
  regressionsAgainstProduction,
  requireStagingSoakIfEvident,
  smokeOutcomes,
  stagingCandidateVersion,
  stagingCandidateVersions,
  stagingSoakSample,
  sumScriptErrors,
} from "./production-deploy-gate.mjs";
import { qualificationTarget, requireQualificationRevision } from "./staging-qualification.mjs";

const SHA = "a".repeat(40);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const VERSION = "11111111-1111-4111-8111-111111111111";

const smoke = (checks) => ({ ledger: "smoke/1", origin: "https://x", checks });
const journeys = (tests) => ({
  suites: [
    {
      title: "guest-journeys.spec.ts",
      specs: [],
      suites: [
        {
          title: "guest",
          specs: tests.map(([title, status]) => ({
            title,
            tests: [{ projectName: "chromium", status }],
          })),
        },
      ],
    },
  ],
});

test("smoke outcomes map the ledger and keep a route's worst outcome", () => {
  const outcomes = smokeOutcomes(
    smoke([
      { check: "/", status: "pass" },
      { check: "/up", status: "fail" },
      { check: "/up", status: "pass" },
      { check: "/events", status: "skip" },
    ]),
  );
  assert.deepEqual(
    [...outcomes],
    [
      ["smoke /", "passed"],
      ["smoke /up", "failed"],
      ["smoke /events", "skipped"],
    ],
  );
  for (const bad of [
    {},
    { ledger: "smoke/2", checks: [] },
    smoke([{ check: "/", status: "ok" }]),
  ]) {
    assert.throws(() => smokeOutcomes(bad));
  }
});

test("journey outcomes name each test by its describe path and project", () => {
  const outcomes = journeyOutcomes(
    journeys([
      ["home", "expected"],
      ["events", "flaky"],
      ["archive", "unexpected"],
      ["about", "skipped"],
      ["404", "interrupted"],
    ]),
  );
  assert.deepEqual(
    [...outcomes],
    [
      ["journey › guest › home › chromium", "passed"],
      ["journey › guest › events › chromium", "passed"],
      ["journey › guest › archive › chromium", "failed"],
      ["journey › guest › about › chromium", "skipped"],
      ["journey › guest › 404 › chromium", "failed"],
    ],
  );
  assert.throws(() => journeyOutcomes({}), /no suites/);
});

test("journey outcomes keep a repeated journey's worst outcome", () => {
  const repeated = (first, second) => ({
    suites: [
      {
        title: "guest-journeys.spec.ts",
        specs: [],
        suites: [
          {
            title: "guest",
            specs: [
              { title: "home", tests: [{ projectName: "chromium", status: first }] },
              { title: "home", tests: [{ projectName: "chromium", status: second }] },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(
    journeyOutcomes(repeated("unexpected", "expected")).get("journey › guest › home › chromium"),
    "failed",
    "a later passed entry must not hide an earlier failed one",
  );
  assert.equal(
    journeyOutcomes(repeated("expected", "unexpected")).get("journey › guest › home › chromium"),
    "failed",
    "order must not matter",
  );
  assert.equal(
    journeyOutcomes(repeated("expected", "skipped")).get("journey › guest › home › chromium"),
    "skipped",
    "skipped outranks passed, like the smoke ledger",
  );
});

test("a check production passes must have passed on staging", () => {
  const production = new Map([
    ["a", "passed"],
    ["b", "passed"],
    ["c", "passed"],
    ["d", "passed"],
    ["e", "failed"],
  ]);
  const staging = new Map([
    ["a", "passed"],
    ["b", "failed"],
    ["c", "skipped"],
    ["e", "failed"],
    ["f", "failed"],
  ]);
  assert.deepEqual(regressionsAgainstProduction(production, staging), [
    "b (staging failed)",
    "c (staging skipped)",
    "d (staging missing)",
  ]);
});

test("soak error rate: 1.5x production with a 1% floor; small samples cannot be judged", () => {
  assert.equal(SOAK_ERROR_RATE_MARGIN, 1.5);
  assert.equal(SOAK_ERROR_RATE_FLOOR, 0.01);
  const rate = (staging, production) => evaluateSoakErrorRate({ staging, production });
  // Production 4%: limit 6%.
  const prod = { requests: 10_000, errors: 400 };
  assert.equal(rate({ requests: 100, errors: 6 }, prod).verdict, "pass");
  assert.equal(rate({ requests: 100, errors: 7 }, prod).verdict, "fail");
  // Production clean: the 1% floor applies.
  const clean = { requests: 10_000, errors: 0 };
  assert.equal(rate({ requests: 200, errors: 2 }, clean).verdict, "pass");
  assert.equal(rate({ requests: 200, errors: 3 }, clean).verdict, "fail");
  // Too little production traffic: floor only.
  assert.equal(rate({ requests: 200, errors: 3 }, { requests: 5, errors: 5 }).limit, 0.01);
  // Under 20 staging requests: insufficient, never fail.
  assert.equal(rate({ requests: 19, errors: 19 }, clean).verdict, "insufficient");
  for (const bad of [
    { requests: Number.NaN, errors: 0 },
    { requests: 1, errors: 2 },
    { requests: -1, errors: 0 },
    { requests: 1.5, errors: 0 },
  ]) {
    assert.throws(() => rate(bad, clean), /non-negative integer/);
  }
});

test("analytics query validates identifiers and sums every row", () => {
  const query = buildScriptErrorQuery({
    accountId: ACCOUNT,
    scriptName: "two-web-next",
    versionId: VERSION,
    sinceIso: "2026-11-01T00:00:00.000Z",
    untilIso: "2026-11-01T01:00:00.000Z",
  });
  assert.match(query.query, /query \(\$accountTag: String!,/);
  assert.deepEqual(query.variables.filter, {
    scriptName: "two-web-next",
    datetime_geq: "2026-11-01T00:00:00.000Z",
    datetime_leq: "2026-11-01T01:00:00.000Z",
    scriptVersion: VERSION,
  });
  const all = buildScriptErrorQuery({
    accountId: ACCOUNT,
    scriptName: "two-web-next-production",
    sinceIso: "a",
    untilIso: "b",
  });
  assert.equal(all.variables.filter.scriptVersion, undefined);
  assert.throws(() => buildScriptErrorQuery({ accountId: "x", scriptName: "two-web-next" }));
  assert.throws(() => buildScriptErrorQuery({ accountId: ACCOUNT, scriptName: "a b" }));
  const rows = (sums) => ({
    data: { viewer: { accounts: [{ workersInvocationsAdaptive: sums.map((sum) => ({ sum })) }] } },
  });
  assert.deepEqual(
    sumScriptErrors(
      rows([
        { requests: 10, errors: 1 },
        { requests: 5, errors: 0 },
      ]),
    ),
    { requests: 15, errors: 1 },
  );
  assert.deepEqual(sumScriptErrors(rows([])), { requests: 0, errors: 0 });
  assert.throws(() => sumScriptErrors({ errors: [{ message: "x" }] }), /returned errors/);
  assert.throws(() => sumScriptErrors({ data: {} }), /no invocation rows/);
  assert.throws(() => sumScriptErrors(rows([{ requests: "1", errors: 0 }])), /invalid sums/);
});

function analytics(requests, errors, seen = []) {
  return async (url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    const body = JSON.parse(init.body);
    seen.push(body.variables.filter);
    return {
      ok: true,
      json: async () => ({
        data: {
          viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests, errors } }] }] },
        },
      }),
    };
  };
}

function regressionEnv(files, overrides = {}) {
  return {
    PRODUCTION_SMOKE_LEDGER: "prod-smoke",
    PRODUCTION_JOURNEYS: "prod-journeys",
    STAGING_SMOKE_LEDGER: "staging-smoke",
    STAGING_JOURNEYS: "staging-journeys",
    STAGING_SOAK_REQUESTS: "100",
    STAGING_SOAK_ERRORS: "1",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: "fixture-only",
    ...overrides,
    files,
  };
}

const green = {
  "prod-smoke": smoke([{ check: "/", status: "pass" }]),
  "prod-journeys": journeys([["home", "expected"]]),
  "staging-smoke": smoke([{ check: "/", status: "pass" }]),
  "staging-journeys": journeys([["home", "expected"]]),
};

function regression(files, overrides, fetchImpl = analytics(10_000, 100)) {
  const env = regressionEnv(files, overrides);
  return checkRegression(env, {
    readJson: (path) => structuredClone(env.files[path]),
    fetchImpl,
    nowMs: Date.parse("2026-11-01T12:00:00Z"),
  });
}

test("regression check passes a candidate that keeps every production check green", async () => {
  const seen = [];
  const result = await regression(green, {}, analytics(10_000, 100, seen));
  assert.equal(result.verdict, "pass");
  assert.equal(result.passedOnProduction, 2);
  // Production baseline: the whole production script over the last 24 hours.
  assert.deepEqual(seen, [
    {
      scriptName: "two-web-next-production",
      datetime_geq: "2026-10-31T12:00:00.000Z",
      datetime_leq: "2026-11-01T12:00:00.000Z",
    },
  ]);
});

test("regression check refuses a check that passes on production and failed on staging", async () => {
  await assert.rejects(
    regression({ ...green, "staging-journeys": journeys([["home", "unexpected"]]) }),
    /regresses 1 check\(s\) that pass on production: journey › guest › home › chromium \(staging failed\)/,
  );
  await assert.rejects(
    regression({ ...green, "staging-smoke": smoke([]) }),
    /smoke \/ \(staging missing\)/,
  );
  // Failing on both sides is not a regression.
  const bothFail = {
    ...green,
    "prod-smoke": smoke([{ check: "/", status: "fail" }]),
    "staging-smoke": smoke([{ check: "/", status: "fail" }]),
  };
  assert.equal((await regression(bothFail)).verdict, "pass");
});

test("regression check refuses an elevated staging soak error rate and a missing sample", async () => {
  await assert.rejects(
    regression(green, { STAGING_SOAK_REQUESTS: "100", STAGING_SOAK_ERRORS: "3" }),
    /staging error rate 0\.0300 exceeds the limit 0\.0150/,
  );
  await assert.rejects(
    regression(green, { STAGING_SOAK_REQUESTS: "", STAGING_SOAK_ERRORS: "" }),
    /non-negative integer/,
  );
  await assert.rejects(
    regression(green, {}, async () => ({ ok: false, status: 403 })),
    /Workers analytics query failed \(HTTP 403\)/,
  );
});

function versionsApi(pages) {
  return async (url, init) => {
    const parsed = new URL(url);
    assert.equal(
      parsed.pathname,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/two-web-next/versions`,
    );
    assert.equal(init.headers.authorization, "Bearer fixture-only");
    const items = pages[Number(parsed.searchParams.get("page")) - 1] ?? [];
    return { ok: true, json: async () => ({ result: { items } }) };
  };
}
const version = (id, tag, created_on = "2026-11-01T10:00:00Z") => ({
  id,
  annotations: { "workers/tag": tag },
  metadata: { created_on },
});

test("the candidate's staging version is the one tagged with its commit", async () => {
  const filler = Array.from({ length: 100 }, (_, i) =>
    version(`2222222${i % 10}-2222-4222-8222-222222222222`, "b".repeat(40)),
  );
  assert.deepEqual(
    await stagingCandidateVersion(
      { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
      { fetchImpl: versionsApi([filler, [version(VERSION, SHA)]]) },
    ),
    { versionId: VERSION, createdOn: "2026-11-01T10:00:00Z" },
  );
  await assert.rejects(
    stagingCandidateVersion(
      { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
      { fetchImpl: versionsApi([[]]) },
    ),
    /No staging version tagged/,
  );
  await assert.rejects(
    stagingCandidateVersion(
      { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
      { fetchImpl: versionsApi([[version(VERSION, SHA, "never")]]) },
    ),
    /no creation time/,
  );
});

test("a redeployed candidate sums every tagged version, oldest first", async () => {
  const older = "00000000-0000-4000-8000-000000000000";
  const versions = await stagingCandidateVersions(
    { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
    {
      fetchImpl: versionsApi([
        [version(VERSION, SHA, "2026-11-01T11:00:00Z"), version(older, SHA)],
      ]),
    },
  );
  assert.deepEqual(versions, [
    { versionId: older, createdOn: "2026-11-01T10:00:00Z" },
    { versionId: VERSION, createdOn: "2026-11-01T11:00:00Z" },
  ]);
  // The singular still names the serving (newest) version.
  assert.deepEqual(
    await stagingCandidateVersion(
      { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
      {
        fetchImpl: versionsApi([
          [version(VERSION, SHA, "2026-11-01T11:00:00Z"), version(older, SHA)],
        ]),
      },
    ),
    { versionId: VERSION, createdOn: "2026-11-01T11:00:00Z" },
  );
});

function githubArtifacts({ runs, artifacts, commit = SHA, seen = {} }) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "blob.example") {
      seen.blobAuth = init.headers?.Authorization;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(commit).buffer };
    }
    assert.equal(init.headers.Authorization, "Bearer fixture-only");
    if (parsed.pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    }
    if (/\/actions\/runs\/\d+\/artifacts$/.test(parsed.pathname)) {
      seen.artifactsRun = parsed.pathname.match(/runs\/(\d+)\//)[1];
      return { ok: true, json: async () => ({ artifacts }) };
    }
    if (parsed.pathname.endsWith("/zip")) {
      assert.equal(init.redirect, "manual");
      return {
        status: 302,
        headers: new Headers({ location: "https://blob.example/ledger.zip" }),
      };
    }
    assert.fail(`unexpected ${url}`);
  };
}

function fetchLedgers(options, unzipSeen = {}) {
  const dir = mkdtempSync(join(tmpdir(), "passive-"));
  return fetchPassiveLedgers(
    { repository: "fixture/repo", sha: SHA, token: "fixture-only", dir },
    {
      fetchImpl: githubArtifacts(options),
      // The fake archive holds only the commit file.
      unzip: (zip, out) => {
        unzipSeen.zip = zip;
        writeFileSync(join(out, "commit"), `${readFileSync(zip, "utf8")}\n`);
      },
    },
  );
}

const e2eRun = (id, overrides = {}) => ({
  id,
  display_title: `e2e-staging deploy ${SHA}`,
  status: "completed",
  head_branch: "main",
  path: ".github/workflows/e2e-staging.yml",
  head_repository: { full_name: "fixture/repo" },
  ...overrides,
});

test("passive ledgers come from the newest e2e-staging run for the candidate, without the token on the blob", async () => {
  const seen = {};
  const result = await fetchLedgers({
    runs: [e2eRun(5), e2eRun(9), { id: 12, display_title: `e2e-staging deploy ${"b".repeat(40)}` }],
    artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    seen,
  });
  assert.deepEqual(result, { runId: 9, artifactId: 77 });
  assert.equal(seen.artifactsRun, "9");
  assert.equal(seen.blobAuth, undefined, "the signed blob URL never receives the GitHub token");
});

test("missing, expired or mismatched passive ledgers refuse promotion", async () => {
  await assert.rejects(fetchLedgers({ runs: [], artifacts: [] }), /No e2e-staging run/);
  await assert.rejects(
    fetchLedgers({ runs: [e2eRun(9)], artifacts: [] }),
    /has no staging-passive-ledger-9 artifact/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9)],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: true }],
    }),
    /has no staging-passive-ledger-9 artifact/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9)],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
      commit: "c".repeat(40),
    }),
    /names c{40}, not the candidate/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9, { status: "in_progress" })],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    }),
    /is not completed/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9, { head_branch: "feature" })],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    }),
    /revision\/branch\/workflow mismatch/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9, { head_repository: { full_name: "evil/fork" } })],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    }),
    /revision\/branch\/workflow mismatch/,
  );
  await assert.rejects(
    fetchLedgers({
      runs: [{ ...e2eRun(9), id: "nine" }],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    }),
    /invalid run id/,
  );
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("e2e-staging records the passive set for every promotable deploy", () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  const job = workflow.slice(
    workflow.indexOf("\n  staging-passive:\n"),
    workflow.indexOf("\n  staging-journeys:\n"),
  );
  assert.doesNotMatch(job, /needs\.scope\.outputs\.skip_e2e/);
  assert.match(job, /needs: scope\n/);
  assert.match(job, /ref: \$\{\{ needs\.scope\.outputs\.sha \}\}/);
  assert.match(
    job,
    /node bin\/smoke\.mjs https:\/\/next\.togetherweown\.com --ledger passive\/smoke\.json/,
  );
  // Bare --config: a CLI --reporter flag would shadow the config reporters
  // and the journey ledger below would never be written. The config adds
  // the JSON reporter with this output file when the env var is set.
  assert.match(job, /npx playwright test --config playwright\.watch\.config\.ts\n/);
  assert.ok(!/--reporter/.test(job), "the passive set must not shadow the config reporters");
  assert.match(job, /PLAYWRIGHT_JSON_OUTPUT_FILE: passive\/journeys\.json/);
  assert.match(job, /WATCH_ORIGIN: https:\/\/next\.togetherweown\.com/);
  assert.match(job, /SMOKE_ALLOW_MISSING_BASELINE: "1"/);
  assert.match(job, /name: staging-passive-ledger-\$\{\{ github\.run_id \}\}/);
  assert.ok(!/secrets\./.test(job), "the passive set needs no secrets");
  // The job checks out the deployed candidate, so it must not write caches
  // (CodeQL cache-poisoning): no setup-node npm cache, no actions/cache.
  assert.ok(!/cache: npm/.test(job), "the passive set must not use the npm cache");
  assert.ok(!/uses: actions\/cache@/.test(job), "the passive set must not write caches");
});

function qualificationContext() {
  return {
    eventName: "workflow_run",
    repository: "fixture/repo",
    ref: "refs/heads/main",
    sha: "c".repeat(40),
    event: {
      repository: { full_name: "fixture/repo" },
      workflow_run: {
        event: "workflow_run",
        path: ".github/workflows/deploy.yml",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_repository: { full_name: "fixture/repo" },
        head_sha: "b".repeat(40),
        display_title: `deploy ${SHA}`,
      },
    },
  };
}

const revisionOptions = (commit) => ({
  log: () => {},
  fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://next.togetherweown.com/up");
    assert.equal(init.redirect, "manual");
    return { json: async () => ({ revision: { version_id: VERSION, commit } }) };
  },
});

test("staging scope classifies the deployed diff without executing candidate scripts", () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  const scope = workflow.split("\n  scope:\n")[1].split("\n  zap-baseline:\n")[0];
  assert.equal((scope.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(scope, /ref: \$\{\{ github\.sha \}\}\n {10}fetch-depth: 0/);
  assert.doesNotMatch(scope, /ref: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(scope, /HEAD_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(scope, /git diff --name-status -M "\$HEAD_SHA~1" "\$HEAD_SHA"/);
  assert.match(scope, /bash ci\/change-scope\.sh "\$RUNNER_TEMP\/deployed-files\.tsv"/);
});

test("staging qualification preserves the deployed SHA through checker checkout and ledger consumption", async () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  assert.match(workflow, /sha: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(workflow, /run: node ci\/staging-qualification\.mjs\n/);
  assert.doesNotMatch(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /HEAD_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  const passive = workflow.split("\n  staging-passive:\n")[1].split("\n  staging-journeys:\n")[0];
  assert.match(passive, /ref: \$\{\{ needs\.scope\.outputs\.sha \}\}/);
  assert.match(passive, /DEPLOYED_SHA: \$\{\{ needs\.scope\.outputs\.sha \}\}/);
  const target = qualificationTarget(qualificationContext());
  assert.equal(
    target,
    SHA,
    "CI/deployed A, deploy API head B, and e2e API head C must still qualify A",
  );
  await requireQualificationRevision(target, revisionOptions(target));
  // Execute the workflow's actual commit-file writer, then feed that identity
  // through the production artifact reader rather than just resolver selection.
  const writer = passive.match(/          (printf [^\n]+ > passive\/commit)/)?.[1];
  assert.ok(writer);
  const dir = mkdtempSync(join(tmpdir(), "qualification-"));
  const result = spawnSync("bash", ["-euc", `mkdir passive; ${writer}`], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DEPLOYED_SHA: target },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    await fetchLedgers({
      runs: [e2eRun(9, { head_sha: "c".repeat(40) })],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
      commit: readFileSync(join(dir, "passive/commit"), "utf8").trim(),
    }),
    { runId: 9, artifactId: 77 },
  );
});

test("staging qualification refuses A after B replaces it and locks every measurement against deploys", async () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  const deploy = read("../.github/workflows/deploy.yml");
  assert.match(
    deploy,
    /concurrency:\n {6}group: deploy-staging\n {6}cancel-in-progress: false\n {6}queue: max\n/,
  );
  assert.match(workflow, /concurrency:\n[\s\S]*?group: >-\n[\s\S]*?'deploy-staging'/);
  assert.match(workflow, /^ {2}cancel-in-progress: false\n {2}queue: max\n/m);
  for (const job of ["zap-baseline", "staging-passive", "staging-journeys", "staging-quality"]) {
    const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
    assert.match(body, /needs: scope\n/, `${job} must await the under-lock identity check`);
    assert.match(body, /(?:ref|checkout_ref): \$\{\{ needs\.scope\.outputs\.sha \}\}/);
  }
  assert.match(
    workflow,
    /needs: \[scope, zap-baseline, staging-passive, staging-journeys, staging-quality\]/,
  );
  assert.match(workflow, /run: node ci\/staging-qualification\.mjs --verify/);
  const target = qualificationTarget(qualificationContext());
  await requireQualificationRevision(target, revisionOptions(SHA));
  await assert.rejects(
    requireQualificationRevision(target, revisionOptions("b".repeat(40))),
    /expected a{40}/,
  );
  // An unreadable/malformed marker must fail, not credit B's healthy pages.
  await assert.rejects(
    requireQualificationRevision(target, revisionOptions(null)),
    /expected a{40}/,
  );
  await assert.rejects(
    requireQualificationRevision(target, {
      log: () => {},
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    /request failed/,
  );
});

test("qualification target refuses malformed or foreign deploy identities and non-main dispatches", () => {
  for (const patch of [
    { display_title: `deploy ${SHA} extra` },
    { display_title: null },
    { display_title: `deploy ${"A".repeat(40)}` },
    { conclusion: "failure" },
    { head_branch: "feature" },
    { path: ".github/workflows/ci.yml" },
    { head_repository: { full_name: "other/repo" } },
    { event: "pull_request" },
  ]) {
    const context = qualificationContext();
    Object.assign(context.event.workflow_run, patch);
    assert.throws(() => qualificationTarget(context));
  }
  const manual = { ...qualificationContext(), eventName: "workflow_dispatch", sha: SHA };
  assert.equal(qualificationTarget(manual), SHA);
  assert.throws(() => qualificationTarget({ ...manual, ref: "refs/heads/feature" }), /main-only/);
  assert.throws(() => qualificationTarget({ ...manual, sha: "bad" }), /Invalid deployed/);
  assert.throws(() => qualificationTarget({ ...manual, repository: "other/repo" }), /repository/);
  assert.throws(() => qualificationTarget({ ...manual, eventName: "push" }), /Unsupported/);
});

// Offline model of GitHub's documented concurrency queue semantics. It is a
// deterministic specification fixture, not an observation of live behavior.
// One group runs at most one entrant. `queue: single` (the default) keeps one
// pending entrant and cancels the older pending one when another arrives.
// `queue: max` keeps up to `limit` pending entrants (this illustrative trace pops from
// the front; it does not claim GitHub guarantees FIFO order) and
// cancels the NEW arrival once the queue is full. A running entrant is never
// cancelled while cancel-in-progress is false.
function concurrencyGroup({ queue = "single", limit = 100 } = {}) {
  const state = { running: null, pending: [], cancelled: [], mutations: [] };
  const promote = () => {
    state.running = state.pending.shift() ?? null;
  };
  return {
    state,
    arrive(entrant) {
      if (!state.running) {
        state.running = entrant;
      } else if (queue === "max") {
        if (state.pending.length >= limit) state.cancelled.push(entrant);
        else state.pending.push(entrant);
      } else {
        if (state.pending.length) state.cancelled.push(state.pending.pop());
        state.pending.push(entrant);
      }
    },
    // Only the entrant holding the group may mutate staging.
    mutate(entrant) {
      if (state.running !== entrant) return false;
      state.mutations.push(entrant);
      return true;
    },
    finish() {
      promote();
    },
  };
}

test("model: default single queue lets qualification A displace pending deploy B", () => {
  const group = concurrencyGroup();
  group.arrive("deploy-running");
  group.arrive("deploy-B");
  group.arrive("qualification-A");
  assert.deepEqual(group.state.cancelled, ["deploy-B"]);
  assert.deepEqual(group.state.pending, ["qualification-A"]);
});

test("model: queue max retains pending B and a full queue cancels the new arrival", () => {
  const group = concurrencyGroup({ queue: "max" });
  group.arrive("deploy-running");
  group.arrive("deploy-B");
  group.arrive("qualification-A");
  assert.deepEqual(group.state.cancelled, []);
  assert.deepEqual(group.state.pending, ["deploy-B", "qualification-A"]);

  const full = concurrencyGroup({ queue: "max" });
  full.arrive("running");
  for (let index = 0; index < 100; index += 1) full.arrive(`pending-${index}`);
  assert.equal(full.state.pending.length, 100);
  full.arrive("new-arrival");
  assert.deepEqual(full.state.cancelled, ["new-arrival"]);
  assert.equal(full.state.pending[0], "pending-0");
  assert.equal(full.state.pending.length, 100);
});

test("model: A queued behind B fails the revision check instead of borrowing B", async () => {
  const group = concurrencyGroup({ queue: "max" });
  group.arrive("deploy-running");
  group.arrive("deploy-B");
  group.arrive("qualification-A");
  group.finish();
  assert.equal(group.state.running, "deploy-B");
  group.finish();
  assert.equal(group.state.running, "qualification-A");
  // B deployed first, so staging now reports B's commit to A's lock.
  await assert.rejects(
    requireQualificationRevision(SHA, revisionOptions("b".repeat(40))),
    /expected a{40}/,
  );
});

test("model: B and a staging restore of A cannot mutate while A holds the whole-workflow lock", () => {
  const group = concurrencyGroup({ queue: "max" });
  group.arrive("qualification-A");
  group.arrive("deploy-B");
  group.arrive("restore-A");
  assert.equal(group.mutate("deploy-B"), false);
  assert.equal(group.mutate("restore-A"), false);
  assert.deepEqual(group.state.mutations, []);
  group.finish();
  assert.equal(group.mutate("deploy-B"), true);
  assert.equal(group.mutate("restore-A"), false);
});

// Every managed entrant of the shared staging group must queue and never cancel.
function stagingEntrantViolations(files) {
  const found = [];
  for (const [label, text] of Object.entries(files)) {
    for (const match of text.matchAll(/^( *)concurrency:\n((?:\1 {2}.*\n)+)/gm)) {
      if (!match[2].includes("deploy-staging")) continue;
      found.push({ label, ok: /cancel-in-progress: false\n\s+queue: max\n/.test(match[2]) });
    }
  }
  return found;
}

test("every deploy-staging entrant sets cancel-in-progress false and queue max", () => {
  const files = Object.fromEntries(
    readdirSync(new URL("../.github/workflows/", import.meta.url))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => [name, read(`../.github/workflows/${name}`)]),
  );
  const entrants = stagingEntrantViolations(files);
  assert.deepEqual(entrants.map((entrant) => entrant.label).sort(), [
    "deploy.yml",
    "e2e-staging.yml",
    "rollback-production.yml",
  ]);
  assert.deepEqual(
    entrants.filter((entrant) => !entrant.ok),
    [],
  );
  // Control: an entrant left on the default queue is detected.
  const defaulted = {
    "fixture.yml":
      "jobs:\n  x:\n    concurrency:\n      group: deploy-staging\n      cancel-in-progress: false\n    runs-on: x\n",
  };
  assert.deepEqual(stagingEntrantViolations(defaulted), [{ label: "fixture.yml", ok: false }]);
});

test("queue compatibility is tested by the blocking original-workflow linter and native PR smoke", () => {
  const ci = read("../.github/workflows/ci.yml");
  const build = read("./actionlint/build.sh");
  const scope = ci.split("\n  scope:\n")[1].split("\n  queue-syntax-smoke:\n")[0];
  assert.match(scope, /run: bash ci\/actionlint\/build\.sh/);
  assert.match(build, /git -C "\$src" apply --check/);
  assert.match(build, /test -count=1 -v \.\/\.\.\./);
  assert.match(build, /\[\[ -d "\$src\/\.github\/workflows" && ! -e "\$src\/\.git" \]\]/);
  assert.match(build, /mkdir "\$src\/\.git"/);
  assert.match(build, /apply --check --verbose/);
  assert.match(build, /'offset\|fuzz\|already applied'/);
  assert.match(build, /HTTP fixture requires serial package tests/);
  assert.match(build, /apply_patch test-harness\nrun_tests stock/);
  assert.match(build, /run_tests stock\nsha256sum -c "\$work\/grammar\.sha256"\napply_patch queue/);
  assert.match(build, /run_tests queue/);
  assert.ok(
    build.indexOf('build -trimpath -o "$work/stock-actionlint"') <
      build.indexOf("apply_patch test-harness"),
  );
  const harness = read("./actionlint/test-harness.patch");
  assert.deepEqual(
    [...harness.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
    [
      "linter_test.go",
      "testdata/format/test.sarif",
      "scripts/generate-popular-actions/main_test.go",
    ],
  );
  assert.match(harness, /debug\.ReadBuildInfo\(\)/);
  assert.match(harness, /info\.Main\.Version != "\(devel\)"/);
  assert.match(harness, /TestDetectAbsentReleaseNotFound/);
  assert.match(harness, /t\.Cleanup\(func\(\)/);
  assert.match(harness, /http\.DefaultTransport = previous/);
  assert.match(harness, /req\.Method != http\.MethodHead/);
  assert.doesNotMatch(harness, /^\+.*(?:t\.Skip|t\.Parallel|http\.DefaultClient)/m);
  // No existing Go assertion or production implementation is removed.
  assert.deepEqual(
    harness.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")),
    ['-          "version": "",'],
  );
  assert.match(
    build,
    /node "\$root\/ci\/actionlint\/queue-cli\.mjs" "\$work\/stock-actionlint" "\$work\/actionlint"/,
  );
  assert.match(build, /"\$work\/actionlint" -shellcheck= -pyflakes=\n/);
  assert.doesNotMatch(build, /-ignore|continue-on-error|\|\| true/);
  const smoke = ci.split("\n  queue-syntax-smoke:\n")[1].split("\n  docs-links:\n")[0];
  assert.match(smoke, /if: github\.event_name == 'pull_request'/);
  assert.match(
    smoke,
    /group: queue-syntax-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(smoke, /cancel-in-progress: false\n {6}queue: max/);
  assert.match(smoke, /permissions: \{\}/);
  assert.match(smoke, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(smoke, /secrets\.|environment:|deploy-staging/);
  const qualification = read("../.github/workflows/e2e-staging.yml");
  const final = qualification.split("\n  qualification-revision:\n")[1];
  assert.match(
    final,
    /needs: \[scope, zap-baseline, staging-passive, staging-journeys, staging-quality\]/,
  );
  // Implicit success() requires every measurement; cancellation, failure or a
  // skipped dependency cannot schedule a successful final verification.
  assert.doesNotMatch(final, /\n {4}if:|continue-on-error/);
  assert.match(final, /run: node ci\/staging-qualification\.mjs --verify/);
  assert.match(final, /DEPLOYED_SHA: \$\{\{ needs\.scope\.outputs\.sha \}\}/);
});

test("qualification target also refuses an incomplete deploy run and a truncated SHA title", () => {
  for (const patch of [
    { status: "in_progress" },
    { status: undefined },
    { display_title: `deploy ${SHA.slice(0, 39)}` },
    { display_title: `deploy  ${SHA}` },
  ]) {
    const context = qualificationContext();
    Object.assign(context.event.workflow_run, patch);
    assert.throws(() => qualificationTarget(context));
  }
});

test("watch config writes the journey ledger only when asked", () => {
  const reporters = (ledger) => {
    const env = {
      PATH: process.env.PATH,
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "Linux",
      WATCH_ORIGIN: "https://next.togetherweown.com",
    };
    if (ledger !== undefined) env.PLAYWRIGHT_JSON_OUTPUT_FILE = ledger;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./playwright.watch.config.ts').then((m) => console.log(JSON.stringify(m.default.reporter)))",
      ],
      { encoding: "utf8", cwd: new URL("..", import.meta.url), env },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").pop());
  };
  // The passive-set steps set PLAYWRIGHT_JSON_OUTPUT_FILE, so the JSON
  // reporter writes the report journeyOutcomes() reads.
  assert.deepEqual(reporters("passive/journeys.json"), [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "passive/journeys.json" }],
  ]);
  // The 48h watch leaves it unset and keeps list+html only.
  assert.deepEqual(reporters(undefined), [["list"], ["html", { open: "never" }]]);
});

test("deploy-production runs the regression check before the deploy job", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const job = (name, next) =>
    workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));
  const regression = job("regression", "deploy-production");
  assert.match(regression, /needs: \[preflight, staging-soak\]/);
  assert.match(regression, /environment:\n {6}name: production\n/);
  // Least privilege: analytics reads use the repo-level read-only token, so
  // the regression check never holds the production deployment token. The
  // Environment binding stays as the reviewer checkpoint before the deploy.
  assert.match(regression, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CF_ANALYTICS_READ_TOKEN \}\}/);
  assert.match(
    regression,
    /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.ok(
    !regression.includes("secrets.PRODUCTION_CLOUDFLARE_API_TOKEN"),
    "the regression check never sees the deployment token",
  );
  assert.match(
    regression,
    /run: node gate-tip\/ci\/production-deploy-gate\.mjs --fetch-passive-ledgers/,
  );
  assert.match(
    regression,
    /node bin\/smoke\.mjs https:\/\/togetherweown\.com --allow-indexable --ledger "\$RUNNER_TEMP\/production\/smoke\.json"/,
  );
  // Bare --config, like the staging side: a CLI --reporter flag would
  // shadow the config reporters and the journey ledger would never be
  // written, so --regression would refuse every promotion on a missing file.
  assert.match(regression, /npx playwright test --config playwright\.watch\.config\.ts\n/);
  assert.ok(
    !/--reporter/.test(regression),
    "the production passive set must not shadow the config reporters",
  );
  assert.match(
    regression,
    /PLAYWRIGHT_JSON_OUTPUT_FILE: \$\{\{ runner\.temp \}\}\/production\/journeys\.json/,
  );
  assert.match(regression, /WATCH_ORIGIN: https:\/\/togetherweown\.com/);
  assert.match(regression, /SMOKE_ALLOW_MISSING_BASELINE: "1"/);
  assert.match(regression, /run: node gate-tip\/ci\/production-deploy-gate\.mjs --regression\n/);
  assert.match(
    regression,
    /STAGING_SOAK_REQUESTS: \$\{\{ needs\.staging-soak\.outputs\.requests \}\}/,
  );
  // The gate runs from the tip, the checkers from the candidate.
  assert.match(regression, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
  assert.match(regression, /ref: \$\{\{ github\.sha \}\}\n {10}path: gate-tip\n/);
  const deploy = job("deploy-production", "post-deploy-watch");
  assert.match(deploy, /\n {4}needs: \[preflight, regression\]\n/);
});

test("staging soak sample spans the candidate version's life, at most 24 hours", async () => {
  const { stagingSoakSample } = await import("./production-deploy-gate.mjs");
  for (const [createdOn, since] of [
    ["2026-11-01T10:00:00Z", "2026-11-01T10:00:00.000Z"],
    ["2026-10-20T10:00:00Z", "2026-10-31T12:00:00.000Z"],
  ]) {
    const seen = [];
    const versions = versionsApi([[version(VERSION, SHA, createdOn)]]);
    const sums = analytics(500, 2, seen);
    const sample = await stagingSoakSample(
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fixture-only", DEPLOY_SHA: SHA },
      {
        fetchImpl: (url, init) =>
          url.includes("/graphql") ? sums(url, init) : versions(url, init),
        nowMs: Date.parse("2026-11-01T12:00:00Z"),
      },
    );
    assert.deepEqual(sample, { versionIds: [VERSION], createdOn, requests: 500, errors: 2 });
    assert.deepEqual(seen, [
      {
        scriptName: "two-web-next",
        datetime_geq: since,
        datetime_leq: "2026-11-01T12:00:00.000Z",
        scriptVersion: VERSION,
      },
    ]);
  }
});

function stagingRunsApi(runs, { status = 200 } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(`/commits/${SHA}`)) {
      return {
        ok: true,
        json: async () => ({ commit: { committer: { date: "2026-10-30T00:00:00Z" } } }),
      };
    }
    assert.ok(parsed.pathname.endsWith("/actions/workflows/e2e-staging.yml/runs"));
    assert.equal(parsed.searchParams.get("created"), ">=2026-10-29T00:00:00.000Z");
    if (status !== 200) return { ok: false, status };
    const page = Number(parsed.searchParams.get("page"));
    return {
      ok: true,
      json: async () => ({ workflow_runs: runs.slice((page - 1) * 100, page * 100) }),
    };
  };
}
const stagingPass = (id, updated_at) => ({
  id,
  display_title: `e2e-staging deploy ${SHA}`,
  head_branch: "main",
  path: ".github/workflows/e2e-staging.yml",
  head_repository: { full_name: "fixture/repo" },
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  updated_at,
});
const soakArgs = { repository: "fixture/repo", sha: SHA };
const soakOpts = (fetchImpl, nowMs = Date.parse("2026-11-01T12:00:00Z")) => ({
  token: "fixture-only",
  fetchImpl,
  nowMs,
});

test("reviewer mode ages a staging pass approved early, and only when one exists", async () => {
  const young = "2026-11-01T11:50:00.000Z";
  await assert.rejects(
    requireStagingSoakIfEvident(soakArgs, soakOpts(stagingRunsApi([stagingPass(7, young)]))),
    /e2e-staging\.yml run 7 has not soaked 30 minutes since it passed/,
  );
  for (const updated_at of [undefined, "yesterday"]) {
    await assert.rejects(
      requireStagingSoakIfEvident(soakArgs, soakOpts(stagingRunsApi([stagingPass(7, updated_at)]))),
      /has not soaked 30 minutes since it passed/,
    );
  }
  assert.deepEqual(
    await requireStagingSoakIfEvident(
      soakArgs,
      soakOpts(stagingRunsApi([stagingPass(7, "2026-11-01T11:29:00.000Z")])),
    ),
    { runId: 7 },
  );
  // No run names the SHA: the reviewer's approval is the gate.
  assert.equal(await requireStagingSoakIfEvident(soakArgs, soakOpts(stagingRunsApi([]))), null);
  assert.equal(
    await requireStagingSoakIfEvident(
      soakArgs,
      soakOpts(
        stagingRunsApi([{ ...stagingPass(7, young), status: "in_progress", conclusion: null }]),
      ),
    ),
    null,
  );
  // A pass from another branch or workflow is not evidence for this SHA.
  await assert.rejects(
    requireStagingSoakIfEvident(
      soakArgs,
      soakOpts(stagingRunsApi([{ ...stagingPass(7, young), head_branch: "feature" }])),
    ),
    /revision\/branch\/workflow mismatch/,
  );
  // An unreadable lookup fails closed, never as silent no-evidence.
  await assert.rejects(
    requireStagingSoakIfEvident(soakArgs, soakOpts(stagingRunsApi([], { status: 403 }))),
    /Staging soak lookup failed \(HTTP 403\)/,
  );
});

test("reviewer mode refuses a SHA whose staging went red or was re-run, never only the latest attempt", async () => {
  const old = "2026-11-01T11:00:00.000Z";
  // The 9ee70484 case: attempt 1 failed, attempt 2 passed. The run list shows
  // only attempt 2, so the re-run itself is the red evidence.
  for (const run_attempt of [2, 3, undefined]) {
    await assert.rejects(
      requireStagingSoakIfEvident(
        soakArgs,
        soakOpts(stagingRunsApi([{ ...stagingPass(7, old), run_attempt }])),
      ),
      /run 7 on [0-9a-f]{40} failed or was re-run .*fix forward with a new commit/,
      `attempt ${run_attempt}`,
    );
  }
  // A failed run is red evidence the reviewer cannot approve past, and a newer
  // first-attempt pass of the same SHA (a re-run deploy) does not outvote it.
  for (const conclusion of ["failure", "timed_out"]) {
    await assert.rejects(
      requireStagingSoakIfEvident(
        soakArgs,
        soakOpts(stagingRunsApi([stagingPass(8, old), { ...stagingPass(7, old), conclusion }])),
      ),
      /run 7 on [0-9a-f]{40} failed or was re-run/,
      conclusion,
    );
  }
  // The whole history of the SHA decides, not a window: a failed run behind
  // 350 runs of other commits still refuses the reviewer's approval.
  const other = { display_title: `e2e-staging deploy ${"e".repeat(40)}` };
  const filler = Array.from({ length: 350 }, (_, i) => ({
    ...stagingPass(500 - i, old),
    ...other,
  }));
  await assert.rejects(
    requireStagingSoakIfEvident(
      soakArgs,
      soakOpts(
        stagingRunsApi([
          stagingPass(900, old),
          ...filler,
          { ...stagingPass(7, old), conclusion: "failure" },
        ]),
      ),
    ),
    /run 7 on [0-9a-f]{40} failed or was re-run/,
  );
  // Positive control: a cancelled first attempt is not red, and the newer pass soaks.
  assert.deepEqual(
    await requireStagingSoakIfEvident(
      soakArgs,
      soakOpts(
        stagingRunsApi([stagingPass(8, old), { ...stagingPass(7, old), conclusion: "cancelled" }]),
      ),
    ),
    { runId: 8 },
  );
});

test("a passive ledger run without an integer id is refused", async () => {
  await assert.rejects(
    fetchLedgers({
      runs: [{ id: "9", display_title: `e2e-staging deploy ${SHA}` }],
      artifacts: [],
    }),
    /invalid run id/,
  );
});

test("an oversized passive ledger zip is refused before it touches disk", async () => {
  assert.equal(PASSIVE_LEDGER_MAX_BYTES, 8 * 1024 * 1024);
  await assert.rejects(
    fetchLedgers({
      runs: [e2eRun(9)],
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
      commit: "x".repeat(PASSIVE_LEDGER_MAX_BYTES + 1),
    }),
    /over the 8388608-byte limit/,
  );
});

test("a passive ledger zip exactly at the size limit is accepted", async () => {
  // The inclusive boundary: the guard rejects over the limit, not at it.
  // Trailing spaces survive the stub unzip and trim away, so the payload is
  // exactly the limit while still naming the candidate.
  const result = await fetchLedgers({
    runs: [e2eRun(9)],
    artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    commit: `${SHA}${" ".repeat(PASSIVE_LEDGER_MAX_BYTES - SHA.length)}`,
  });
  assert.deepEqual(result, { runId: 9, artifactId: 77 });
});

test("staging soak sample sums every tagged version over one window", async () => {
  const older = "00000000-0000-4000-8000-000000000000";
  const seen = [];
  const versions = versionsApi([
    [version(VERSION, SHA, "2026-11-01T11:00:00Z"), version(older, SHA, "2026-11-01T10:00:00Z")],
  ]);
  const sums = analytics(500, 2, seen);
  const sample = await stagingSoakSample(
    { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fixture-only", DEPLOY_SHA: SHA },
    {
      fetchImpl: (url, init) => (url.includes("/graphql") ? sums(url, init) : versions(url, init)),
      nowMs: Date.parse("2026-11-01T12:00:00Z"),
    },
  );
  // Each invocation belongs to exactly one version, so one window per version
  // never double-counts: 500 requests and 2 errors on each of the two.
  assert.deepEqual(sample, {
    versionIds: [older, VERSION],
    createdOn: "2026-11-01T10:00:00Z",
    requests: 1000,
    errors: 4,
  });
  assert.deepEqual(
    seen.map((filter) => filter.scriptVersion),
    [older, VERSION],
  );
  assert.equal(seen[0].datetime_geq, "2026-11-01T10:00:00.000Z");
});
