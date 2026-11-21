import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type RunnerInputs = Record<string, unknown>;
type Job = {
  "runs-on"?: unknown;
  uses?: string;
  with?: RunnerInputs;
  steps?: { with?: RunnerInputs }[];
};
type Workflow = { jobs: Record<string, Job>; on: string | string[] | Record<string, unknown> };

// This checks the source in this checkout, not older or modified refs loaded
// by GitHub for a branch dispatch. See docs/private-flip-checklist.md.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    return { name, text, source: parse(text) as Workflow };
  });

const hosted = "ubuntu-latest";
const hostedJson = JSON.stringify([hosted]);
// Keep the fixed OS for browser fixtures, visual baselines, recovery and the XFS fixture.
// Re-baseline browser-smoke in the same PR as any bump (docs/visual-regression.md).
const pinnedHostedJobs = new Map([
  ["e2e.yml", "browser-smoke"],
  ["kit-activity-log-diagnostic.yml", "browser"],
  ["kit-home-evidence.yml", "capture"],
  ["kit-event-evidence.yml", "capture"],
  ["admin-stale-save-ubuntu24-proof.yml", "recovery-proof"],
  ["kit-footer-browser.yml", "footer-browser"],
  ["xfs-qualification.yml", "fixture"],
]);
const localCall = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/;
const frozenLocalCall =
  /^TogetherWeOwn\/two-web-next\/\.github\/workflows\/([\w.-]+\.ya?ml)@([0-9a-f]{40})$/;

// These same-repository callees were checked at this immutable revision; their
// job definitions matched the corresponding local workflows when pinned.
const verifiedLocalRef = "38581ef492f5c972969f5dfada396a9f0e2ee989";
const verifiedLocalWorkflows = [
  "release.yml",
  "rollback-production.yml",
  "web-quality-origin.yml",
  "zap-staging.yml",
];

// These pins were checked for defaults and runner inputs. A repin needs
// another source review; a full SHA alone doesn't establish runner selection.
const verifiedHostedOrgReusables = new Map([
  ["review-rules.yml@2ef8ad6447e11d019ac3098bcfd011193b75266a", "runs-on-json"],
  ["test-guard.yml@2ef8ad6447e11d019ac3098bcfd011193b75266a", "runs-on-json"],
  ["pr-size.yml@ac9ce8d63e0cebd19ede904ac79137190c329964", "runs-on"],
  ["pr-size-gate.yml@ac9ce8d63e0cebd19ede904ac79137190c329964", "runs-on"],
  ["pr-size-weekly.yml@ac9ce8d63e0cebd19ede904ac79137190c329964", "runs-on"],
]);

function isVerifiedFrozenLocal(uses: string) {
  const match = uses.match(frozenLocalCall);
  return (
    match !== null && verifiedLocalWorkflows.includes(match[1]!) && match[2] === verifiedLocalRef
  );
}

function expectHostedJob(name: string, id: string, job: Job) {
  const label = `${name} job ${id}`;
  if (job.uses === undefined) {
    const expected = pinnedHostedJobs.get(name) === id ? "ubuntu-24.04" : hosted;
    expect(job["runs-on"], `${label} uses literal ${expected}`).toBe(expected);
  } else {
    expect(job, `${label} is a reusable call without a local runner`).not.toHaveProperty("runs-on");
    const target = job.uses.match(localCall)?.[1];
    if (target) {
      const workflow = workflows.find((entry) => entry.name === target);
      expect(events(workflow?.source.on), `${label} calls local workflow ${target}`).toContain(
        "workflow_call",
      );
    } else if (!isVerifiedFrozenLocal(job.uses)) {
      const org = job.uses.match(/^TogetherWeOwn\/\.github\/\.github\/workflows\/(.+)$/)?.[1];
      const input = verifiedHostedOrgReusables.get(org ?? "");
      expect(input, `${label} uses an assessed reusable workflow: ${job.uses}`).toBeDefined();
      // GitHub matches reusable-workflow inputs case-insensitively.
      const inputs = Object.entries(job.with ?? {});
      const overrides = inputs.filter(([key]) => key.toLowerCase() === input);
      if (org?.startsWith("review-rules.yml@")) {
        expect(overrides, `${label} needs explicit ${input}`).not.toHaveLength(0);
      }
      for (const [key, value] of overrides) {
        expect(value, `${label} overrides ${key} only with hosted Linux`).toBe(hostedJson);
      }
    }
  }
  for (const inputs of [job.with, ...(job.steps ?? []).map((step) => step.with)]) {
    for (const [key, value] of Object.entries(inputs ?? {})) {
      const input = key.toLowerCase();
      if (input === "runs-on" || input === "runs-on-json") {
        expect([JSON.stringify(hosted), hostedJson], `${label} input ${key}`).toContain(value);
      }
    }
  }
}

