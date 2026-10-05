import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TOG-13034 (port of two-bot-next #365): a push to main must publish a merged
// release PR but never regenerate it or dispatch checks on it. Regenerating on
// every merge rewrote the release PR head ~10x an hour, so it could never hold
// one head long enough to get exact-head green and be merged.
const text = readFileSync(".github/workflows/release.yml", "utf8");
const header = text.slice(0, text.search(/^permissions:/m));
const body = text.slice(text.search(/^jobs:\n/m));

function job(id: string) {
  const match = body.match(
    new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  expect(match, `job ${id}`).not.toBeNull();
  return match?.[1] ?? "";
}

// Evaluates the `a == 'x' && b != 'y'` conditions this workflow uses. Fail-closed:
// any other syntax throws instead of guessing.
function evaluate(expression: string, context: Record<string, string>) {
  const atom = (source: string) => {
    const parsed = source.match(/^\s*([\w.-]+)\s*(==|!=)\s*'([^']*)'\s*$/);
    if (!parsed) throw new Error(`Unsupported expression: ${source}`);
    const [, name, operator, literal] = parsed;
    const equal = context[name as string] === literal;
    return operator === "==" ? equal : !equal;
  };
  return expression.split("||").some((clause) => clause.split("&&").every(atom));
}

const context = (event: string, prsCreated = "true") => ({
  "github.event_name": event,
  "needs.release-please.outputs.prs_created": prsCreated,
});

const skipExpression = () => {
  const match = job("release-please").match(/^ {10}skip-github-pull-request: \$\{\{ (.+) \}\}$/m);
  expect(match, "skip-github-pull-request input").not.toBeNull();
  return match?.[1] ?? "";
};

const dispatchCondition = () => {
  const match = job("dispatch-checks").match(/^ {4}if: (.+)$/m);
  expect(match, "dispatch-checks if").not.toBeNull();
  return match?.[1] ?? "";
};

describe("release workflow triggers", () => {
  it("runs on push to main, a weekly schedule and manual dispatch only", () => {
    expect(header).toContain("\n  push:\n    branches: [main]\n");
    expect(header).toMatch(/^ {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: '\d+ \d+ \* \* [\d*]'$/m);
    expect(header.match(/- cron:/g)).toHaveLength(1);
    expect(header).toContain("\n  workflow_dispatch:\n");
    expect(header).not.toContain("pull_request");
  });

  it("skips PR generation on push and nowhere else", () => {
    const skip = skipExpression();
    expect(evaluate(skip, context("push"))).toBe(true);
    expect(evaluate(skip, context("schedule"))).toBe(false);
    expect(evaluate(skip, context("workflow_dispatch"))).toBe(false);
  });

  it("never dispatches checks on push, even when a PR was reported", () => {
    const condition = dispatchCondition();
    for (const prsCreated of ["true", "false"]) {
      expect(evaluate(condition, context("push", prsCreated)), `prs_created=${prsCreated}`).toBe(
        false,
      );
    }
  });

  it("dispatches checks after a regeneration on schedule and dispatch", () => {
    const condition = dispatchCondition();
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(evaluate(condition, context(event, "true")), event).toBe(true);
      expect(evaluate(condition, context(event, "false")), event).toBe(false);
    }
  });

  it("keeps publication enabled and scopes the write token to each job", () => {
    expect(text).not.toMatch(/skip-github-release\s*:/);
    // No workflow-wide token: release-please publishes and reconciles the PR,
    // dispatch-checks only starts the required workflows.
    expect(text).toMatch(/^permissions: \{\}\n/m);
    expect(job("release-please")).toMatch(
      /^ {4}permissions:\n {6}contents: write[^\n]*\n {6}pull-requests: write[^\n]*\n(?! {6})/m,
    );
    expect(job("dispatch-checks")).toMatch(
      /^ {4}permissions:\n {6}actions: write[^\n]*\n(?! {6})/m,
    );
    expect(job("dispatch-checks")).toContain('gh workflow run ci.yml --ref "$HEAD_BRANCH"');
    expect(job("dispatch-checks")).toContain(
      'gh workflow run pr-gates.yml --ref "$HEAD_BRANCH" -f pr_number="$PR_NUMBER"',
    );
  });
});
