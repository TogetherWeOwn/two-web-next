import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// TOG-11811: runners are the throughput ceiling, so a superseded PR push must
// cancel its own runs. Deploy, rollback and release runs must never be cancelled midway.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const triggers = (text: string) => text.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
const normalized = (expression: string) => expression.replace(/\s+/g, " ").trim();
const scanEvents = normalized(`github.event.action != 'edited' ||
  (startsWith(toJSON(github.event.changes.base.ref.from), '"') && github.event.changes.base.ref.from != '' &&
   startsWith(toJSON(github.event.pull_request.base.ref), '"') && github.event.pull_request.base.ref != '')`);
const prGatesAdmit = `(${scanEvents})`;
const metadataEdit = "github.event.changes.title != null || github.event.changes.body != null";
const lintAdmit = `(${scanEvents} || ${metadataEdit})`;
const prGatesCancel = "${{ github.event_name == 'pull_request' }}";
const prGates = parse(readFileSync(join(dir, "pr-gates.yml"), "utf8"));
// ci.yml exempts main from cancellation and gives each push its own slot.
// A cancelled main run cannot trigger the staging deploy.
const cancels = ({ name, text }: (typeof workflows)[number]) =>
  name === "pr-gates.yml"
    ? normalized(prGates.concurrency["cancel-in-progress"]) === prGatesCancel
    : /\nconcurrency:\n  group: [^\n]+\n  cancel-in-progress: (true|\$\{\{ github\.ref != 'refs\/heads\/main' && github\.event_name != 'merge_group' \}\}|\$\{\{ github\.event_name == 'pull_request' \}\})\n/.test(
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

describe("workflow concurrency", () => {
  it("cancels superseded runs of every pull_request workflow", () => {
    const pr = workflows.filter(({ text }) => /(^|\n)  pull_request:/.test(triggers(text)));
    expect(pr.length).toBeGreaterThan(2);
    expect(pr.filter((workflow) => !cancels(workflow)).map(({ name }) => name)).toEqual([]);
  });

  it("cancels only on pull_request events when a workflow has other triggers", () => {
    // A bare `true` would also cancel a dispatch or push run of the same group.
    const mixed = workflows.filter(({ text }) => {
      const t = triggers(text);
      return (
        /(^|\n)  pull_request:/.test(t) &&
        /(^|\n)  (push|schedule|workflow_dispatch|workflow_call):/.test(t)
      );
    });
    expect(mixed.length).toBeGreaterThan(2);
    expect(mixed.filter(({ text }) => bareCancel(text)).map(({ name }) => name)).toEqual([]);
  });

  it("groups every pull_request workflow per PR number", () => {
    const pr = workflows.filter(({ text }) => /(^|\n)  pull_request:/.test(triggers(text)));
    expect(
      pr
        .filter(({ name, text }) =>
          name === "pr-gates.yml"
            ? !prGates.concurrency.group.includes("github.event.pull_request.number")
            : !/\nconcurrency:\n  group: [^\n]*github\.event\.pull_request\.number[^\n]*\n/.test(
                text,
              ),
        )
        .map(({ name }) => name),
    ).toEqual([]);
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

  it("isolates recovery proof dispatches while cancelling superseded PR runs", () => {
    const proof =
      workflows.find(({ name }) => name === "admin-stale-save-ubuntu24-proof.yml")?.text ?? "";
    expect(proof).toContain(
      "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
    );
    expect(proof).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
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
    expect(ci).toContain(
      "group: ${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'push' && github.ref == 'refs/heads/main' && github.sha) || (github.event_name == 'schedule' && 'nightly') || github.ref }}",
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

// Opening a draft PR and marking it ready seconds later starts two pull_request
// runs on one head (`opened`, then `ready_for_review`), and the concurrency group
// cancels the older run. GitHub concludes a job whose `if` is false because its
// run was cancelled as `cancelled`, never `skipped` (as gitleaks shows in
// cancelled pr-gates runs). A required check passes only on success, skipped or
// neutral, so a cancelled gate keeps the merge blocked until the newer run's own
// gate succeeds, without leaving a red failure on the head.
const PASSING = ["success", "skipped", "neutral"];
const jobBlock = (text: string, id: string) =>
  text.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
// The job's own `run: |` script, dedented.
const runScript = (block: string) =>
  (block.split("\n        run: |\n")[1] ?? "exit 99")
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
// Only the conditions modelled here are accepted: any other gate condition fails
// this suite until its conclusion in a cancelled run is worked out and pinned.
const conditionHolds = (condition: string, runCancelled: boolean) => {
  if (condition === "always()") return true;
  if (condition === "${{ !cancelled() }}") return !runCancelled;
  throw new Error(`unmodelled gate condition: ${condition}`);
};
type Results = { scope: string; downstream: string };
const ciText = readFileSync(join(dir, "ci.yml"), "utf8");
const e2eText = readFileSync(join(dir, "e2e.yml"), "utf8");
type PrGateContext = {
  eventName: string;
  action?: string;
  sha: string;
  runId?: number;
  pr?: { number: number; head: { sha: string }; base: { ref: unknown } };
  changes?: {
    base?: { ref?: { from?: unknown }; sha?: { from: string } };
    title?: object;
    body?: object;
  };
  mergeGroupBase?: string;
  dispatchNumber?: string;
};

const pr = {
  number: 87,
  draft: false,
  head: { sha: "a".repeat(40) },
  base: { ref: "main", sha: "b".repeat(40) },
};
const initialMerge = "c".repeat(40);
const retargetMerge = "d".repeat(40);
const newHead = "e".repeat(40);
const retarget = {
  eventName: "pull_request",
  action: "edited",
  sha: retargetMerge,
  pr: { ...pr, base: { ref: "release", sha: "f".repeat(40) } },
  changes: { base: { ref: { from: pr.base.ref }, sha: { from: pr.base.sha } } },
};
const caseOnlyPR = { ...retarget.pr, base: { ...retarget.pr.base, ref: "Main" } };
const combinedEdit = { ...retarget.changes, title: { from: "prior title" } };
const ignoredNames = ["pr-gates ignored edit (lint)", "pr-gates ignored edit (scan)"];

// Model only the Actions expressions pinned below. Skipped jobs still get
// check names, so runner admission and the check namespace must agree.
function planPrGates(context: PrGateContext) {
  const { eventName, action, sha, runId, pr, changes, mergeGroupBase, dispatchNumber } = context;
  const admit =
    action !== "edited" ||
    [changes?.base?.ref?.from, pr?.base.ref].every((ref) => typeof ref === "string" && ref !== "");
  const metadata = changes?.title != null || changes?.body != null;
  const lint = admit || metadata;
  const slot = admit
    ? `source-${pr?.number ?? dispatchNumber ?? sha}`
    : metadata
      ? `metadata-${pr?.number}`
      : `ignored-edit-${runId}`;
  return {
    group: `pr-gates-${slot}`,
    cancelActive: eventName === "pull_request",
    checks: [lint ? "pr-lint" : ignoredNames[0], admit ? "gitleaks" : ignoredNames[1]],
    lintSha: lint ? (pr?.head.sha ?? sha) : null,
    scan: admit ? { sha, base: pr?.base.ref ?? mergeGroupBase } : null,
  };
}

describe("PR gate event matrix", () => {
  it("pins both check names, runner conditions, and revision inputs to the workflow", () => {
    expect(prGates.name).toBe("pr-gates");
    expect(Object.keys(prGates.jobs)).toEqual(["pr-lint", "gitleaks"]);
    expect(prGates.on.pull_request).toEqual({
      types: ["opened", "edited", "synchronize", "reopened", "ready_for_review"],
    });
    expect(prGates.on.push).toEqual({ branches: ["main"] });
    expect(prGates.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(normalized(prGates.concurrency.group)).toBe(
      normalized(`\${{ ${prGatesAdmit} && format('{0}-source-{1}', github.workflow, github.event.pull_request.number || inputs.pr_number || github.sha) ||
        (${metadataEdit}) && format('{0}-metadata-{1}', github.workflow, github.event.pull_request.number) ||
        format('{0}-ignored-edit-{1}', github.workflow, github.run_id) }}`),
    );

    const lint = prGates.jobs["pr-lint"];
    expect(normalized(lint.name)).toBe(`\${{ ${lintAdmit} && 'pr-lint' || '${ignoredNames[0]}' }}`);
    expect(normalized(lint.if)).toBe(`\${{ ${lintAdmit} }}`);
    expect(lint.env.PR_LINT_CHECKOUT_SHA).toBe(
      "${{ github.event.pull_request.head.sha || github.sha }}",
    );
    expect(lint.steps[0].with.ref).toBe("${{ env.PR_LINT_CHECKOUT_SHA }}");
    const ratchet = lint.steps.find(
      (step: { name?: string }) => step.name === "Ratchet tracked internal references",
    );
    expect(ratchet.env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(ratchet.env.BASE_REF).toBe("${{ github.base_ref }}");

    const scan = prGates.jobs.gitleaks;
    expect(normalized(scan.name)).toBe(
      `\${{ ${prGatesAdmit} && 'gitleaks' || '${ignoredNames[1]}' }}`,
    );
    expect(scan.needs).toBe("pr-lint");
    expect(normalized(scan.if)).toBe(`\${{ !cancelled() && ${prGatesAdmit} }}`);
    expect(scan.steps[0].with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    expect(scan.steps.at(-1).env.BASE_REF).toBe(
      "${{ github.base_ref || github.event.merge_group.base_ref }}",
    );
  });

  it.each([
    ["draft opened", "opened", { ...pr, draft: true }, initialMerge, undefined],
    ["ready on the same head", "ready_for_review", pr, initialMerge, undefined],
    ["source update", "synchronize", { ...pr, head: { sha: newHead } }, "new-merge", undefined],
    ["reopen", "reopened", pr, initialMerge, undefined],
    ["retarget with title edit", "edited", retarget.pr, retargetMerge, combinedEdit],
    ["case-only retarget", "edited", caseOnlyPR, retargetMerge, retarget.changes],
  ] as const)("%s runs both jobs in the same PR slot", (_case, action, current, sha, changes) => {
    expect(planPrGates({ eventName: "pull_request", action, sha, pr: current, changes })).toEqual({
      group: "pr-gates-source-87",
      cancelActive: true,
      checks: ["pr-lint", "gitleaks"],
      lintSha: current.head.sha,
      scan: { sha, base: current.base.ref },
    });
  });

  it.each([
    { base: { sha: { from: pr.base.sha } } },
    { base: { ref: { from: "" } } },
    { base: { ref: { from: true } } },
    { base: { ref: { from: ["main"] } } },
    {},
  ])("leaves the required checks and PR slot alone for %j", (changes) => {
    expect(planPrGates({ ...retarget, pr, changes, sha: initialMerge, runId: 42 })).toEqual({
      group: "pr-gates-ignored-edit-42",
      cancelActive: true,
      checks: ignoredNames,
      lintSha: null,
      scan: null,
    });
    expect(
      planPrGates({ ...retarget, pr: { ...pr, base: { ...pr.base, ref: null } }, runId: 43 }).scan,
    ).toBeNull();
  });

  it.each([
    ["synchronize", { title: { from: "previous title" } }],
    ["edited", { body: { from: null } }],
  ] as const)(
    "compares an active and pending %s source group with material edit lint",
    (action, changes) => {
      const active = planPrGates({ ...retarget, action: "opened", sha: initialMerge, pr });
      const waiting = planPrGates({ ...retarget, action });
      expect(waiting.group).toBe(active.group);
      expect(waiting.scan?.sha).toBe(retargetMerge);
      for (const runId of [44, 45]) {
        expect(planPrGates({ ...retarget, changes, runId })).toEqual({
          group: "pr-gates-metadata-87",
          cancelActive: true,
          checks: ["pr-lint", ignoredNames[1]],
          lintSha: pr.head.sha,
          scan: null,
        });
      }
    },
  );

  it.each([
    {
      eventName: "merge_group",
      action: "checks_requested",
      sha: "queue-sha",
      mergeGroupBase: "refs/heads/main",
    },
    { eventName: "push", sha: "main-push-sha" },
    { eventName: "workflow_dispatch", sha: pr.head.sha, dispatchNumber: "87" },
  ])("$eventName keeps its own revision and both jobs", (context) => {
    expect(planPrGates(context)).toEqual({
      group: `pr-gates-source-${context.dispatchNumber ?? context.sha}`,
      cancelActive: false,
      checks: ["pr-lint", "gitleaks"],
      lintSha: context.sha,
      scan: { sha: context.sha, base: context.mergeGroupBase },
    });
  });
});

const gates = [
  {
    gate: "check",
    block: jobBlock(ciText, "check"),
    // check's first guard: it fails before any other step reads scope outputs.
    script: (block: string) =>
      block.match(
        /- name: Require successful scope\n        env:\n          SCOPE_RESULT: [^\n]+\n        run: ([^\n]+)\n/,
      )?.[1] ?? "exit 99",
    env: ({ scope }: Results) => ({ SCOPE_RESULT: scope }),
  },
  {
    gate: "ci-ok",
    block: jobBlock(ciText, "ci-ok"),
    script: runScript,
    env: ({ scope, downstream }: Results) => ({
      SCOPE_RESULT: scope,
      ...{ FULL: "true", APP: "true", WORKER: "true", DB: "true", DRAFT: "false" },
      DOCS_ONLY: "false",
      CHECK_RESULT: downstream,
      KIT_BROWSER_RESULT: downstream,
      KIT_CALENDAR_RESULT: downstream,
      KIT_LIFELINE_RESULT: downstream,
      KIT_LIFELINE_ARTIFACT_ID: downstream === "success" ? "42" : "",
      A11Y_RESULT: downstream,
      LIGHTHOUSE_RESULT: downstream,
      BUDGET_RESULT: downstream,
    }),
  },
  {
    gate: "e2e-ok",
    block: jobBlock(e2eText, "e2e-ok"),
    script: runScript,
    env: ({ scope, downstream }: Results) => ({
      SCOPE: scope,
      SMOKE: downstream,
      SKIP_E2E: "false",
      DRAFT: "false",
    }),
  },
];
const conclusion = (gate: (typeof gates)[number], runCancelled: boolean, results: Results) => {
  const condition = gate.block.match(/\n    if: ([^\n]+)\n/)?.[1] ?? "";
  if (!conditionHolds(condition, runCancelled)) return runCancelled ? "cancelled" : "skipped";
  const run = spawnSync("bash", ["-c", gate.script(gate.block)], {
    env: gate.env(results),
    encoding: "utf8",
  });
  return run.status === 0 ? "success" : "failure";
};

describe("merge queue validation", () => {
  it.each(["ci.yml", "pr-gates.yml", "e2e.yml"])(
    "%s requests checks on the synthetic merge SHA without cancelling the queue run",
    (name) => {
      const text = workflows.find((workflow) => workflow.name === name)?.text ?? "";
      expect(triggers(text)).toMatch(/\n  merge_group:\n    types: \[checks_requested\]/);
      const cancel =
        name === "pr-gates.yml"
          ? normalized(prGates.concurrency["cancel-in-progress"])
          : text.match(/\n  cancel-in-progress: ([^\n]+)/)?.[1];
      expect(cancel).toBe(
        name === "ci.yml"
          ? "${{ github.ref != 'refs/heads/main' && github.event_name != 'merge_group' }}"
          : name === "pr-gates.yml"
            ? prGatesCancel
            : "${{ github.event_name == 'pull_request' }}",
      );
    },
  );

  it("does not resolve nonexistent PR metadata for a merge group", () => {
    const text = readFileSync(join(dir, "pr-gates.yml"), "utf8");
    const lint = jobBlock(text, "pr-lint");
    for (const name of [
      "Ratchet tracked internal references",
      "Resolve PR title/body",
      "List PR commit subjects",
      "Resolve PR head ref",
      "Check title, body and commits",
    ]) {
      const step = lint.split(`- name: ${name}\n`)[1]?.split(/\n      - /)[0] ?? "";
      expect(step).toMatch(/if: [^\n]*github\.event_name != 'merge_group'/);
    }
    expect(lint).toContain("if: github.event_name == 'merge_group'");
    expect(lint).toContain("pr-lint passes for merge_group");
    expect(normalized(prGates.jobs.gitleaks.if)).toBe(`\${{ !cancelled() && ${prGatesAdmit} }}`);
  });

  it("runs full CI and browser smoke without PR API context", () => {
    for (const text of [ciText, e2eText]) {
      const scratch = mkdtempSync(join(tmpdir(), "merge-group-scope-"));
      try {
        const output = join(scratch, "outputs");
        // The classify step (`id: scope`), not the token-holding fetch step
        // ahead of it: merge_group must reach the constant verdicts without
        // any PR API context.
        const classify = jobBlock(text, "scope").split("\n      - id: scope\n")[1] ?? "";
        const result = spawnSync("bash", ["-c", runScript(classify)], {
          env: { EVENT_NAME: "merge_group", GITHUB_OUTPUT: output },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const verdicts = readFileSync(output, "utf8");
        expect(verdicts).toContain("docs_only=false");
        expect(verdicts).not.toContain("skip_e2e=true");
        if (text === ciText) {
          expect(verdicts).toContain("full=true");
          expect(verdicts).toContain("draft=false");
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it("preserves required check names and keeps deployments out of merge_group", () => {
    expect(jobBlock(ciText, "ci-ok")).toContain("name: ci-ok");
    expect(jobBlock(e2eText, "browser-smoke")).toContain("name: browser-smoke");
    for (const name of ["deploy.yml", "deploy-production.yml"]) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(triggers(text)).not.toContain("merge_group:");
    }
  });
});

describe("superseded duplicate pull_request runs", () => {
  it.each(gates)("$gate passes a green run", (gate) => {
    expect(conclusion(gate, false, { scope: "success", downstream: "success" })).toBe("success");
  });

  it.each(gates)("$gate is cancelled, neither failed nor passing, in a cancelled run", (gate) => {
    const result = conclusion(gate, true, { scope: "cancelled", downstream: "cancelled" });
    expect(result).toBe("cancelled");
    expect(PASSING).not.toContain(result);
  });

  it.each(gates)("$gate still fails when scope fails in a run that was not cancelled", (gate) => {
    expect(conclusion(gate, false, { scope: "failure", downstream: "skipped" })).toBe("failure");
  });

  // A job that times out or is cancelled on its own leaves its run uncancelled,
  // so the gate runs and must reject the cancelled result.
  it.each(gates)("$gate fails when scope was cancelled but its run was not", (gate) => {
    expect(conclusion(gate, false, { scope: "cancelled", downstream: "skipped" })).toBe("failure");
  });

  // Only check's scope guard is modelled here; ci/a11y-policy.test.mjs and
  // `npm run gate:selftest` pin its other guards rejecting a cancelled job.
  it.each(gates.filter(({ gate }) => gate !== "check"))(
    "$gate fails when a gated job was cancelled but its run was not",
    (gate) => {
      expect(conclusion(gate, false, { scope: "success", downstream: "cancelled" })).toBe(
        "failure",
      );
    },
  );
});
