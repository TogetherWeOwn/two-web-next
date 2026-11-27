import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { first, preRollback, soakEnv, trustedReads } from "../test/fixtures/staging-soak-http.mjs";
import soakFixture from "../test/fixtures/staging-soak-receipt.json" with { type: "json" };
import { STAGING_ORIGIN } from "./operator-constants.mjs";
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
  verifyAllocationSoak,
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

const invocationRows = (sums) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: sums.map((sum) => ({ sum })) }] } },
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
  assert.deepEqual(
    sumScriptErrors(
      invocationRows([
        { requests: 10, errors: 1 },
        { requests: 5, errors: 0 },
      ]),
    ),
    { requests: 15, errors: 1 },
  );
  assert.deepEqual(sumScriptErrors(invocationRows([])), { requests: 0, errors: 0 });
  assert.throws(() => sumScriptErrors({ errors: [{ message: "x" }] }), /returned errors/);
  assert.throws(() => sumScriptErrors({ data: {} }), /no invocation rows/);
  assert.throws(
    () => sumScriptErrors(invocationRows([{ requests: "1", errors: 0 }])),
    /invalid sums/,
  );
});

function analytics(requests, errors, seen = []) {
  return async (url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    const body = JSON.parse(init.body);
    seen.push(body.variables.filter);
    return Response.json(invocationRows([{ requests, errors }]));
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

test("the regression gate refuses a recorded staging soak with elevated errors", async () => {
  const { sha, workerVersion, deployedAt, floorAt } = soakFixture.receipt;
  const nowMs = Date.parse(floorAt);
  const env = soakEnv({ accountId: ACCOUNT, token: "fixture-only" });
  const capture = (errors) =>
    verifyAllocationSoak(env, {
      now: () => nowMs,
      fetchImpl: trustedReads(
        {
          fetchImpl: async (input, init) => {
            const url = String(input);
            if (url === `${STAGING_ORIGIN}/version`) return Response.json({ sha, deployedAt });
            if (url === `${STAGING_ORIGIN}/up`) {
              return Response.json(
                { revision: { commit: sha, version_id: workerVersion } },
                { headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" } },
              );
            }
            assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
            assert.deepEqual(JSON.parse(init.body).variables, {
              accountTag: ACCOUNT,
              scriptName: "two-web-next",
              versionId: workerVersion,
              since: preRollback.run_started_at,
              until: floorAt,
            });
            const row = {
              dimensions: { scriptVersion: workerVersion },
              sum: { requests: 100, errors },
            };
            return Response.json({
              data: { viewer: { accounts: [{ workersInvocationsAdaptive: [row] }] } },
            });
          },
        },
        { deployments: () => [first], run: preRollback },
      ),
    });
  const qualify = ({ sample }) =>
    checkRegression(
      regressionEnv(green, {
        STAGING_SOAK_REQUESTS: String(sample.requests),
        STAGING_SOAK_ERRORS: String(sample.errors),
      }),
      {
        readJson: (path) => structuredClone(green[path]),
        fetchImpl: analytics(10_000, 100),
        nowMs,
      },
    );

  const elevated = await capture(2);
  await assert.rejects(qualify(elevated), /staging error rate 0\.0200 exceeds the limit 0\.0150/);
  const clean = await capture(0);
  const result = await qualify(clean);
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.staging, { requests: 100, errors: 0 });

  assert.deepEqual(elevated, {
    schema: "staging-soak/2",
    sha,
    allocationId: first.id,
    allocationStartedAt: "2026-01-01T10:01:00.123456000Z",
    workerVersion,
    e2e: {
      runId: preRollback.id,
      startedAt: preRollback.run_started_at,
      completedAt: preRollback.updated_at,
    },
    deployedAt,
    e2eCompletedAt: "2026-01-01T10:09:00.000Z",
    floorAt,
    status: "sampled",
    sample: { observedAt: floorAt, workerVersion, requests: 100, errors: 2 },
  });
  assert.deepEqual(clean, { ...elevated, sample: { ...elevated.sample, errors: 0 } });
});

function versionsApi(pages, seen = []) {
  return async (url, init) => {
    const parsed = new URL(url);
    assert.equal(
      parsed.pathname,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/two-web-next/versions`,
    );
    assert.equal(init.headers.authorization, "Bearer fixture-only");
    assert.equal(parsed.searchParams.get("per_page"), "100");
    const page = Number(parsed.searchParams.get("page"));
    seen.push(page);
    const items = pages[page - 1] ?? [];
    return items instanceof Response ? items : Response.json({ result: { items } });
  };
}
const version = (id, tag, created_on = "2026-11-01T10:00:00Z") => ({
  id,
  annotations: { "workers/tag": tag },
  metadata: { created_on },
});

test("Worker analytics sample caps streamed bytes before production or legacy staging can accept it", async () => {
  const payload = Buffer.from(
    JSON.stringify({
      ...invocationRows([
        { requests: 500, errors: 2 },
        { requests: 100, errors: 1 },
      ]),
      extensions: { fixture: "é".repeat(100) },
    }),
  );
  const split = payload.indexOf("é") + 1;
  const padding = Buffer.alloc(1024 * 1024 - payload.length, " ");
  const versions = versionsApi([[version(VERSION, SHA)]]);
  const legacySoak = (fetchImpl) =>
    stagingSoakSample(
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fixture-only", DEPLOY_SHA: SHA },
      {
        fetchImpl: (url, init) =>
          url.endsWith("/graphql") ? fetchImpl(url, init) : versions(url, init),
        nowMs: Date.parse("2026-11-01T12:00:00Z"),
      },
    );

  for (const sample of [
    async (fetchImpl) => (await regression(green, {}, fetchImpl)).production,
    legacySoak,
  ]) {
    const validBody = new ReadableStream({
      start(controller) {
        controller.enqueue(payload.subarray(0, split));
        controller.enqueue(payload.subarray(split));
        controller.enqueue(padding);
        controller.close();
      },
    });
    const { requests, errors } = await sample(async () => new Response(validBody));
    assert.deepEqual({ requests, errors }, { requests: 600, errors: 3 });

    let pulls = 0;
    let cancelled = false;
    const chunks = [payload, padding, Buffer.from(" "), Buffer.from(" ")];
    const body = new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      sample(async () => new Response(body)),
      {
        message: "Workers analytics response exceeds 1 MiB",
      },
    );
    assert.equal(pulls, 3);
    assert.equal(cancelled, true);

    await assert.rejects(
      sample(async () => new Response("private fixture content")),
      {
        message: "Workers analytics response is not readable JSON",
      },
    );
    await assert.rejects(
      sample(async () => new Response(null)),
      {
        message: "Workers analytics response has no body",
      },
    );
  }
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

function githubArtifacts({ runs, artifacts, commit = SHA, zipResponse, seen = {} }) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "blob.example") {
      seen.blobAuth = init.headers?.Authorization;
      return zipResponse ?? new Response(commit);
    }
    assert.equal(init.headers.Authorization, "Bearer fixture-only");
    if (parsed.pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    }
    if (/\/actions\/runs\/\d+$/.test(parsed.pathname)) {
      return Response.json(runs.find((run) => parsed.pathname.endsWith(`/${run.id}`)) ?? {});
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
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "passive-"));
  return fetchPassiveLedgers(
    {
      repository: "fixture/repo",
      sha: SHA,
      token: "fixture-only",
      dir,
      expectedRunId: options.expectedRunId,
    },
    {
      fetchImpl: githubArtifacts(options),
      // The fake archive carries the commit plus the producer's observations.
      unzip: (zip, out) => {
        unzipSeen.zip = zip;
        writeFileSync(join(out, "commit"), `${readFileSync(zip, "utf8")}\n`);
        const identity = { sha: SHA, deployedAt: "2026-01-01T00:00:00.000Z" };
        const identities = options.identities ?? { before: identity, after: identity };
        for (const [phase, value] of Object.entries(identities)) {
          writeFileSync(join(out, `identity.${phase}.json`), JSON.stringify(value));
        }
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

test("passive ledger selection requires valid GitHub listings", async (t) => {
  const firstPage = {
    workflow_runs: [
      e2eRun(9),
      ...Array.from({ length: 99 }, (_, index) =>
        e2eRun(index + 20, { display_title: "another candidate" }),
      ),
    ],
  };
  const listPath = "/actions/workflows/e2e-staging.yml/runs";
  const repositoryUrl = "https://api.github.com/repos/fixture/repo";
  const blobUrl = "https://storage.example/passive-ledger.zip";
  const malformedArtifactListing = {
    artifacts: [
      { id: 77, name: "staging-passive-ledger-9", expired: false },
      { id: 78, name: "staging-passive-ledger-9" },
    ],
  };

  async function checkListing({
    pages = [],
    artifacts,
    runId = 9,
    pinned = false,
    refusal,
    requests,
  }) {
    const dir = mkdtempSync(join(tmpdir(), "passive-listing-"));
    const visited = [];
    try {
      const result = fetchPassiveLedgers(
        {
          repository: "fixture/repo",
          sha: SHA,
          token: "fixture-only",
          dir,
          expectedRunId: pinned ? runId : undefined,
        },
        {
          fetchImpl: async (url) => {
            if (url === blobUrl) {
              visited.push("blob");
              return new Response("fixture");
            }
            assert.ok(url.startsWith(repositoryUrl));
            const { pathname, searchParams } = new URL(url);
            const path = pathname.slice("/repos/fixture/repo".length);
            if (path === listPath) {
              const page = Number(searchParams.get("page"));
              visited.push(`page ${page}`);
              assert.ok(page >= 1 && page <= pages.length);
              return Response.json(pages[page - 1]);
            }
            visited.push(path);
            if (pinned && path === `/actions/runs/${runId}`) {
              return Response.json(
                e2eRun(runId, { event: "workflow_run", run_attempt: 1, conclusion: "success" }),
              );
            }
            if (path === `/actions/runs/${runId}/artifacts`) {
              assert.equal(searchParams.get("name"), `staging-passive-ledger-${runId}`);
              return Response.json(
                artifacts ?? {
                  artifacts: [{ id: 77, name: `staging-passive-ledger-${runId}`, expired: false }],
                },
              );
            }
            assert.equal(path, "/actions/artifacts/77/zip");
            return new Response(null, { status: 302, headers: { location: blobUrl } });
          },
          unzip: (_zip, out) => {
            visited.push("unzip");
            writeFileSync(join(out, "commit"), SHA);
            const identity = JSON.stringify({ sha: SHA, deployedAt: "2026-01-01T00:00:00.000Z" });
            writeFileSync(join(out, "identity.before.json"), identity);
            writeFileSync(join(out, "identity.after.json"), identity);
          },
        },
      );
      if (refusal) {
        await assert.rejects(result, refusal);
      } else {
        assert.deepEqual(await result, { runId, artifactId: 77 });
      }
      assert.deepEqual(visited, requests);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  await t.test("an explicit empty run listing reports no candidate", async () => {
    await checkListing({
      pages: [{ workflow_runs: [] }],
      refusal: /No e2e-staging run/,
      requests: ["page 1"],
    });
  });
  for (const [label, workflowRuns, runId] of [
    ["an empty last page preserves the candidate", [], 9],
    ["an occupied later page can supply the newest candidate", [e2eRun(10)], 10],
  ]) {
    await t.test(label, async () => {
      await checkListing({
        pages: [firstPage, { workflow_runs: workflowRuns }],
        runId,
        requests: [
          "page 1",
          "page 2",
          `/actions/runs/${runId}/artifacts`,
          "/actions/artifacts/77/zip",
          "blob",
          "unzip",
        ],
      });
    });
  }
  for (const [label, page] of [
    ["missing workflow_runs", {}],
    ["null workflow_runs", { workflow_runs: null }],
    ["non-array workflow_runs", { workflow_runs: {} }],
    ["unclassifiable run", { workflow_runs: [{ id: 10 }] }],
  ]) {
    await t.test(`a later page with ${label} refuses before artifact lookup`, async () => {
      await checkListing({
        pages: [firstPage, page],
        refusal: /Malformed e2e-staging run listing on page 2/,
        requests: ["page 1", "page 2"],
      });
    });
  }
  await t.test("a matching run with ID zero refuses before artifact lookup", async () => {
    await checkListing({
      pages: [{ workflow_runs: [e2eRun(0)] }],
      runId: 0,
      refusal: /invalid run id/,
      requests: ["page 1"],
    });
  });
  for (const [label, artifacts, refusal] of [
    ["an empty array", { artifacts: [] }, /has no staging-passive-ledger-9 artifact/],
    ["a missing array", {}, /Malformed passive ledger artifact listing/],
    ["a non-array field", { artifacts: {} }, /Malformed passive ledger artifact listing/],
    [
      "an invalid row beside a valid artifact",
      malformedArtifactListing,
      /Malformed passive ledger artifact listing/,
    ],
    [
      "a zero artifact ID",
      { artifacts: [{ id: 0, name: "staging-passive-ledger-9", expired: false }] },
      /Malformed passive ledger artifact listing/,
    ],
  ]) {
    await t.test(`an artifact listing with ${label} refuses before download`, async () => {
      await checkListing({
        pages: [{ workflow_runs: [e2eRun(9)] }],
        artifacts,
        refusal,
        requests: ["page 1", "/actions/runs/9/artifacts"],
      });
    });
  }
  await t.test("a pinned run refuses a malformed artifact listing before download", async () => {
    await checkListing({
      pinned: true,
      artifacts: malformedArtifactListing,
      refusal: /Malformed passive ledger artifact listing/,
      requests: ["/actions/runs/9", "/actions/runs/9/artifacts"],
    });
  });
});

test("passive ledgers use the soak E2E run even when a newer run exists", async () => {
  const run = e2eRun(9, { event: "workflow_run", run_attempt: 1, conclusion: "success" });
  const seen = {};
  assert.deepEqual(
    await fetchLedgers({
      runs: [run, e2eRun(10)],
      seen,
      expectedRunId: 9,
      artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    }),
    { runId: 9, artifactId: 77 },
  );
  assert.equal(seen.artifactsRun, "9");
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

test("historical or changed staging identities cannot be promoted by a matching commit file", async () => {
  const valid = { sha: SHA, deployedAt: "2026-01-01T00:00:00.000Z" };
  for (const identities of [
    {},
    { before: valid },
    { after: valid },
    { before: null, after: valid },
    { before: valid, after: { ...valid, sha: "b".repeat(40) } },
    { before: { ...valid, sha: "b".repeat(40) }, after: valid },
    { before: valid, after: { ...valid, deployedAt: "2026-01-02T00:00:00.000Z" } },
    { before: valid, after: { ...valid, deployedAt: "not a timestamp" } },
  ]) {
    await assert.rejects(
      fetchLedgers({
        runs: [e2eRun(9)],
        artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
        identities,
      }),
      /lacks matching before\/after served identities/,
    );
  }
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("e2e-staging records the passive set for every promotable deploy", () => {
  const workflow = read("../.github/workflows/e2e-staging.yml");
  const job = workflow.slice(
    workflow.indexOf("\n  staging-passive:\n"),
    workflow.indexOf("\n  staging-journeys:\n"),
  );
  assert.match(job, /needs\.scope\.outputs\.skip_e2e != 'true'/);
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
  // The job checks out the workflow_run head, so it must not write caches
  // (CodeQL cache-poisoning): no setup-node npm cache, no actions/cache.
  assert.ok(!/cache: npm/.test(job), "the passive set must not use the npm cache");
  assert.ok(!/uses: actions\/cache@/.test(job), "the passive set must not write caches");
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
  assert.match(job("preflight", "staging-soak"), /INPUT_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(
    job("staging-soak", "regression"),
    /\n {6}errors: \$\{\{ steps\.soak\.outputs\.errors \}\}\n/,
  );
  assert.match(
    regression,
    /STAGING_E2E_RUN_ID: \$\{\{ needs\.staging-soak\.outputs\.e2e_run_id \}\}/,
  );
  assert.match(regression, /soak_attempt: \$\{\{ needs\.staging-soak\.outputs\.attempt \}\}/);
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
  assert.match(regression, /STAGING_SOAK_ERRORS: \$\{\{ needs\.staging-soak\.outputs\.errors \}\}/);
  // The gate runs from the tip, the checkers from the candidate.
  assert.match(regression, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
  assert.match(regression, /ref: \$\{\{ github\.sha \}\}\n {10}path: gate-tip\n/);
  const deploy = job("deploy-production", "post-deploy-watch");
  assert.match(deploy, /SOAK_ATTEMPT: \$\{\{ needs\.regression\.outputs\.soak_attempt \}\}/);
  assert.match(deploy, /if \[ "\$SOAK_ATTEMPT" != "\$GITHUB_RUN_ATTEMPT" \]/);
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
      json: async () => ({
        total_count: runs.length,
        workflow_runs: runs.slice((page - 1) * 100, page * 100),
      }),
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

test("an oversized passive ledger zip is refused before it touches disk", async (t) => {
  assert.equal(PASSIVE_LEDGER_MAX_BYTES, 8 * 1024 * 1024);
  const root = mkdtempSync(join(tmpdir(), "passive-ledger-overflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "unpublished");
  const unzipSeen = {};
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(PASSIVE_LEDGER_MAX_BYTES));
        else if (pulls === 2) controller.enqueue(new Uint8Array(1));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    fetchLedgers(
      {
        runs: [e2eRun(9)],
        artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
        dir,
        zipResponse: new Response(body, { headers: { "content-length": "1" } }),
      },
      unzipSeen,
    ),
    /over the 8388608-byte limit/,
  );
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
  assert.equal(unzipSeen.zip, undefined);
  assert.equal(existsSync(dir), false);
});

test("a passive ledger zip read failure is refused without exposing provider data", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "passive-ledger-read-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "unpublished");
  const unzipSeen = {};
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("synthetic storage diagnostic"));
    },
  });
  await assert.rejects(
    fetchLedgers(
      {
        runs: [e2eRun(9)],
        artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
        dir,
        zipResponse: new Response(body),
      },
      unzipSeen,
    ),
    { message: "Passive ledger zip could not be read" },
  );
  assert.equal(unzipSeen.zip, undefined);
  assert.equal(existsSync(dir), false);
});

test("a passive ledger zip exactly at the size limit is accepted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "passive-ledger-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Split the candidate SHA across chunks. Trailing spaces fill the exact limit
  // and survive the stub unzip before the gate trims the commit file.
  const bytes = Buffer.from(SHA.padEnd(PASSIVE_LEDGER_MAX_BYTES));
  const split = SHA.length / 2;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  });
  const result = await fetchLedgers({
    runs: [e2eRun(9)],
    artifacts: [{ id: 77, name: "staging-passive-ledger-9", expired: false }],
    dir,
    zipResponse: new Response(body),
  });
  assert.deepEqual(result, { runId: 9, artifactId: 77 });
  assert.ok(readFileSync(join(dir, "ledger.zip")).equals(bytes));
});

test("legacy staging soak requires complete bounded history across pages", async () => {
  const older = "00000000-0000-4000-8000-000000000000";
  const nonmatch = "22222222-2222-4222-8222-222222222222";
  const seen = [];
  const seenPages = [];
  const firstPage = [
    version(VERSION, SHA, "2026-11-01T11:00:00Z"),
    ...Array.from({ length: 99 }, () => version(nonmatch, `${SHA}-preview`)),
  ];
  const lastPage = JSON.stringify({ result: { items: [version(older, SHA)] }, padding: "é" });
  const pageLimit = 1024 * 1024;
  const atLimit = lastPage.padEnd(lastPage.length + pageLimit - Buffer.byteLength(lastPage));
  const sums = analytics(500, 2, seen);
  const readSoak = (last) => {
    const versions = versionsApi([firstPage, last], seenPages);
    return stagingSoakSample(
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fixture-only", DEPLOY_SHA: SHA },
      {
        fetchImpl: (url, init) =>
          url.includes("/graphql") ? sums(url, init) : versions(url, init),
        nowMs: Date.parse("2026-11-01T12:00:00Z"),
      },
    );
  };
  const sample = await readSoak(new Response(atLimit));
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
  assert.deepEqual(seenPages, [1, 2]);

  let pulls = 0;
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(Buffer.from(atLimit));
          else if (pulls === 2) controller.enqueue(Buffer.from(" "));
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-length": String(pageLimit) } },
  );
  for (const [response, message] of [
    [oversized, "Staging versions response exceeds the 1 MiB page limit"],
    [new Response(), "Staging versions response is unreadable or invalid JSON"],
    [new Response(""), "Staging versions response is unreadable or invalid JSON"],
    [
      new Response("fixture-only malformed JSON"),
      "Staging versions response is unreadable or invalid JSON",
    ],
    [
      Response.json({ result: { items: "fixture-only invalid items" } }),
      "Staging versions response has no items",
    ],
  ]) {
    seen.length = 0;
    seenPages.length = 0;
    await assert.rejects(readSoak(response), { message });
    assert.deepEqual(seenPages, [1, 2]);
    assert.deepEqual(seen, []);
  }
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});
