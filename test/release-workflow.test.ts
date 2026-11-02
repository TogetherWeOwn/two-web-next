import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Releases are cut by the production promote (docs/releases.md): no release PR,
// no schedule, no dispatched checks. deploy-production calls release.yml with
// the deployed SHA; ci/release-request.cjs proves the promotion and the shared
// CalVer releaser tags it vYYYY.MDD.P.
const require = createRequire(import.meta.url);
const { buildRequest, loadSections } = require("../ci/release-request.cjs") as {
  buildRequest: (args: {
    sha: string;
    receipt: { run_id: string; run_attempt: string };
    artifact: { id: number; name: string; digest: string };
    sections: ChangelogSection[];
  }) => { phase: string; input: Record<string, unknown> };
  loadSections: (file: string) => ChangelogSection[];
};
const release = readFileSync(".github/workflows/release.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-production.yml", "utf8");
type ChangelogSection = { type: string; section?: string; hidden?: boolean };
const releasePleaseConfig = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
  packages: Record<
    string,
    Record<string, unknown> & {
      "changelog-sections"?: ChangelogSection[];
    }
  >;
};
const changelog = readFileSync("CHANGELOG.md", "utf8");
const header = release.slice(0, release.search(/^permissions:/m));
const changelogSections = releasePleaseConfig.packages["."]?.["changelog-sections"] ?? [];

function prTitleTypes(path: string) {
  const types = readFileSync(path, "utf8").match(/^TYPES = "([^"]+)"/m)?.[1];
  if (!types) throw new Error(`no TYPES list in ${path}`);
  return types.split("|");
}

