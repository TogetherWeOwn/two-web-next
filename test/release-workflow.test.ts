import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Releases are cut by the production promote (docs/releases.md): no release PR,
// no schedule, no dispatched checks. deploy-production calls release.yml with
// the deployed SHA and ci/release-on-promote.cjs tags it.
const release = readFileSync(".github/workflows/release.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-production.yml", "utf8");
type ChangelogSection = { type: string; section?: string; hidden?: boolean };
const releasePleaseConfig = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
  packages: Record<
    string,
    {
      "bump-minor-pre-major"?: boolean;
      "release-as"?: string;
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
  it("keeps breaking changes on minor bumps before 1.0.0", () => {
    expect(releasePleaseConfig.packages["."]?.["bump-minor-pre-major"]).toBe(true);
  });

  it("cuts v1.0.0 at the production cutover promote", () => {
    expect(releasePleaseConfig.packages["."]?.["release-as"]).toBe("1.0.0");
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
    expect(tag).toContain("run: node ci/release-on-promote.cjs");
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

  it("passes the release-on-promote selftest", () => {
    const out = execFileSync("node", ["ci/release-on-promote.selftest.cjs"], { encoding: "utf8" });
    expect(out).toContain("all tests passed");
  });

  it("repairs a historical release without moving Latest backwards", () => {
    const out = execFileSync("node", ["ci/release-on-promote-latest.acceptance.cjs"], {
      encoding: "utf8",
    });
    expect(out).toContain("all tests passed");
  });
});
