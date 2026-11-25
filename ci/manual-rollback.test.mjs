import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  expected,
  githubResponses,
  green,
  other,
  previous,
  red,
  repository,
  stubWrangler,
} from "./fixtures/manual-rollback.mjs";

test("protected manual rollback proves admission and live-version refusals before mutation", async (t) => {
  const { jobs, env } = parse(readFileSync(".github/workflows/rollback-production.yml", "utf8"));
  const rollback = jobs["rollback-production"];
  const [dispatchGuard, checkout, , resolve] = jobs.preflight.steps;
  const [dispatcherCheckout, , recheck, scriptsCheckout, checkoutGuard] = rollback.steps;
  const guard = rollback.steps.find((step) => step.id === "guard");
  const mutation = rollback.steps.find((step) => step.id === "rollback");
  const approvedSha = "${{ needs.preflight.outputs.sha }}";
  assert.match(
    env.MANUAL_PRODUCTION_ROLLBACK,
    /github\.event_name == 'workflow_dispatch' && github\.workflow_ref == format\(/,
  );
  assert.equal(checkout.with.ref, "${{ env.LEGACY_SCRIPTS_REF }}");
  assert.equal(dispatcherCheckout.with.ref, "${{ github.sha }}");
  assert.equal(resolve.env.DEPLOY_SHA, "${{ inputs.ref }}");
  assert.equal(jobs.preflight.outputs.sha, "${{ steps.manual-scripts.outputs.sha }}");
  assert.equal(rollback.needs, "preflight");
  assert.equal(recheck.env.DEPLOY_SHA, approvedSha);
  assert.equal(scriptsCheckout.with.ref, approvedSha);
  assert.equal(checkoutGuard.env.DEPLOY_SHA, approvedSha);
  assert.equal(mutation.if, "steps.guard.outputs.action == 'rollback'");
  assert.ok(rollback.steps.indexOf(guard) < rollback.steps.indexOf(mutation));

  const dispatcher = execFileSync(
    "git",
    ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.notEqual(dispatcher, green);
  const cases = [
    ["green ancestor while dispatch-tip CI is pending", {}],
    ["already restored", { LIVE: previous }],
    ["wrong currently serving UUID", { LIVE: other }, /is neither the expected/],
    ["off-main dispatch", { GITHUB_REF: "refs/heads/topic" }, /protected main/],
    ["unprotected main", { GITHUB_REF_PROTECTED: "false" }, /protected main/],
    ["missing scripts SHA", { DEPLOY_SHA: "" }, /full lowercase 40-hex SHA/],
    ["malformed scripts SHA", { DEPLOY_SHA: `${green}\n` }, /full lowercase 40-hex SHA/],
    ["nonancestor scripts SHA", { DEPLOY_SHA: "d".repeat(40) }, /not an ancestor/],
    ["red scripts CI", { DEPLOY_SHA: red }, /Full CI has not completed successfully/],
    ["CI turned red after preflight", { RERUN: "true" }, /Full CI has not completed successfully/],
    ["missing current UUID", { EXPECTED_CURRENT_VERSION_ID: "" }, /lowercase UUID/],
    ["same current and prior UUID", { EXPECTED_CURRENT_VERSION_ID: previous }, /must differ/],
  ];
  const dir = mkdtempSync(join(tmpdir(), "manual-rollback-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "npx"), stubWrangler, { mode: 0o700 });

  for (const [name, overrides, error] of cases) {
    await t.test(name, () => {
      const sha = overrides.DEPLOY_SHA ?? green;
      const fixture = githubResponses(sha, dispatcher, overrides.RERUN);
      const output = join(dir, "output");
      const requests = join(dir, "requests");
      const wrangler = join(dir, "wrangler");
      for (const path of [output, requests, wrangler]) writeFileSync(path, "");
      // Run the real steps through Bash with the workflow's success and action
      // conditions. Every network request and Wrangler command is intercepted.
      const result = spawnSync(
        "bash",
        [
          "-euo",
          "pipefail",
          "-c",
          `
        ${dispatchGuard.run}
        ${resolve.run}
        read -r pinned < "$GITHUB_OUTPUT"
        test "$pinned" = "sha=$DEPLOY_SHA"
        FETCH_STUB_JSON="$RECHECK_JSON" DEPLOY_SHA="\${pinned#sha=}" ${recheck.run}
        : > "$GITHUB_OUTPUT"
        ${guard.run}
        if [ "$(cat "$GITHUB_OUTPUT")" = "action=rollback" ]; then
          ${mutation.run}
        fi
      `,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            NODE_OPTIONS: `--import=${new URL("./test-fetch-stub.mjs", import.meta.url).href}`,
            RUNNER_TEMP: dir,
            GITHUB_OUTPUT: output,
            FETCH_STUB_LOG: requests,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REF: "refs/heads/main",
            GITHUB_REF_PROTECTED: "true",
            GITHUB_REPOSITORY: repository,
            GITHUB_SHA: dispatcher,
            GITHUB_TOKEN: "fixture",
            PRODUCTION_DEPLOY_ENABLED: "true",
            DEPLOY_SHA: sha,
            ROLLBACK_VERSION_ID: previous,
            EXPECTED_CURRENT_VERSION_ID: expected,
            ROLLBACK_WORKER_NAME: "stub-worker",
            LIVE: expected,
            FETCH_STUB_JSON: JSON.stringify(fixture.preflight),
            RECHECK_JSON: JSON.stringify(fixture.recheck),
            ...overrides,
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, error ? 1 : 0, result.stdout + result.stderr);
      if (error) assert.match(result.stderr + result.stdout, error);
      const calls = readFileSync(requests, "utf8");
      assert.ok(!calls.includes(`head_sha=${dispatcher}`));
      if (!error) assert.equal(calls.split(`head_sha=${green}`).length - 1, 2);
      const commands = readFileSync(wrangler, "utf8");
      assert.equal(
        commands.includes("wrangler deployments list"),
        !error || overrides.LIVE === other,
      );
      assert.equal(commands.includes("wrangler rollback"), !error && !overrides.LIVE);
    });
  }
});