function job(text: string, id: string) {
  const body = text.slice(text.search(/^jobs:\n/m));
  const match = body.match(
    new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  expect(match, `job ${id}`).not.toBeNull();
  return match?.[1] ?? "";
}

function jobPermissions(text: string) {
  // Read the whole map, including entries after comments or blank lines.
  const blocks = [...text.matchAll(/^ {4}permissions:\n([\s\S]*?)(?=^ {4}[\w-]+:|(?![\s\S]))/gm)];
  expect(blocks, "one job-local permissions map").toHaveLength(1);
  const body = blocks[0]?.[1];
  if (body === undefined) throw new Error("missing job-local permissions map");
  return body
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

describe("release on promote", () => {
  it("keeps only the notes sections from the release-please config", () => {
    // CalVer comes from tag history: no release-as, bump rules or release type.
    expect(Object.keys(releasePleaseConfig.packages["."] ?? {})).toEqual(["changelog-sections"]);
  });

  it("gives every allowed PR-title type a visible changelog section or hides it", () => {
    for (const path of ["ci/check-pr-conventions.py", ".github/scripts/pr_standards.py"]) {
      for (const type of prTitleTypes(path)) {
        const entry = changelogSections.find((s) => s.type === type);
        const hidden = entry?.hidden === true;
        const visible = Boolean(entry?.section) && !hidden;
        expect(hidden || visible, `${type} in ${path} is neither visible nor hidden`).toBe(true);
      }
    }
  });

  it("files security fixes under the Fixed section", () => {
    expect(changelogSections).toContainEqual({ type: "security", section: "Fixed" });
  });

  it("has no hand-written Unreleased heading above the first released section", () => {
    const firstReleaseHeading = changelog.search(/^## \[/m);
    const unreleasedHeading = changelog.search(/^## Unreleased\s*$/m);
    expect(firstReleaseHeading).toBeGreaterThanOrEqual(0);
    expect(unreleasedHeading === -1 || unreleasedHeading > firstReleaseHeading).toBe(true);
  });

  it("runs only when called by deploy-production or dispatched for a SHA", () => {
    expect(header).toMatch(/^on:\n {2}workflow_call:\n/m);
    expect(header).toContain("\n  workflow_dispatch:\n");
    for (const trigger of ["push:", "schedule:", "pull_request"]) {
      expect(header).not.toContain(trigger);
    }
    expect(release).not.toContain("release-please-action");
    expect(release).not.toContain("gh workflow run");
  });

  it("scopes the write token to the tag job and serializes releases", () => {
    expect(release).toMatch(/^permissions: \{\}\n/m);
    const tag = job(release, "tag");
    expect(jobPermissions(tag)).toEqual(["actions: read", "contents: write"]);
    expect(tag).toMatch(/^ {4}concurrency:\n {6}group: release\n {6}cancel-in-progress: false\n/m);
    expect(tag).toContain("fetch-depth: 0");
    expect(tag).toContain("RELEASE_SHA: ${{ inputs.sha }}");
    expect(tag).toContain("run: node ci/release-request.cjs");
  });

  it("plans and publishes with the shared releaser pinned to one full SHA", () => {
    const tag = job(release, "tag");
    const pins = [...tag.matchAll(/uses: TogetherWeOwn\/\.github\/actions\/calver@(\S+)/g)].map(
      (m) => m[1],
    );
    // Plan, publish, and their one in-job retry each: every invocation pins
    // the same reviewed releaser commit.
    expect(pins).toHaveLength(4);
    expect(pins[0]).toMatch(/^[0-9a-f]{40}$/);
    for (const pin of pins) expect(pin).toBe(pins[0]);
    // Plan before publish, and a classified skip (re-promote, rollback) never publishes.
    expect(tag.indexOf("id: plan")).toBeGreaterThan(
      tag.indexOf("run: node ci/release-request.cjs"),
    );
    const build = tag.slice(tag.indexOf("- name: Build the publish request"));
    expect(build).toContain("steps.planned.outputs.skipped != 'true'");
    expect(tag).toContain("'\"ubuntu-latest\"'");
  });

  it("retries a failed plan or publish once inside the same job attempt", () => {
    const tag = job(release, "tag");
    // The proof binds the producing attempt, so a rerun can never recover a
    // transient releaser failure; the retry has to live in this attempt and
    // fire only on the first attempt's failure, never on a skip or a success.
    const planRetry = tag.slice(tag.indexOf("- name: Plan the CalVer release (retry)"));
    expect(planRetry).toContain("if: ${{ !cancelled() && steps.plan.outcome == 'failure' }}");
    expect(planRetry).toContain("request: ${{ steps.request.outputs.request }}");
    // Downstream steps select whichever plan succeeded and must not fall back
    // to the implicit success() gate a failed first attempt would trip.
    const planned = tag.slice(tag.indexOf("- name: Select the planned release"));
    expect(planned).toContain("!cancelled()");
    expect(planned).toContain("steps.plan-retry.outputs.plan");
    const retryBuild = tag.slice(tag.indexOf("- name: Build the publish retry request"));
    expect(retryBuild).toContain("if: ${{ !cancelled() && steps.publish.outcome == 'failure' }}");
    // The publish retry completes its own frozen plan in repair mode so a
    // tag created before the failure still gets its Release; a dry run never
    // wrote, so it keeps the caller's repair flag instead.
    expect(retryBuild).toContain('repair: process.env.REPAIR === "true" || !dryRun');
    const publishRetry = tag.slice(
      tag.indexOf("- name: Tag the deployed commit and publish its release (retry)"),
    );
    expect(publishRetry).toContain("steps.publish-retry-request.outcome == 'success'");
    expect(publishRetry).toContain("request: ${{ steps.publish-retry-request.outputs.request }}");
    // First attempts are continue-on-error so a successful retry keeps the
    // job green; the gate step fails the job when both plan attempts failed,
    // and the publish retry carries no continue-on-error, so its own failure
    // still fails the job.
    expect(tag.match(/continue-on-error: true/g)).toHaveLength(2);
    const gate = tag.slice(tag.indexOf("- name: Refuse when no CalVer plan succeeded"));
    expect(gate).toContain("steps.plan-retry.outcome != 'success'");
    expect(publishRetry).not.toContain("continue-on-error");
    // A classified skip is a successful plan with skipped=true: publish and
    // its retry stay off because only an outcome failure arms the retry.
    const publish = tag.slice(tag.indexOf("- name: Tag the deployed commit"));
    expect(publish).toContain("id: publish");
    expect(publish).toContain("steps.publish-request.outcome == 'success'");
  });

  it("asks the releaser for a canary-free production-promotion stable with the notes sections", () => {
    const sha = "a".repeat(40);
    const artifact = {
      id: 800,
      name: `production-promotion-${sha}-700-2`,
      digest: `sha256:${"d".repeat(64)}`,
    };
    const sections = loadSections("release-please-config.json");
    expect(sections).toEqual(
      changelogSections.map(({ type, section, hidden }) =>
        hidden ? { type, section, hidden: true } : { type, section },
      ),
    );
    const request = buildRequest({
      sha,
      receipt: { run_id: "700", run_attempt: "2" },
      artifact,
      sections,
    });
    expect(request).toEqual({
      phase: "plan",
      input: {
        channel: "stable",
        sha,
        operation: "production-700-2",
        policy: "production-promotion",
        evidence: {
          runId: 700,
          attempt: 2,
          workflow: ".github/workflows/deploy-production.yml",
          jobs: ["deploy-production"],
          artifactId: 800,
          artifactName: artifact.name,
          artifactDigest: artifact.digest,
        },
        sections,
      },
    });
  });

  it("is called after a successful production deploy with the deployed SHA", () => {
    const call = job(deploy, "release");
    expect(call).toContain("needs: [preflight, deploy-production]");
    expect(call).toContain("uses: ./.github/workflows/release.yml");
    // The promoted commit (DEPLOY_SHA from ci/resolve-promotion-sha.mjs), never main's tip.
    expect(call).toContain("sha: ${{ needs.preflight.outputs.sha }}");
    expect(call).not.toContain("github.sha");
    expect(deploy).toMatch(/^ {6}sha: \$\{\{ steps\.target\.outputs\.sha \}\}$/m);
    expect(jobPermissions(call)).toEqual(["actions: read", "contents: write"]);
  });
});
