import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  green,
  other,
  previous,
  red,
  rollbackRouting,
  runFixture,
  stubWrangler,
  tooOld,
} from "./fixtures/manual-rollback.mjs";

test("protected manual rollback proves admission and live-version refusals before mutation", async (t) => {
  const workflow = parse(readFileSync(".github/workflows/rollback-production.yml", "utf8"));
  const { jobs } = workflow;
  const rollback = jobs["rollback-production"];
  const [dispatchGuard, checkout, preflightNode, resolve] = jobs.preflight.steps;
  const [dispatcherCheckout, setupNode, recheck, scriptsCheckout] = rollback.steps;
  const guard = rollback.steps.find((step) => step.id === "guard");
  const mutation = rollback.steps.find((step) => step.id === "rollback");
  const approvedSha = "${{ needs.preflight.outputs.sha }}";
  assert.equal(checkout.with.ref, "${{ env.LEGACY_SCRIPTS_REF }}");
  assert.equal(dispatcherCheckout.with.ref, "${{ github.sha }}");
  assert.equal(dispatcherCheckout.with["fetch-depth"], 0);
  assert.equal(preflightNode.with["package-manager-cache"], false);
  assert.equal(setupNode.with["package-manager-cache"], false);
  assert.equal(setupNode.if, undefined);
  assert.equal(resolve.env.DEPLOY_SHA, "${{ inputs.ref }}");
  assert.equal(jobs.preflight.outputs.sha, "${{ steps.manual-scripts.outputs.sha }}");
  assert.equal(rollback.needs, "preflight");
  assert.equal(recheck.env.DEPLOY_SHA, approvedSha);
  assert.equal(scriptsCheckout.env.DEPLOY_SHA, approvedSha);
  for (const step of [resolve, dispatcherCheckout, recheck, scriptsCheckout]) {
    assert.equal(step.if, "env.MANUAL_PRODUCTION_ROLLBACK == 'true'");
  }
  assert.equal(guard.env.MANUAL_GUARD_DIR, "${{ steps.manual-recheck.outputs.guard_dir }}");
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
  assert.deepEqual(rollbackRouting(workflow, dispatcher), {
    manual: true,
    trusted: true,
    legacyRef: dispatcher,
  });
  assert.deepEqual(rollbackRouting(workflow, dispatcher, { ENVIRONMENT: "staging" }), {
    manual: false,
    trusted: true,
    legacyRef: dispatcher,
  });
  for (const WORKFLOW of ["deploy-production", "staging-rollback-drill"]) {
    assert.deepEqual(rollbackRouting(workflow, dispatcher, { WORKFLOW }), {
      manual: false,
      trusted: true,
      legacyRef: green,
    });
  }
  const cases = [
    ["green ancestor while dispatch-tip CI is pending", {}],
    ["already restored", { LIVE: previous }],
    ["recover a known partial promotion", { SPLIT: previous }],
    [
      "failed provider deployment query with valid JSON on stdout",
      { DEPLOYMENT_QUERY_FAILS: "true" },
      /Stub provider deployment query failed/,
    ],
    ["refuse an unknown split", { SPLIT: other }, /split traffic must serve only/],
    ["wrong currently serving UUID", { LIVE: other }, /is neither the expected/],
    ["unknown dispatch workflow", { WORKFLOW: "unknown" }, /Unknown rollback dispatch/],
    ["off-main dispatch", { GITHUB_REF: "refs/heads/topic" }, /protected main/],
    ["unprotected main", { GITHUB_REF_PROTECTED: "false" }, /protected main/],
    ["missing scripts SHA", { DEPLOY_SHA: "" }, /full lowercase 40-hex SHA/],
    ["malformed scripts SHA", { DEPLOY_SHA: `${green}\n` }, /full lowercase 40-hex SHA/],
    ["nonancestor scripts SHA", { DEPLOY_SHA: "d".repeat(40) }, /not an ancestor/],
    ["red scripts CI", { DEPLOY_SHA: red }, /Full CI has not completed successfully/],
    [
      "green SHA predates rollback tooling",
      { DEPLOY_SHA: tooOld },
      /predates the supported rollback tooling/,
    ],
    ["CI turned red after preflight", { RERUN: "true" }, /Full CI has not completed successfully/],
    ["missing current UUID", { EXPECTED_CURRENT_VERSION_ID: "" }, /lowercase UUID/],
    ["same current and prior UUID", { EXPECTED_CURRENT_VERSION_ID: previous }, /must differ/],
  ];
  const dir = mkdtempSync(join(tmpdir(), "manual-rollback-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "npx"), stubWrangler, { mode: 0o700 });

  const steps = { dispatchGuard, resolve, recheck, scriptsCheckout, guard, mutation };
  for (const [name, overrides, error] of cases) {
    await t.test(name, () => {
      const { result, calls, commands, guardOutput } = runFixture(
        dir,
        workflow,
        steps,
        dispatcher,
        overrides,
      );
      assert.ifError(result.error);
      assert.equal(result.status, error ? 1 : 0, result.stdout + result.stderr);
      if (error) assert.match(result.stderr + result.stdout, error);
      assert.ok(!calls.includes(`head_sha=${dispatcher}`));
      if (!error) assert.equal(calls.split(`head_sha=${green}`).length - 1, 2);
      const queriedDeployments = commands.includes("wrangler deployments list");
      assert.equal(
        queriedDeployments,
        !error ||
          overrides.LIVE === other ||
          overrides.SPLIT === other ||
          overrides.DEPLOYMENT_QUERY_FAILS === "true",
      );
      if (error && queriedDeployments) assert.equal(guardOutput, "");
      assert.equal(commands.includes("wrangler rollback"), !error && !overrides.LIVE);
    });
  }
});
