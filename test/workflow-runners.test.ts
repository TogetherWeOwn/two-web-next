import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// This repository is public, so every job runs on an explicit standard free
// GitHub-hosted Linux runner: `ubuntu-latest`, except e2e.yml browser-smoke,
// which is pinned to `ubuntu-24.04` for stable visual baselines. No job selects
// a runner by repo visibility, repo variable or event, and none uses a
// self-hosted, larger or third-party runner. A pull_request run therefore
// cannot reach any runner but GitHub-hosted Linux. See
// docs/private-flip-checklist.md.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const hosted = "ubuntu-latest";
// Visual baselines render body text with the runner's system fonts, so
// e2e.yml browser-smoke is deliberately pinned to ubuntu-24.04 and
// re-baselined in the same PR on bumps (docs/visual-regression.md).
const expectedRunner = (name: string, id: string) =>
  name === "e2e.yml" && id === "browser-smoke" ? "ubuntu-24.04" : hosted;
// A local reusable-workflow call; both the `./` and `$/` spellings are accepted.
const localUses = String.raw`(?:\./|\$/)\.github/workflows/([\w.-]+\.ya?ml)`;

function jobs(text: string) {
  const body = text.slice(text.search(/^jobs:\n/m));
  const found: { id: string; runsOn: string | undefined; orgReusable: boolean; block: string }[] =
    [];
  for (const block of body.split(/^(?=  [A-Za-z0-9_-]+:\n)/m).slice(1)) {
    const id = block.match(/^  ([A-Za-z0-9_-]+):\n/)?.[1] ?? "";
    // A reusable-workflow call has no runner; the called workflow's jobs are checked.
    if (new RegExp(`^    uses: ${localUses}$`, "m").test(block)) continue;
    // Same for a pinned org reusable call (full-SHA pin, never a moving tag):
    // the org workflow pins its own runners, so there is no local label to check.
    const orgReusable =
      /^    uses: TogetherWeOwn\/\.github\/\.github\/workflows\/[\w.-]+\.ya?ml@[0-9a-f]{40}$/m.test(
        block,
      );
    found.push({ id, runsOn: block.match(/^    runs-on: (.*)$/m)?.[1], orgReusable, block });
  }
  return found;
}

