import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const steps = check.split(/\n      - /);

test("policy is a hard check on PRs AND the configured merge queue", () => {
  assert.match(workflow, /merge_group:\s*\n\s+types: \[checks_requested\]/);
  const step = steps.find((part) => part.startsWith("name: Budget admission policy"));
  assert.ok(step, "policy step must exist inside required check job");
  assert.match(step, /github\.event_name == 'pull_request'/);
  assert.match(step, /github\.event_name == 'merge_group'/);
  assert.match(step, /run: node ci\/check-budget-admissions\.mjs/);
  assert.doesNotMatch(step, /continue-on-error|\|\| true/);
  assert.match(workflow, /ci-ok:[\s\S]*?needs: \[[^\]]*\bcheck\b/);
  assert.match(check, /fetch-depth: 0/);
});

test("both final deploy artifacts are cleaned, built and checked in the same hard step", () => {
  for (const [config, dir] of [
    ["wrangler.jsonc", "kit-worker-dry-run"],
    ["wrangler.staging.jsonc", "kit-staging-worker-dry-run"],
  ]) {
    const step = steps.find((part) => part.includes(`--config web/${config} --dry-run`));
    assert.ok(step, `missing ${config} dry run`);
    assert.match(step, new RegExp(`rm -rf "\\$RUNNER_TEMP/${dir}"`));
    assert.ok(step.indexOf("rm -rf") < step.indexOf("npx wrangler deploy"));
    assert.ok(
      step.indexOf("npx wrangler deploy") < step.indexOf("node ci/check-kit-deploy-budget.mjs"),
    );
    assert.ok(step.includes(`node ci/check-kit-deploy-budget.mjs "$RUNNER_TEMP/${dir}"`));
    assert.doesNotMatch(step, /continue-on-error|\|\| true/);
  }
});

test("Kit proxies and user-facing gates stay required during the conservative transition", () => {
  assert.match(check, /run: node ci\/check-kit-perf\.mjs/);
  assert.match(workflow, /run: npm run lighthouse\n/);
  assert.match(workflow, /run: npm run lighthouse:quality/);
  assert.match(check, /Authenticated perf/);
  assert.doesNotMatch(check, /continue-on-error: true/);
});

test("every new invariant suite is reachable from the existing Kit gate suite", () => {
  for (const file of [
    "budget-ledger.test.mjs",
    "check-budget-admissions.test.mjs",
    "check-kit-deploy-budget.test.mjs",
    "budget-policy-wiring.test.mjs",
  ]) {
    assert.match(check, new RegExp(`node --test [^\n]*ci/${file.replaceAll(".", "\\.")}`));
  }
});
