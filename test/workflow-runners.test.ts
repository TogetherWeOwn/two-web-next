import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The org's two-selfhosted runner group refuses public repos, so a job pinned to
// a self-hosted label queues forever while this repo is public (TOG-12326). Every
// job must reach the self-hosted fleet only behind a repo-visibility check and
// otherwise run on GitHub-hosted Linux; the CI_OVERFLOW_* repo vars may still
// route a switch-enabled job elsewhere without a PR, but only while the repo is
// private: the public guard is evaluated first, so a repo variable can never
// send a public repo's run (a fork's pull_request included) to another runner.
//
// Runner separation: the self-hosted fleet also serves the deploy, backup and
// migration workflows, so code that has not landed on main must never run on
// it. In every workflow that triggers on pull_request, the runs-on expression
// must therefore force GitHub-hosted Linux for pull_request and merge_group
// events in both visibilities (the PR term ahead of the overflow vars, so the
// vars cannot reroute those events either), and reach the self-hosted fleet
// only for other events (main pushes, schedules, manual dispatches) while the
// repository is private. See docs/private-flip-checklist.md.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const hosted = "ubuntu-latest";
const byVisibility = `\${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || '${hosted}' }}`;
const byVisibilityPrGuarded = `\${{ github.event.repository.private && github.event_name != 'pull_request' && github.event_name != 'merge_group' && fromJSON('["self-hosted","two-selfhosted"]') || '${hosted}' }}`;
const publicGuard = `!github.event.repository.private && '["${hosted}"]'`;
const prGuard = `(github.event_name == 'pull_request' || github.event_name == 'merge_group') && '["${hosted}"]'`;
const overflowSwitch = (job: string) =>
  `\${{ fromJSON((${publicGuard}) || (${prGuard}) || (contains(fromJSON(vars.CI_OVERFLOW_JOBS || '[]'), '${job}') && contains(fromJSON(vars.CI_OVERFLOW_EVENTS || '[]'), github.event_name) && vars.CI_OVERFLOW_RUNNER) || '["self-hosted","two-selfhosted"]') }}`;

function jobs(text: string) {
  const body = text.slice(text.search(/^jobs:\n/m));
  const found: { id: string; runsOn: string | undefined; orgReusable: boolean; block: string }[] =
    [];
  for (const block of body.split(/^(?=  [A-Za-z0-9_-]+:\n)/m).slice(1)) {
    const id = block.match(/^  ([A-Za-z0-9_-]+):\n/)?.[1] ?? "";
    // A reusable-workflow call has no runner; the called workflow's jobs are checked.
    if (/^    uses: \.\/\.github\/workflows\/[\w.-]+\.ya?ml$/m.test(block)) continue;
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

  it("runs every job on GitHub-hosted Linux unless the repo is private", () => {
    for (const { name, text } of workflows) {
      for (const { id, runsOn, orgReusable } of jobs(text)) {
        if (orgReusable) continue;
        // Visual baselines render body text with the runner's system fonts, so
        // e2e.yml browser-smoke is deliberately pinned to ubuntu-24.04 and
        // re-baselined in the same PR on bumps (docs/visual-regression.md).
        // ubuntu-24.04 is still GitHub-hosted Linux, so the self-hosted
        // queue-forever risk does not apply.
        const allowed =
          name === "e2e.yml" && id === "browser-smoke"
            ? [hosted, "ubuntu-24.04", byVisibility, byVisibilityPrGuarded, overflowSwitch(id)]
            : [hosted, byVisibility, byVisibilityPrGuarded, overflowSwitch(id)];
        expect(allowed, `${name} job ${id}`).toContain(runsOn);
      }
    }
  });

  it("evaluates the public-repo guard before any CI_OVERFLOW_* variable", () => {
    let overflowJobs = 0;
    for (const { name, text } of workflows) {
      for (const { id, runsOn } of jobs(text)) {
        if (!runsOn?.includes("vars.CI_OVERFLOW_")) continue;
        overflowJobs += 1;
        const guard = runsOn.indexOf(publicGuard);
        const firstOverflowVar = runsOn.indexOf("vars.CI_OVERFLOW_");
        expect(guard, `${name} job ${id} has the public guard`).toBeGreaterThan(-1);
        expect(guard, `${name} job ${id} guards before reading the overflow vars`).toBeLessThan(
          firstOverflowVar,
        );
        expect(runsOn, `${name} job ${id} routes public repos only to ${hosted}`).toMatch(
          /^\$\{\{ fromJSON\(\(!github\.event\.repository\.private && '\["ubuntu-latest"\]'\) \|\| /,
        );
      }
    }
    expect(overflowJobs).toBeGreaterThan(0);
  });

  it("keeps self-hosted labels behind the repo-visibility check", () => {
    for (const { name, text } of workflows) {
      const ungated = text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line) && /self-hosted|two-selfhosted/.test(line))
        .filter((line) => !line.includes("github.event.repository.private && "));
      expect(ungated, name).toEqual([]);
    }
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

  it("keeps pull_request and merge_group runs off the self-hosted fleet", () => {
    const prWorkflows = workflows.filter(({ name, text }) => triggersOnPullRequest(name, text));
    // Non-vacuity: the four PR-triggered workflows whose jobs could otherwise
    // select the self-hosted fleet while private are all in scope.
    expect(prWorkflows.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "backup-bootstrap-selftest.yml",
        "ci.yml",
        "featured-offline-proof.yml",
        "pr-gates.yml",
      ]),
    );
    let guardedJobs = 0;
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
        const allowed =
          name === "e2e.yml" && id === "browser-smoke"
            ? [hosted, "ubuntu-24.04", byVisibilityPrGuarded, overflowSwitch(id)]
            : [hosted, byVisibilityPrGuarded, overflowSwitch(id)];
        expect(allowed, `${name} job ${id} keeps PR events hosted`).toContain(runsOn);
        if (runsOn.includes("self-hosted")) guardedJobs += 1;
        if (runsOn.includes("vars.CI_OVERFLOW_")) {
          const guard = runsOn.indexOf(prGuard);
          expect(guard, `${name} job ${id} has the PR guard`).toBeGreaterThan(-1);
          expect(guard, `${name} job ${id} guards before the overflow vars`).toBeLessThan(
            runsOn.indexOf("vars.CI_OVERFLOW_"),
          );
          expect(guard, `${name} job ${id} guards before the self-hosted label`).toBeLessThan(
            runsOn.indexOf("self-hosted"),
          );
        }
      }
    };
    for (const { name, text } of prWorkflows) {
      checkJobs(name, text);
      for (const call of text.matchAll(/uses: \.\/\.github\/workflows\/([\w.-]+\.ya?ml)/g)) {
        const target = workflows.find((w) => w.name === call[1]);
        expect(target, `${name} calls ${call[1]}`).toBeDefined();
        checkJobs(target!.name, target!.text);
      }
    }
    expect(guardedJobs).toBeGreaterThan(0);
  });
});