describe("workflow runner labels", () => {
  it("finds every workflow job", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, text } of workflows) expect(jobs(text).length, name).toBeGreaterThan(0);
  });

  it("runs every job on its explicit standard GitHub-hosted Linux runner", () => {
    let checked = 0;
    for (const { name, text } of workflows) {
      for (const { id, runsOn, orgReusable, block } of jobs(text)) {
        if (orgReusable) continue;
        expect(runsOn, `${name} job ${id} names a runner`).toBeDefined();
        expect(runsOn, `${name} job ${id}`).toBe(expectedRunner(name, id));
        expect(block, `${name} job ${id} has one runs-on`).not.toMatch(
          /^ +runs-on:[\s\S]*^ +runs-on:/m,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("has no self-hosted, overflow or visibility-based runner selector", () => {
    for (const { name, text } of workflows) {
      const selectors = text
        .split("\n")
        .filter((line) =>
          /self-hosted|selfhosted|CI_OVERFLOW|private-runner-json|runs-on(?:-json)?:.*(?:\$\{\{|fromJSON|vars\.)/.test(
            line,
          ),
        );
      expect(selectors, name).toEqual([]);
    }
  });

  it("checks local reusable targets and hosted runner inputs on every event", () => {
    let localCalls = 0;
    let runnerInputs = 0;
    for (const { name, text } of workflows) {
      const parsed = parse(text) as {
        jobs: Record<
          string,
          {
            uses?: string;
            with?: Record<string, string>;
            steps?: { with?: Record<string, string> }[];
          }
        >;
      };
      for (const job of Object.values(parsed.jobs)) {
        const target = job.uses?.match(new RegExp(`^${localUses}$`))?.[1];
        if (target) {
          expect(
            workflows.some((workflow) => workflow.name === target),
            `${name}: ${target}`,
          ).toBe(true);
          localCalls += 1;
        }
        for (const inputs of [job.with, ...(job.steps ?? []).map((step) => step.with)]) {
          for (const key of ["runs-on", "runs-on-json"]) {
            if (!inputs?.[key]) continue;
            const runner: unknown = JSON.parse(inputs[key]);
            expect(Array.isArray(runner) ? runner : [runner], `${name}: ${key}`).toEqual([hosted]);
            runnerInputs += 1;
          }
        }
      }
    }
    expect(localCalls).toBeGreaterThan(0);
    expect(runnerInputs).toBeGreaterThan(0);
  });

  // Trigger parsing: the block `on:` form (until the next top-level key) and
  // the inline `on: pull_request` / `on: [pull_request, ...]` forms. Anything
  // else fails the test loudly instead of reading as "not PR-triggered".
  function triggersOnPullRequest(name: string, text: string) {
    const onLine = text.match(/^on:(.*)$/m);
    expect(onLine, `${name} has a parseable on: line`).not.toBeNull();
    const inline = (onLine![1] ?? "").trim();
    if (inline !== "" && !inline.startsWith("#")) return /\bpull_request\b/.test(inline);
    const start = text.search(/^on:.*\n/m);
    const rest = text.slice(start + onLine![0].length + 1);
    const end = rest.search(/^[A-Za-z]/m);
    const block = end < 0 ? rest : rest.slice(0, end);
    expect(
      /^ {2}[A-Za-z_]+\s*:/m.test(block),
      `${name} has a parseable on: block with at least one trigger`,
    ).toBe(true);
    return /^ {2}pull_request\s*:/m.test(block);
  }

  // Org reusable workflows whose pinned ref was verified to run only on
  // GitHub-hosted runners with no caller-side runner input (checked at the
  // pin on 2026-11-01). A repin fails this test until the new pin is
  // re-verified and this list updated; any other org reusable call from a
  // PR-triggered workflow must pass an explicit hosted runner input.
  const verifiedHostedOrgReusables = [
    "TogetherWeOwn/.github/.github/workflows/test-guard.yml@3fffeb9f9465f371763fcc3c789ed4baefe38f95",
  ];

  it("keeps pull_request and merge_group runs on GitHub-hosted Linux", () => {
    const prWorkflows = workflows.filter(({ name, text }) => triggersOnPullRequest(name, text));
    // Non-vacuity: the PR-triggered workflows with the most jobs are all in scope.
    expect(prWorkflows.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "backup-bootstrap-selftest.yml",
        "ci.yml",
        "featured-offline-proof.yml",
        "pr-gates.yml",
      ]),
    );
    let hostedJobs = 0;
    // A local reusable-workflow call inherits the caller's event, so a
    // workflow a PR-triggered workflow calls must meet the same rule.
    const checkJobs = (name: string, text: string) => {
      for (const { id, runsOn, orgReusable, block } of jobs(text)) {
        if (orgReusable) {
          // The call inherits the caller's event, so the reusable job must
          // be pinned to GitHub-hosted runners from here, whatever default
          // the called workflow would pick for a private caller repository.
          const uses = block.match(
            /^    uses: (TogetherWeOwn\/\.github\/\.github\/workflows\/[\w.-]+\.ya?ml@[0-9a-f]{40})$/m,
          )?.[1];
          const explicitHosted = /^\s+runs-on(?:-json)?: '\["ubuntu-latest"\]'$/m.test(block);
          expect(
            explicitHosted || (uses !== undefined && verifiedHostedOrgReusables.includes(uses)),
            `${name} job ${id} pins hosted runners for its org reusable call (${uses ?? "unparsed"})`,
          ).toBe(true);
          continue;
        }
        if (runsOn === undefined) continue;
        expect(runsOn, `${name} job ${id} keeps PR events hosted`).toBe(expectedRunner(name, id));
        hostedJobs += 1;
      }
    };
    for (const { name, text } of prWorkflows) {
      checkJobs(name, text);
      for (const call of text.matchAll(new RegExp(`uses: ${localUses}`, "g"))) {
        const target = workflows.find((w) => w.name === call[1]);
        expect(target, `${name} calls ${call[1]}`).toBeDefined();
        checkJobs(target!.name, target!.text);
      }
    }
    expect(hostedJobs).toBeGreaterThan(0);
  });
});
