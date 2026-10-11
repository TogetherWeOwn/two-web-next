import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSupersedingRun, isSupersededRun } from "../ci/find-superseding-run.mjs";
import type { WorkflowRun } from "../ci/find-superseding-run.mjs";

// TOG-11811: runners are the throughput ceiling, so a superseded PR push must
// cancel its own runs. Deploy, rollback and release runs must never be cancelled midway.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const triggers = (text: string) => text.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
// ci.yml alone exempts main from cancellation (a cancelled main run cannot
// trigger the staging deploy); its concurrency group stays per ref so main runs
// finish in push order and an older SHA never deploys over a newer one.
const cancels = (text: string) =>
  /\nconcurrency:\n  group: [^\n]+\n  cancel-in-progress: (true|\$\{\{ github\.ref != 'refs\/heads\/main' \}\}|\$\{\{ github\.event_name == 'pull_request' \}\})\n/.test(
    text,
  );
// A bare `cancel-in-progress: true` on a workflow that also runs on push to main
// is only safe when its group is per SHA (main pushes then never share a group).
const pushesMain = (text: string) => /(^|\n)  push:\n    branches: \[main\]/.test(triggers(text));
const bareCancel = (text: string) => /\n  cancel-in-progress: true\n/.test(text);
const groupPerSha = (text: string) =>
  /\nconcurrency:\n  group: [^\n]*github\.sha[^\n]*\n/.test(text);

// No workflow currently needs a schedule that shares main's push group.
const SCHEDULE_SHARES_MAIN_GROUP = new Set<string>();

