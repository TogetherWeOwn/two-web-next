import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repository = "TogetherWeOwn/two-web-next";
// Protected main push CI runs 45628441721 (green) and 45613104834 (red).
export const green = "4afdce3da8ed9b5c5df1647f1d055eb700a7b5db";
export const red = "b7e08dad6cc34864709f9d76a01ef80a062d13a1";
export const tooOld = "62abf8c28d216771950490b406560f2a154d51b2";
const scriptsFloor = "77de045d40bcf597dce813ce62b8de69029b2412";
export const previous = "77777777-7777-4777-8777-777777777777";
const expected = "88888888-8888-4888-8888-888888888888";
export const other = "99999999-9999-4999-8999-999999999999";

function ciResponses(sha, id, status, conclusion) {
  const run = {
    id,
    run_attempt: 1,
    status,
    conclusion,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yml",
    head_repository: { full_name: repository },
  };
  const jobs = ["check", "a11y"].map((name) => ({
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: sha,
    status,
    conclusion,
  }));
  return [
    {
      match: `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
      body: { total_count: 1, workflow_runs: [run] },
    },
    { match: `/actions/runs/${id}/jobs?`, body: { total_count: jobs.length, jobs } },
    { match: `/actions/runs/${id}`, body: run },
  ];
}

function githubResponses(sha, dispatcher, rerun) {
  const ancestor = [red, green, tooOld].includes(sha);
  const preflight = [
    {
      match: "/environments/production",
      body: {
        name: "production",
        protection_rules: [
          { type: "required_reviewers", reviewers: [{}], prevent_self_review: true },
        ],
      },
    },
    {
      match: `/compare/${sha}...${dispatcher}`,
      body: {
        status: ancestor ? "ahead" : "diverged",
        behind_by: ancestor ? 0 : 1,
        ahead_by: 2,
        total_commits: 2,
        base_commit: { sha },
        merge_base_commit: { sha: ancestor ? sha : red },
      },
    },
    {
      match: `/compare/${scriptsFloor}...${sha}`,
      body: {
        status: sha === tooOld ? "behind" : "ahead",
        behind_by: sha === tooOld ? 1 : 0,
        ahead_by: 2,
        total_commits: 2,
        base_commit: { sha: scriptsFloor },
        merge_base_commit: { sha: scriptsFloor },
      },
    },
    ...ciResponses(green, 45628441721, "completed", "success"),
    ...ciResponses(red, 45613104834, "completed", "failure"),
    ...ciResponses(tooOld, 2, "completed", "success"),
    ...ciResponses(dispatcher, 1, "in_progress", null),
  ];
  const recheck = rerun
    ? [...ciResponses(green, 45628441721, "completed", "failure"), ...preflight]
    : preflight;
  return { preflight, recheck };
}

export const stubWrangler = `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$RUNNER_TEMP/wrangler"
case "$*" in
  'wrangler deployments list --name stub-worker --json')
    if [ -n "$SPLIT" ]; then
      printf '[{"versions":[{"version_id":"%s","percentage":5},{"version_id":"%s","percentage":95}]}]\\n' "$LIVE" "$SPLIT"
    else
      printf '[{"versions":[{"version_id":"%s","percentage":100}]}]\\n' "$LIVE"
    fi
    if [ "$DEPLOYMENT_QUERY_FAILS" = true ]; then
      printf '%s\\n' 'Stub provider deployment query failed' >&2
      exit 1
    fi ;;
  'wrangler rollback ${previous} --name stub-worker') exit 0 ;;
  *) exit 2 ;;
