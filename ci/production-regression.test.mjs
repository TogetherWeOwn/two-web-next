import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SOAK_ERROR_RATE_FLOOR,
  SOAK_ERROR_RATE_MARGIN,
  buildScriptErrorQuery,
  checkRegression,
  evaluateSoakErrorRate,
  fetchPassiveLedgers,
  journeyOutcomes,
  regressionsAgainstProduction,
  smokeOutcomes,
  stagingCandidateVersion,
  sumScriptErrors,
} from "./production-deploy-gate.mjs";

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
  for (const pages of [[[]], [[version(VERSION, SHA), version(VERSION, SHA)]]]) {
    await assert.rejects(
      stagingCandidateVersion(
        { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
        { fetchImpl: versionsApi(pages) },
      ),
      /Expected one staging version tagged/,
    );
  }
  await assert.rejects(
    stagingCandidateVersion(
      { accountId: ACCOUNT, token: "fixture-only", sha: SHA },
      { fetchImpl: versionsApi([[version(VERSION, SHA, "never")]]) },
    ),
    /no creation time/,
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

const e2eRun = (id) => ({ id, display_title: `e2e-staging deploy ${SHA}` });

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
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("e2e-staging records the passive set for every promotable deploy", () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  const job = workflow.slice(
    workflow.indexOf("\n  staging-passive:\n"),
    workflow.indexOf("\n  staging-journeys:\n"),
  );
  assert.match(job, /needs\.scope\.outputs\.skip_e2e != 'true'/);
  assert.match(
    job,
    /ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/,
  );
  assert.match(
    job,
    /node bin\/smoke\.mjs https:\/\/next\.togetherweown\.com --ledger passive\/smoke\.json/,
  );
  assert.match(
    job,
    /npx playwright test --config playwright\.watch\.config\.ts --reporter=list,json/,
  );
  assert.match(job, /PLAYWRIGHT_JSON_OUTPUT_FILE: passive\/journeys\.json/);
  assert.match(job, /WATCH_ORIGIN: https:\/\/next\.togetherweown\.com/);
  assert.match(job, /SMOKE_ALLOW_MISSING_BASELINE: "1"/);
  assert.match(job, /name: staging-passive-ledger-\$\{\{ github\.run_id \}\}/);
  assert.ok(!/secrets\./.test(job), "the passive set needs no secrets");
});

test("deploy-production runs the regression check before the deploy job", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const job = (name, next) =>
    workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));
  const regression = job("regression", "deploy-production");
  assert.match(regression, /needs: \[preflight, staging-soak\]/);
  assert.match(regression, /environment:\n {6}name: production\n/);
  assert.match(
    regression,
    /run: node gate-tip\/ci\/production-deploy-gate\.mjs --fetch-passive-ledgers/,
  );
  assert.match(
    regression,
    /node bin\/smoke\.mjs https:\/\/togetherweown\.com --allow-indexable --ledger "\$RUNNER_TEMP\/production\/smoke\.json"/,
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
    assert.deepEqual(sample, { versionId: VERSION, createdOn, requests: 500, errors: 2 });
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
