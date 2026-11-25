export const repository = "TogetherWeOwn/two-web-next";
// Protected main push CI runs 45628441721 (green) and 45613104834 (red).
export const green = "4afdce3da8ed9b5c5df1647f1d055eb700a7b5db";
export const red = "b7e08dad6cc34864709f9d76a01ef80a062d13a1";
export const previous = "77777777-7777-4777-8777-777777777777";
export const expected = "88888888-8888-4888-8888-888888888888";
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
  const jobs = ["check", "a11y"].map((name) => ({ name, head_sha: sha, status, conclusion }));
  return [
    {
      match: `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
      body: { total_count: 1, workflow_runs: [run] },
    },
    { match: `/actions/runs/${id}/jobs?`, body: { total_count: jobs.length, jobs } },
    { match: `/actions/runs/${id}`, body: run },
  ];
}

export function githubResponses(sha, dispatcher, rerun) {
  const ancestor = [red, green].includes(sha);
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
    ...ciResponses(green, 45628441721, "completed", "success"),
    ...ciResponses(red, 45613104834, "completed", "failure"),
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
    printf '[{"versions":[{"version_id":"%s","percentage":100}]}]\\n' "$LIVE" ;;
  'wrangler rollback ${previous} --name stub-worker') exit 0 ;;
  *) exit 2 ;;
esac
`;
