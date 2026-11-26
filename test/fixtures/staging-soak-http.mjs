import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { STAGING_ORIGIN } from "../../ci/operator-constants.mjs";
import fixture from "./staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion, deployedAt } = fixture.receipt;
const repo = "fixture/web";
export const first = {
  id: "33333333-3333-3333-3333-333333333333",
  created_on: "2026-01-01T10:01:00.123456Z",
  versions: [{ version_id: workerVersion, percentage: 100 }],
};
export const rollback = {
  id: "44444444-4444-4444-4444-444444444444",
  created_on: "2026-01-01T10:41:00.123456Z",
  versions: [{ version_id: "22222222-2222-2222-2222-222222222222", percentage: 100 }],
};
export const restored = {
  ...first,
  id: "55555555-5555-5555-5555-555555555555",
  created_on: "2026-01-01T10:43:00.123456Z",
};
export const preRollback = {
  id: 101,
  display_title: `e2e-staging deploy ${sha}`,
  event: "workflow_run",
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  head_repository: { full_name: repo },
  head_branch: "main",
  head_sha: sha,
  path: ".github/workflows/e2e-staging.yml",
  run_started_at: "2026-01-01T10:02:00Z",
  updated_at: "2026-01-01T10:09:00Z",
};
export const fresh = {
  ...preRollback,
  id: 102,
  event: "workflow_dispatch",
  display_title: `e2e-staging ${sha}`,
  run_started_at: "2026-01-01T10:45:00Z",
  updated_at: "2026-01-01T10:50:00Z",
};
export const failedManual = { ...fresh, conclusion: "failure" };

export function soakEnv({ accountId, token }) {
  return {
    DEPLOY_SHA: sha,
    GITHUB_REPOSITORY: repo,
    GITHUB_TOKEN: "synthetic-github-token",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
  };
}

export function trustedReads({ fetchImpl }, { deployments, run, skipped = false }) {
  return async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "api.github.com") {
      assert.equal(init.headers.Authorization, "Bearer synthetic-github-token");
      if (url.pathname.endsWith(`/commits/${sha}`)) {
        return Response.json({ commit: { committer: { date: deployedAt } } });
      }
      if (url.pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
        return Response.json({
          workflow_runs: run.event === "workflow_dispatch" ? [run, preRollback] : [run],
        });
      }
      const jobRun = url.pathname.includes(`/runs/${preRollback.id}/`) ? preRollback : run;
      assert.equal(url.pathname, `/repos/${repo}/actions/runs/${jobRun.id}/attempts/1/jobs`);
      const jobs = [
        ["staging-journeys", "Staging critical journeys"],
        ["staging-passive", "Passive set against staging (ledgers only)"],
        [
          "staging-quality / quality",
          "Web standards (security headers, HTML basics, internal links)",
        ],
      ].map(([name, step], index) => ({
        name,
        status: "completed",
        run_id: jobRun.id,
        run_attempt: 1,
        head_sha: jobRun.head_sha,
        conclusion: "success",
        started_at: jobRun.run_started_at,
        completed_at: jobRun.updated_at,
        steps: [
          {
            name: step,
            status: "completed",
            conclusion: skipped && index === 0 ? "skipped" : "success",
          },
        ],
      }));
      return Response.json({ total_count: jobs.length, jobs });
    }
    const versionPath = `/workers/scripts/two-web-next/versions/${workerVersion}`;
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/deployments")) {
      return Response.json({ success: true, result: { deployments: deployments() } });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith(versionPath)) {
      return Response.json({
        success: true,
        result: {
          id: workerVersion,
          annotations: { "workers/tag": sha },
          metadata: { created_on: deployedAt },
        },
      });
    }
    const response = await fetchImpl(input, init);
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname.endsWith("/graphql") &&
      run === preRollback
    ) {
      const e2eTraffic = Date.parse("2026-01-01T10:05:00Z");
      const { since, until } = JSON.parse(init.body).variables;
      if (e2eTraffic < Date.parse(since) || e2eTraffic > Date.parse(until)) {
        return Response.json({
          data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
        });
      }
    }
    return response;
  };
}

export function installSoakCliReads({ finalReadUnavailable }) {
  Date.now = () => Date.parse(fixture.receipt.floorAt);
  const reads = [];
  let allocationReads = 0;
  globalThis.fetch = trustedReads(
    {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === `${STAGING_ORIGIN}/version`) {
          const body = new ReadableStream(
            {
              async pull(controller) {
                await setImmediate();
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ sha, deployedAt })));
                reads.push(url);
                controller.close();
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, { headers: { "content-type": "application/json" } });
        }
        const trackedResponse = (body, init) => {
          const response = Response.json(body, init);
          const readBody = response.json.bind(response);
          response.json = async () => {
            await setImmediate();
            const payload = await readBody();
            reads.push(url);
            return payload;
          };
          return response;
        };
        if (url === `${STAGING_ORIGIN}/up`) {
          return trackedResponse(
            { revision: { commit: sha, version_id: workerVersion } },
            {
              headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" },
            },
          );
        }
        assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
        return trackedResponse({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      dimensions: { scriptVersion: workerVersion },
                      sum: { requests: 250, errors: 2 },
                    },
                  ],
                },
              ],
            },
          },
        });
      },
    },
    {
      deployments: () => {
        reads.push("deployments");
        allocationReads += 1;
        if (finalReadUnavailable && allocationReads === 2) {
          throw new Error("synthetic private provider transport detail");
        }
        return [first];
      },
      run: preRollback,
    },
  );
  // Check outside the transport so the provider error handler cannot hide a fixture failure.
  process.once("exit", () => {
    const serving = [`${STAGING_ORIGIN}/version`, `${STAGING_ORIGIN}/up`];
    assert.deepEqual(reads, [
      "deployments",
      ...serving,
      "https://api.cloudflare.com/client/v4/graphql",
      ...serving,
      "deployments",
    ]);
  });
}

export function assertSoakCli({ finalReadUnavailable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "staging-soak-cli-"));
  const output = join(dir, "outputs");
  const preload = `import { installSoakCliReads } from ${JSON.stringify(import.meta.url)}; installSoakCliReads({ finalReadUnavailable: ${finalReadUnavailable} });`;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "ci/production-deploy-gate.mjs",
        "--staging-soak",
      ],
      {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...soakEnv({ accountId: "c".repeat(32), token: "synthetic-analytics-token" }),
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
    );
    if (finalReadUnavailable) {
      assert.equal(result.status, 1, result.error?.message ?? result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "::error::Cannot read staging provider evidence\n");
      assert.deepEqual(readdirSync(dir), []);
      return;
    }
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, "staging-soak.json"), "utf8"));
    assert.equal(receipt.schema, "staging-soak/2");
    assert.equal(receipt.allocationId, first.id);
    assert.deepEqual(receipt.sample, fixture.receipt.sample);
    assert.equal(
      readFileSync(output, "utf8"),
      "requests=250\nerrors=2\ne2e_run_id=101\nsoak_attempt=1\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
