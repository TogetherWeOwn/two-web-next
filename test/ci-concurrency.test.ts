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
const prGatesCancel =
  "${{ github.event_name == 'pull_request' && !(github.event.action == 'edited' && !github.event.changes.base && (github.event.changes.title || github.event.changes.body)) }}";
// ci.yml exempts main from cancellation and gives each push its own slot.
// A cancelled main run cannot trigger the staging deploy.
const cancels = ({ name, text }: (typeof workflows)[number]) =>
  name === "pr-gates.yml"
    ? text.includes(`\n  cancel-in-progress: ${prGatesCancel}\n`)
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
        .filter(
          ({ text }) =>
            !/\nconcurrency:\n  group: [^\n]*github\.event\.pull_request\.number[^\n]*\n/.test(
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
const prGates = parse(readFileSync(join(dir, "pr-gates.yml"), "utf8"));

// Model the Actions predicate pinned by the matrix below. GitHub's default
// single queue replaces the waiting run even when the active run is kept.
function cancelsActivePrGate(event: string, action: string, changes: object) {
  const metadataOnly =
    action === "edited" && !("base" in changes) && ("title" in changes || "body" in changes);
  return event === "pull_request" && !metadataOnly;
}

describe("PR gate event matrix", () => {
  it("keeps both Actions checks and their event-specific revisions in one sequential run", () => {
    expect(prGates.name).toBe("pr-gates");
    expect(Object.keys(prGates.jobs)).toEqual(["pr-lint", "gitleaks"]);
    expect(prGates.on.pull_request).toEqual({
      types: ["opened", "edited", "synchronize", "reopened", "ready_for_review"],
    });
    expect(prGates.on.push).toEqual({ branches: ["main"] });
    expect(prGates.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(prGates.concurrency).toEqual({
      group:
        "${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pr_number || github.sha }}",
      "cancel-in-progress": prGatesCancel,
    });

    const lint = prGates.jobs["pr-lint"];
    expect(lint.name).toBe("pr-lint");
    expect(lint.if).toBeUndefined();
    expect(lint.env.PR_LINT_CHECKOUT_SHA).toBe(
      "${{ github.event.pull_request.head.sha || github.sha }}",
    );
    expect(lint.steps[0].with.ref).toBe("${{ env.PR_LINT_CHECKOUT_SHA }}");

    const scan = prGates.jobs.gitleaks;
    expect(scan.name).toBe("gitleaks");
    expect(scan.needs).toBe("pr-lint");
    expect(scan.if).toBe("${{ !cancelled() }}");
    expect(scan.steps[0].with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    expect(scan.steps.at(-1)).toEqual({
      name: "Scan the full history",
      env: {
        GITLEAKS_BIN: "${{ runner.temp }}/gitleaks",
        EVENT_NAME: "${{ github.event_name }}",
        BASE_REF: "${{ github.base_ref || github.event.merge_group.base_ref }}",
      },
      run: "bash .github/scripts/gitleaks-scan.sh",
    });
  });

  it.each([
    ["title edit", "pull_request", "edited", { title: { from: "prior title" } }, false],
    ["body edit", "pull_request", "edited", { body: { from: null } }, false],
    ["retarget", "pull_request", "edited", { base: { ref: { from: "old-base" } } }, true],
    ["retarget with body edit", "pull_request", "edited", { base: {}, body: {} }, true],
    ["unclassified edit", "pull_request", "edited", {}, true],
    ["changed head", "pull_request", "synchronize", {}, true],
    ["ready for review", "pull_request", "ready_for_review", {}, true],
    ["main push", "push", "", {}, false],
    ["queue commit", "merge_group", "checks_requested", {}, false],
    ["manual dispatch", "workflow_dispatch", "", {}, false],
  ] as const)(
    "%s selects cancellation without changing required scan eligibility",
    (_name, event, action, changes, cancelActive) => {
      expect(cancelsActivePrGate(event, action, changes)).toBe(cancelActive);
      expect(conditionHolds(prGates.jobs.gitleaks.if, false)).toBe(true);
    },
  );

  it.each(["in_progress", "failure"])(
    "retains a %s scan verdict until another real same-head scan",
    (scanState) => {
      // Model the run group while edits arrive. A queued synchronize may be the
      // only run for this revision, so its replacement must still scan it.
      const scanCondition = prGates.jobs.gitleaks.if;
      const cancelledVerdict = conditionHolds(scanCondition, true) ? "skipped" : "cancelled";
      const active = { revision: "merge-sha", scan: scanState };
      let pending = { revision: active.revision, event: "synchronize", scan: "queued" };
      const superseded = [];
      for (const event of ["first edit", "last edit"]) {
        if (cancelsActivePrGate("pull_request", "edited", { body: { from: "previous body" } })) {
          active.scan = cancelledVerdict;
        }
        superseded.push({ ...pending, scan: cancelledVerdict });
        pending = { revision: active.revision, event, scan: "queued" };
      }

      expect(active.scan).toBe(scanState);
      expect(superseded.map(({ event, scan }) => [event, scan])).toEqual([
        ["synchronize", "cancelled"],
        ["first edit", "cancelled"],
      ]);
      expect(pending).toEqual({ revision: active.revision, event: "last edit", scan: "queued" });
      expect([active, pending, ...superseded].some(({ scan }) => PASSING.includes(scan))).toBe(
        false,
      );
      expect(conditionHolds(scanCondition, false)).toBe(true);
    },
  );
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
      const cancel = text.match(/\n  cancel-in-progress: ([^\n]+)/)?.[1];
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
    expect(jobBlock(text, "gitleaks")).toContain("if: ${{ !cancelled() }}");
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
