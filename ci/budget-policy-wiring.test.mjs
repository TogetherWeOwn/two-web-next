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

test("the policy step condition stays true for PR, merge-group and push", () => {
  // Substring assertions pass even when the boolean condition is broken: with
  // `pull_request && merge_group || push` neither PR nor merge-group runs the
  // hard policy, yet every substring is still present. Evaluate the whole
  // expression against each event instead of searching for its parts.
  const step = steps.find((part) => part.startsWith("name: Budget admission policy"));
  assert.ok(step, "policy step must exist inside required check job");
  const condition = /if:\s*(.+)/.exec(step)?.[1]?.trim();
  assert.ok(condition, "policy step needs an explicit condition");
  // Replace GitHub expressions with their observed values and evaluate exactly
  // what Actions would evaluate, per event.
  const evaluate = (expression, event, { docsOnly, draft }) => {
    const substituted = expression
      .replaceAll("needs.scope.outputs.docs_only != 'true'", String(docsOnly !== "true"))
      .replaceAll("needs.scope.outputs.draft != 'true'", String(draft !== "true"))
      .replaceAll("github.event_name == 'merge_group'", String(event === "merge_group"))
      .replaceAll("github.event_name == 'pull_request'", String(event === "pull_request"))
      .replaceAll("github.event_name == 'push'", String(event === "push"));
    if (!/^[\s()|&!tfalsrue]+$/.test(substituted)) {
      throw new Error(`unsubstituted expression: ${substituted}`);
    }
    return evaluateBoolean(substituted);
  };
  for (const event of ["pull_request", "merge_group", "push"]) {
    assert.equal(evaluate(condition, event, { docsOnly: "false", draft: "false" }), true, event);
  }
  // A docs-only or draft PR skips the step, exactly as before.
  for (const event of ["pull_request", "merge_group", "push"]) {
    assert.equal(evaluate(condition, event, { docsOnly: "true", draft: "false" }), false, event);
  }
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

// Minimal boolean evaluator for the substituted workflow expression: tokens,
// `!`, parentheses, and `&&` / `||` with `||` weakest. Only literals and
// operators reach it, so there is no eval of untrusted text.
function evaluateBoolean(expression) {
  const tokens = expression.match(/!|\(|\)|&&|\|\||[a-z]+/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const eat = () => tokens[index++];
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === "||") {
      eat();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseUnary();
    while (peek() === "&&") {
      eat();
      const right = parseUnary();
      value = value && right;
    }
    return value;
  };
  const parseUnary = () => {
    if (peek() === "!") {
      eat();
      return !parseUnary();
    }
    if (peek() === "(") {
      eat();
      const value = parseOr();
      if (eat() !== ")") throw new Error(`unbalanced expression: ${expression}`);
      return value;
    }
    const token = eat();
    if (token === "true") return true;
    if (token === "false") return false;
    throw new Error(`unexpected token ${token} in: ${expression}`);
  };
  const value = parseOr();
  if (index !== tokens.length) throw new Error(`trailing tokens in: ${expression}`);
  return value;
}