const ci = workflows.find(({ name }) => name === "ci.yml")?.text ?? "";
const workflowJob = (job: string) =>
  ci.match(new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|\\n$)`))?.[1] ?? "";
const aggregateJob = (job: "check" | "ci-ok") => workflowJob(job);
const cancellationGuardJob = workflowJob("ci-supersession");
const ciOkCancellationGuardJob = workflowJob("ci-ok-supersession");

const headSha = "a".repeat(40);
const currentRun = { hasCancelledDependency: true, runId: 100, pullNumber: 17, headSha };
const queryContext = {
  ...currentRun,
  runId: "100",
  pullNumber: "17",
  repository: "TogetherWeOwn/two-web-next",
  token: "fixture",
};
const matchingNewerRun = {
  id: 101,
  event: "pull_request",
  pull_requests: [{ number: 17, head: { sha: headSha } }],
};

const queryRuns = (runs: WorkflowRun[], hasCancelledDependency = true) =>
  findSupersedingRun({ ...queryContext, hasCancelledDependency }, async (url, options) => {
    expect(new URL(url).pathname).toBe(
      "/repos/TogetherWeOwn/two-web-next/actions/workflows/ci.yml/runs",
    );
    expect(new URL(url).searchParams.get("event")).toBe("pull_request");
    expect(new URL(url).searchParams.get("head_sha")).toBe(headSha);
    expect(options.headers.Authorization).toBe("Bearer fixture");
    return { ok: true, json: async () => ({ workflow_runs: runs }) };
  });

describe("superseded workflow runs", () => {
  it("skips cancelled aggregates only when a newer run matches the same PR and head", () => {
    expect(isSupersededRun(currentRun, [matchingNewerRun])).toBe(true);
    expect(cancellationGuardJob).toContain("needs.scope.result == 'cancelled'");
    expect(cancellationGuardJob).toContain("needs.a11y.result == 'cancelled'");
    expect(cancellationGuardJob).toContain("needs.lighthouse.result == 'cancelled'");
    expect(cancellationGuardJob).toContain("needs.bundle-budget.result == 'cancelled'");
    expect(cancellationGuardJob).toContain("needs.docs-links.result == 'cancelled'");
  });

  it.each(["check", "ci-ok"] as const)(
    "uses the supersession result before skipping the required %s aggregate",
    (job) => {
      expect(aggregateJob(job)).toContain("needs.ci-supersession.outputs.superseded != 'true'");
      expect(aggregateJob(job)).toContain("ci-supersession");
    },
  );

  it("checks for supersession when check itself is cancelled", () => {
    expect(ciOkCancellationGuardJob).toContain("needs.check.result == 'cancelled'");
    expect(aggregateJob("ci-ok")).toContain(
      "needs.ci-ok-supersession.outputs.superseded != 'true'",
    );
  });

  it.each(["ci-supersession", "ci-ok-supersession"])("pins Node and a timeout for %s", (job) => {
    const block = workflowJob(job);
    expect(block).toMatch(/\n    timeout-minutes: 5\n/);
    expect(block).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(block).toMatch(/\n          node-version: 22\n/);
  });

  it("confirms a matching newer run through the workflow-runs API", async () => {
    expect(await queryRuns([matchingNewerRun])).toBe(true);
  });

  it("continues through a full first page to find the matching newer run", async () => {
    const pages: string[] = [];
    const result = await findSupersedingRun(queryContext, async (url) => {
      const page = new URL(url).searchParams.get("page") ?? "";
      pages.push(page);
      const runs =
        page === "1"
          ? Array.from({ length: 100 }, (_, index) => ({
              ...matchingNewerRun,
              id: index + 1,
              pull_requests: [{ number: 18, head: { sha: headSha } }],
            }))
          : [matchingNewerRun];
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    });
    expect(result).toBe(true);
    expect(pages).toEqual(["1", "2"]);
  });

  it("fails closed when GitHub cannot confirm supersession", async () => {
    await expect(
      findSupersedingRun(queryContext, async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      })),
    ).rejects.toThrow("Workflow runs API returned 403.");
    expect(aggregateJob("check")).toContain(
      'test "$SUPERSESSION_RESULT" = success || test "$SUPERSESSION_RESULT" = skipped',
    );
  });

  it("fails closed when cancellation has no newer matching run", async () => {
    expect(isSupersededRun(currentRun, [])).toBe(false);
    expect(await queryRuns([])).toBe(false);
    expect(
      isSupersededRun({ ...currentRun, hasCancelledDependency: false }, [matchingNewerRun]),
    ).toBe(false);
  });

  it("does not query GitHub when no dependency was cancelled", async () => {
    const result = await findSupersedingRun(
      { ...queryContext, hasCancelledDependency: false },
      async () => {
        throw new Error("unexpected API request");
      },
    );
    expect(result).toBe(false);
  });

  it.each([
    { ...matchingNewerRun, event: "push" },
    { ...matchingNewerRun, pull_requests: [{ number: 18, head: { sha: "abc123" } }] },
    { ...matchingNewerRun, pull_requests: [{ number: 17, head: { sha: "different" } }] },
    { ...matchingNewerRun, id: 99 },
  ])("does not treat another event, PR, head, or older run as superseding", (run) => {
    expect(isSupersededRun(currentRun, [run])).toBe(false);
  });

  it.each(["check", "ci-ok"] as const)("fails the required %s check when scope failed", (job) => {
    if (job === "check") expect(aggregateJob(job)).toContain('run: test "$SCOPE_RESULT" = success');
    if (job === "ci-ok")
      expect(aggregateJob(job)).toContain('[ "$SCOPE_RESULT" = success ] || fail');
  });
});

describe("workflow concurrency", () => {
  it("cancels superseded runs of every pull_request workflow", () => {
    const pr = workflows.filter(({ text }) => /(^|\n)  pull_request:/.test(triggers(text)));
    expect(pr.length).toBeGreaterThan(2);
    expect(pr.filter(({ text }) => !cancels(text)).map(({ name }) => name)).toEqual([]);
  });

  it("never cancels a main push run (CI standard rule 9)", () => {
    const offenders = workflows
      .filter(({ text }) => pushesMain(text) && bareCancel(text) && !groupPerSha(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("keeps schedule runs out of main's push-run group in every workflow", () => {
    // With the default queue, a newly queued run cancels any PENDING run in its
    // group, so a nightly sharing main's group would replace a waiting push run.
    const offenders = workflows
      .filter(
        ({ name, text }) =>
          pushesMain(text) &&
          /(^|\n)  schedule:\n/.test(triggers(text)) &&
          !SCHEDULE_SHARES_MAIN_GROUP.has(name),
      )
      .filter(({ text }) => !/\n  group: [^\n]*github\.event_name == 'schedule'[^\n]*\n/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("keys e2e dispatch runs apart from main push runs", () => {
    const e2e = workflows.find(({ name }) => name === "e2e.yml")?.text ?? "";
    expect(e2e).toMatch(
      /\n  group: [^\n]*github\.event_name == 'workflow_dispatch' && github\.run_id[^\n]*\n/,
    );
  });

  it("keeps the nightly schedule run out of main's push-run group", () => {
    const ci = workflows.find(({ name }) => name === "ci.yml")?.text ?? "";
    // A pending nightly in main's group would cancel a pending push run, and
    // deploy.yml only deploys push-event runs, so staging would miss that SHA.
    expect(triggers(ci)).toMatch(/\n  schedule:\n    - cron: /);
    expect(ci).toMatch(
      /\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| \(github\.event_name == 'schedule' && 'nightly'\) \|\| github\.ref \}\}\n/,
    );
  });

  it("never cancels deploy, rollback or release runs", () => {
    const protectedRuns = workflows.filter(({ name }) => /^(deploy|rollback|release)/.test(name));
    expect(protectedRuns.length).toBeGreaterThan(1);
    expect(
      protectedRuns
        .filter(({ text }) => /cancel-in-progress: true/.test(text))
        .map(({ name }) => name),
    ).toEqual([]);
  });
});