esac
`;

// The selectors here use only boolean operators, equality, and format().
// Exercise their YAML expressions against representative Actions contexts.
export function rollbackRouting(workflow, dispatcher, overrides = {}) {
  const { env, jobs } = workflow;
  const ref = overrides.GITHUB_REF ?? "refs/heads/main";
  const entry = overrides.WORKFLOW ?? "rollback-production";
  const inputs = { environment: overrides.ENVIRONMENT ?? "production", ref: green };
  const github = {
    repository,
    ref,
    sha: dispatcher,
    event_name: "workflow_dispatch",
    workflow_ref: `${repository}/.github/workflows/${entry}.yml@${ref}`,
  };
  const format = (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => args[index]);
  const select = (expression) =>
    new Function("inputs", "github", "format", `return (${expression.slice(3, -2)})`)(
      inputs,
      github,
      format,
    );
  return {
    manual: select(env.MANUAL_PRODUCTION_ROLLBACK),
    trusted: select(jobs.preflight.steps[0].env.TRUSTED_WORKFLOW),
    legacyRef: select(env.LEGACY_SCRIPTS_REF),
  };
}

// Provide a fresh set of canned responses and command logs to each case.
export function runFixture(dir, workflow, steps, dispatcher, overrides) {
  const { dispatchGuard, resolve, recheck, scriptsCheckout, guard, mutation } = steps;
  const routing = rollbackRouting(workflow, dispatcher, overrides);
  const script = `
        ${dispatchGuard.run}
        test "$MANUAL_PRODUCTION_ROLLBACK" = true
        ${resolve.run}
        read -r pinned < "$GITHUB_OUTPUT"
        test "$pinned" = "sha=$DEPLOY_SHA"
        : > "$GITHUB_OUTPUT"
        FETCH_STUB_JSON="$RECHECK_JSON" DEPLOY_SHA="\${pinned#sha=}" ${recheck.run}
        export MANUAL_GUARD_DIR="$(sed -n 's/^guard_dir=//p' "$GITHUB_OUTPUT")"
        export DEPLOY_SHA="\${pinned#sha=}"
        ${scriptsCheckout.run}
        if [ "$(git rev-parse HEAD)" != "$DEPLOY_SHA" ]; then
          echo "Fixture never reached the selected rollback scripts" >&2
          exit 1
        fi
        : > "$GITHUB_OUTPUT"
        ${guard.run}
        if [ "$(cat "$GITHUB_OUTPUT")" = "action=rollback" ]; then
          ${mutation.run}
        fi
      `;

  const sha = overrides.DEPLOY_SHA ?? green;
  const responses = githubResponses(sha, dispatcher, overrides.RERUN);
  const output = join(dir, "output");
  const requests = join(dir, "requests");
  const wrangler = join(dir, "wrangler");
  for (const path of [output, requests, wrangler]) writeFileSync(path, "");

  const checkout = join(dir, "checkout");
  const git = (...args) =>
    execFileSync("git", ["-c", `safe.directory=${process.cwd()}`, ...args], { stdio: "pipe" });
  git("worktree", "add", "--detach", checkout, dispatcher);
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        NODE_OPTIONS: `--import=${new URL("../test-fetch-stub.mjs", import.meta.url).href}`,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        FETCH_STUB_LOG: requests,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true",
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: dispatcher,
        GITHUB_TOKEN: "fixture",
        TRUSTED_WORKFLOW: String(routing.trusted),
        MANUAL_PRODUCTION_ROLLBACK: String(routing.manual),
        PRODUCTION_DEPLOY_ENABLED: "true",
        DEPLOY_SHA: sha,
        ROLLBACK_VERSION_ID: previous,
        EXPECTED_CURRENT_VERSION_ID: expected,
        ROLLBACK_WORKER_NAME: "stub-worker",
        LIVE: expected,
        SPLIT: "",
        DEPLOYMENT_QUERY_FAILS: "false",
        FETCH_STUB_JSON: JSON.stringify(responses.preflight),
        RECHECK_JSON: JSON.stringify(responses.recheck),
        ...overrides,
      },
    });
    return {
      result,
      calls: readFileSync(requests, "utf8"),
      commands: readFileSync(wrangler, "utf8"),
      guardOutput: readFileSync(output, "utf8"),
    };
  } finally {
    git("worktree", "remove", "--force", checkout);
  }
}