function directJobs({ jobs }: Workflow) {
  return Object.entries(jobs)
    .filter(([, job]) => job.uses === undefined)
    .map(([id, job]) => ({ id, runsOn: job["runs-on"] }));
}

function events(on: Workflow["on"] | undefined) {
  if (typeof on === "string") return [on];
  return Array.isArray(on) ? on : Object.keys(on ?? {});
}

describe("workflow runner labels", () => {
  it("keeps release, rollback and migration jobs on hosted runners in both visibilities", () => {
    for (const [name, ids] of [
      ["release.yml", ["tag"]],
      ["rollback-production.yml", ["preflight", "rollback-production", "notify"]],
      ["db-migrate.yml", ["migrate"]],
    ] as const) {
      const workflow = workflows.find((entry) => entry.name === name);
      expect(workflow, name).toBeDefined();
      expect(directJobs(workflow!.source).map(({ id, runsOn }) => [id, runsOn])).toEqual(
        ids.map((id) => [id, hosted]),
      );
      expect(workflow!.text).not.toMatch(/CI_OVERFLOW_RUNNER|private-runner-json/);
    }
    const release = workflows.find(({ name }) => name === "release.yml")!.text;
    const calls = release.match(
      /^        uses: TogetherWeOwn\/\.github\/actions\/calver@[0-9a-f]{40}.*$/gm,
    );
    expect(calls).toHaveLength(4);
    expect(new Set(calls)).toEqual(
      new Set([
        "        uses: TogetherWeOwn/.github/actions/calver@1e3c0c04b15a31baf498398417d98e44d0d8cbdb # shared CalVer releaser",
      ]),
    );
    expect(release.match(/^          runs-on-json: '"ubuntu-latest"'$/gm)).toHaveLength(4);
  });

  it("keeps every main CI job hosted for public and private branch dispatches", () => {
    const workflow = workflows.find(({ name }) => name === "ci.yml");
    expect(workflow).toBeDefined();
    const ciJobs = directJobs(workflow!.source);
    expect(ciJobs.map(({ id }) => id)).toEqual([
      "join-evidence-source",
      "bot-contract-drift",
      "scope",
      "queue-syntax-smoke",
      "docs-links",
      "a11y",
      "dependency-admission",
      "check",
      "node22-shard",
      "node22-compat",
      "bundle-budget",
      "lighthouse",
      "kit-browser-fixture",
      "ci-ok",
    ]);
    for (const { id, runsOn } of ciJobs) {
      // An unconditional selector also covers private workflow_dispatch on a
      // non-main branch, which the former PR-only guard did not cover.
      expect(runsOn, `ci.yml job ${id}`).toBe(hosted);
    }
    expect(events(workflow!.source.on)).toContain("workflow_dispatch");
  });

  it("runs the Join capture matrix only on explicit manual dispatch", () => {
    const workflow = workflows.find(({ name }) => name === "kit-browser-fixture.yml");
    expect(workflow?.source).toMatchObject({
      on: { workflow_dispatch: { inputs: { join_evidence: { type: "boolean", default: false } } } },
      jobs: {
        "join-evidence": { if: "github.event_name == 'workflow_dispatch' && inputs.join_evidence" },
      },
    });
  });

  it("keeps deploy, proof and gate jobs hosted for every event and visibility", () => {
    for (const [name, ids] of [
      [
        "deploy-production.yml",
        "preflight staging-soak regression deploy-production post-deploy-watch notify".split(" "),
      ],
      ["deploy.yml", ["deploy-staging"]],
      ["gradual-promote-proof.yml", ["proof"]],
      ["pr-gates.yml", ["pr-lint", "gitleaks"]],
      ["staging-rollback-drill.yml", ["plan", "verdict"]],
    ] as const) {
      const workflow = workflows.find((entry) => entry.name === name);
      expect(workflow, name).toBeDefined();
      expect(
        directJobs(workflow!.source).map(({ id, runsOn }) => [id, runsOn]),
        name,
      ).toEqual(ids.map((id) => [id, hosted]));
    }
  });

  it("keeps all featured proof jobs on standard hosted runners", () => {
    const workflow = workflows.find(({ name }) => name === "featured-offline-proof.yml");
    expect(workflow).toBeDefined();
    expect(directJobs(workflow!.source).map(({ id, runsOn }) => [id, runsOn])).toEqual(
      ["scope", "capture", "current-source", "featured-proof"].map((id) => [id, hosted]),
    );
  });

  it("pins event evidence to the hosted visual runner", () => {
    const workflow = workflows.find(({ name }) => name === "kit-event-evidence.yml");
    expect(workflow).toBeDefined();
    expect(directJobs(workflow!.source).find(({ id }) => id === "capture")?.runsOn).toBe(
      "ubuntu-24.04",
    );
  });

  it("keeps backup and staging jobs on standard hosted runners for every event", () => {
    for (const [name, ids] of [
      ["backup-bootstrap-selftest.yml", ["scope", "bootstrap-selftest", "backup-bootstrap"]],
      ["backup-restore-proof.yml", ["scope", "proof", "backup-restore-proof-ok"]],
      ["db-backup.yml", ["backup"]],
      ["error-rate-gate-rehearsal.yml", ["rehearsal"]],
      ["staging-catalog-preflight.yml", ["preflight"]],
      ["staging-census.yml", ["scope", "census"]],
      ["staging-role-bootstrap.yml", ["bootstrap"]],
      ["staging-smoke.yml", ["internal-action-smoke"]],
    ] as const) {
      const workflow = workflows.find((entry) => entry.name === name);
      expect(workflow, name).toBeDefined();
      expect(
        directJobs(workflow!.source).map(({ id, runsOn }) => [id, runsOn]),
        name,
      ).toEqual(ids.map((id) => [id, hosted]));
    }
  });

  it("pins backup and staging container images to their intended major versions", () => {
    for (const [name, image] of [
      ["backup-bootstrap-selftest.yml", "python:3.13-bookworm"],
      ["backup-restore-proof.yml", "postgres:18"],
      ["staging-smoke.yml", "node:24-bookworm"],
    ] as const) {
      const workflow = workflows.find((entry) => entry.name === name);
      expect(workflow, name).toBeDefined();
      expect(workflow!.text, name).toContain(`${image}@sha256:`);
      expect(workflow!.text, name).toMatch(new RegExp(`${image}@sha256:[a-f0-9]{64}(?:\\s|$)`));
    }
  });

  it("passes the staging version to the rehearsal through the step environment", () => {
    const workflow = workflows.find(({ name }) => name === "error-rate-gate-rehearsal.yml");
    expect(workflow).toBeDefined();
    const step = workflow!.text.split("      - name: Simulated elevated rate")[1];
    expect(step).toBeDefined();
    expect(step).toContain("SIM_VERSION: ${{ steps.staging-version.outputs.id }}");
    expect(step).not.toContain('export SIM_VERSION="${{');
    expect(step).toContain('NEW_VERSION="$SIM_VERSION"');
  });

  it("keeps the XFS fixture on a disposable hosted runner for every event", () => {
    const workflow = workflows.find(({ name }) => name === "xfs-qualification.yml");
    expect(workflow).toBeDefined();
    expect(directJobs(workflow!.source).find(({ id }) => id === "fixture")?.runsOn).toBe(
      "ubuntu-24.04",
    );
  });

  it("recognizes only verified pinned same-repository calls", () => {
    const caller = (target: string, ref: string) =>
      `TogetherWeOwn/two-web-next/.github/workflows/${target}@${ref}`;
    for (const target of verifiedLocalWorkflows) {
      expect(isVerifiedFrozenLocal(caller(target, verifiedLocalRef))).toBe(true);
    }
    expect(isVerifiedFrozenLocal(caller("release.yml", "0".repeat(40)))).toBe(false);
    expect(isVerifiedFrozenLocal(caller("unknown.yml", verifiedLocalRef))).toBe(false);
    expect(isVerifiedFrozenLocal(caller("release.yml", "main"))).toBe(false);
  });

  it("finds every workflow job", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, source } of workflows) {
      expect(Object.keys(source.jobs).length, name).toBeGreaterThan(0);
      expect(events(source.on).length, `${name} declares workflow events`).toBeGreaterThan(0);
    }
  });

  it("requires the literal hosted runner or an assessed reusable call for every job", () => {
    for (const { name, source } of workflows) {
      for (const [id, job] of Object.entries(source.jobs)) expectHostedJob(name, id, job);
    }
    for (const [name, id] of pinnedHostedJobs) {
      const workflow = workflows.find((entry) => entry.name === name);
      expect(workflow?.source.jobs[id]?.["runs-on"], `${name} job ${id}`).toBe("ubuntu-24.04");
    }
  });

  it.each([
    ["an omitted runner", ""],
    ["a self-hosted label list", "runs-on: [self-hosted, two-selfhosted]"],
    ["a runner group", "runs-on: {group: private, labels: ubuntu-latest}"],
    ["an ARM runner", "runs-on: ubuntu-24.04-arm"],
    ["a larger runner", "runs-on: ubuntu-24.04-16core"],
    ["a variable selector", "runs-on: ${{ vars.CI_OVERFLOW_RUNNER }}"],
    [
      "a visibility selector",
      "runs-on: ${{ github.event.repository.private && 'self-hosted' || 'ubuntu-latest' }}",
    ],
  ])("rejects %s in a branch-dispatched workflow", (_case, selector) => {
    const yaml = `on: workflow_dispatch\njobs:\n  check:\n    name: Check\n    ${selector}`;
    const source = parse(yaml) as Workflow;
    expect(() => expectHostedJob("fixture.yml", "check", source.jobs.check!)).toThrow(
      "uses literal ubuntu-latest",
    );
  });

  it("requires fixed runner labels for the pinned jobs only", () => {
    const fixed = { "runs-on": "ubuntu-24.04" };
    const latest = { "runs-on": hosted };
    expect(() => expectHostedJob("e2e.yml", "browser-smoke", fixed)).not.toThrow();
    expect(() => expectHostedJob("e2e.yml", "browser-smoke", latest)).toThrow(
      "uses literal ubuntu-24.04",
    );
    expect(() => expectHostedJob("fixture.yml", "check", fixed)).toThrow(
      "uses literal ubuntu-latest",
    );
  });

  it("rejects unassessed reusable pins and non-hosted runner overrides", () => {
    const uses =
      "TogetherWeOwn/.github/.github/workflows/test-guard.yml@2ef8ad6447e11d019ac3098bcfd011193b75266a";
    const reviewRules = uses.replace("test-guard.yml", "review-rules.yml");
    expect(() => expectHostedJob("fixture.yml", "call", { uses })).not.toThrow();
    expect(() => expectHostedJob("fixture.yml", "call", { uses: reviewRules })).toThrow(
      "needs explicit runs-on-json",
    );
    expect(() =>
      expectHostedJob("fixture.yml", "call", { uses: uses.replace(/@.*/, `@${"0".repeat(40)}`) }),
    ).toThrow("uses an assessed reusable workflow");
    for (const [key, value] of [
      ["runs-on-json", '["self-hosted"]'],
      ["Runs-On-Json", '["windows-latest"]'],
    ] as const) {
      expect(() =>
        expectHostedJob("fixture.yml", "call", { uses, with: { [key]: value } }),
      ).toThrow(`overrides ${key} only with hosted Linux`);
    }
    expect(() =>
      expectHostedJob("fixture.yml", "direct", {
        "runs-on": hosted,
        steps: [{ with: { "Runs-On-Json": "${{ vars.CI_OVERFLOW_RUNNER }}" } }],
      }),
    ).toThrow("input Runs-On-Json");
  });

  it("does not restore retired fleet or overflow settings in workflow source", () => {
    for (const { name, text } of workflows) {
      const retired = text
        .split("\n")
        .filter(
          (line) =>
            !/^\s*#/.test(line) &&
            /self-hosted|two-selfhosted|CI_OVERFLOW_|private-runner-json/.test(line),
        );
      expect(retired, name).toEqual([]);
    }
  });

  it("requires a separate assessment before allowing frozen local calls from PR events", () => {
    const forEvent = (event: string) =>
      workflows.filter((w) => events(w.source.on).includes(event));
    const prWorkflows = forEvent("pull_request");
    const mergeQueueWorkflows = forEvent("merge_group");
    expect(prWorkflows.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "backup-bootstrap-selftest.yml",
        "ci.yml",
        "featured-offline-proof.yml",
        "pr-gates.yml",
      ]),
    );
    expect(mergeQueueWorkflows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["ci.yml", "e2e.yml", "pr-gates.yml"]),
    );
    // A relative reusable-workflow call inherits the caller's event.
    const visited = new Set<string>();
    const checkCalls = ({ name, source }: (typeof workflows)[number]) => {
      if (visited.has(name)) return;
      visited.add(name);
      for (const [id, { uses }] of Object.entries(source.jobs)) {
        if (!uses) continue;
        expect(uses, `${name} job ${id} has no unassessed pinned local call`).not.toMatch(
          frozenLocalCall,
        );
        const target = uses.match(localCall)?.[1];
        if (target) {
          const workflow = workflows.find((entry) => entry.name === target);
          expect(workflow, `${name} calls ${target}`).toBeDefined();
          checkCalls(workflow!);
        }
      }
    };
    for (const workflow of [...prWorkflows, ...mergeQueueWorkflows]) checkCalls(workflow);
  });
});
