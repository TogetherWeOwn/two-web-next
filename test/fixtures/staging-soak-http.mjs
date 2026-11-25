import assert from "node:assert/strict";
import { STAGING_ORIGIN } from "../../ci/operator-constants.mjs";
import fixture from "./staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion } = fixture.receipt;
const identity = fixture.evidence.e2e.before;
const revision = { commit: sha, version_id: workerVersion };
export const graphUrl = "https://api.cloudflare.com/client/v4/graphql";
export const basePath = "/workers/scripts/two-web-next";
export const original = {
  id: "33333333-3333-3333-3333-333333333333",
  created_on: "2026-01-01T10:00:01.123456Z",
  versions: [{ version_id: workerVersion, percentage: 100 }],
};
export const rollback = {
  id: "44444444-4444-4444-4444-444444444444",
  created_on: "2026-01-01T10:41:00.123456Z",
  versions: [{ version_id: "22222222-2222-2222-2222-222222222222", percentage: 100 }],
};
export const restore = {
  ...original,
  id: "55555555-5555-5555-5555-555555555555",
  created_on: "2026-01-01T10:43:00.123456Z",
};
export const tag = (version = workerVersion, requests = 250, errors = 2) => ({
  dimensions: { scriptVersion: version },
  sum: { requests, errors },
});
export const graph = (...rows) => ({
  errors: null,
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

export function mockReads({
  versions = [identity, identity],
  revisions = [revision, revision],
  analytics = graph(tag()),
  headers = { "x-two-origin": "two-web-next", "cache-control": "no-store" },
  provider = () => [original],
  versionDetail = {
    id: workerVersion,
    annotations: { "workers/tag": sha },
    metadata: { created_on: identity.deployedAt },
  },
  upStatus = 200,
  nowMs = Date.parse(fixture.receipt.floorAt),
} = {}) {
  const calls = [];
  const queries = [];
  const accountId = "c".repeat(32);
  const providerUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}${basePath}`;
  const options = {
    accountId,
    token: "synthetic-analytics-token",
    now: () => nowMs,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(providerUrl)) {
        assert.equal(init.headers.authorization, `Bearer ${options.token}`);
        assert.equal(init.redirect, "error");
      }
      if (url === `${providerUrl}/deployments`) {
        return Response.json({ success: true, result: { deployments: provider() } });
      }
      if (url === `${providerUrl}/versions/${workerVersion}`) {
        return Response.json({ success: true, result: versionDetail });
      }
      if (url === `${STAGING_ORIGIN}/version`) return Response.json(versions.shift());
      if (url === `${STAGING_ORIGIN}/up`) {
        assert.deepEqual(init.headers, { "cache-control": "no-cache" });
        return Response.json({ revision: revisions.shift() }, { status: upStatus, headers });
      }
      assert.equal(url, graphUrl);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      queries.push(JSON.parse(init.body));
      return Response.json(analytics);
    },
  };
  return { calls, queries, options };
}
export const {
  sha: soakSha,
  workerVersion: soakVersion,
  e2eCompletedAt,
  floorAt: soakFloor,
} = fixture.receipt;
const e2eStartedAt = "2026-01-01T10:02:00Z";
export const afterSoak = () => Date.parse(soakFloor);
export const soakEnv = {
  CLOUDFLARE_ACCOUNT_ID: mockReads().options.accountId,
  CLOUDFLARE_API_TOKEN: mockReads().options.token,
  GITHUB_TOKEN: "fixture-github",
  GITHUB_REPOSITORY: "example/web",
  DEPLOY_SHA: soakSha,
};
export const successfulE2e = {
  id: 9,
  display_title: `e2e-staging deploy ${soakSha}`,
  status: "completed",
  head_branch: "main",
  path: ".github/workflows/e2e-staging.yml",
  event: "workflow_run",
  head_sha: soakSha,
  run_attempt: 1,
  head_repository: { full_name: soakEnv.GITHUB_REPOSITORY },
  conclusion: "success",
  run_started_at: e2eStartedAt,
  updated_at: e2eCompletedAt,
};
export const executedJobs = (run) =>
  [
    [
      "staging-journeys",
      ["Staging critical journeys", "Journey ledger (pass/skip/fail accounting)"],
    ],
    [
      "staging-passive",
      ["Passive set against staging (ledgers only)", "Staging passive ledger artifact"],
    ],
    [
      "staging-quality / quality",
      ["Web standards (security headers, HTML basics, internal links)"],
    ],
  ].map(([name, steps]) => ({
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
    started_at: run.run_started_at,
    completed_at: run.updated_at,
    steps: steps.map((name) => ({ name, status: "completed", conclusion: "success" })),
  }));

export function soakApi({
  runs = [successfulE2e],
  jobs = executedJobs(runs[0]),
  allocationStart = original.created_on,
} = {}) {
  const { options, queries } = mockReads({
    provider: () => [{ ...original, created_on: allocationStart }],
    analytics: graph(tag(soakVersion, 500)),
  });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== "api.github.com") return options.fetchImpl(input, init);
    assert.equal(init.headers.Authorization, "Bearer fixture-github");
    if (url.pathname.endsWith(`/commits/${soakSha}`)) {
      return Response.json({ commit: { committer: { date: original.created_on } } });
    }
    if (url.pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      return Response.json({ workflow_runs: runs });
    }
    assert.equal(url.pathname, `/repos/example/web/actions/runs/${runs[0].id}/attempts/1/jobs`);
    return Response.json({ total_count: jobs.length, jobs });
  };
  return { fetchImpl, queries };
}
