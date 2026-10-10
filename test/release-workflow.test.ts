import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Releases are cut by the production promote (docs/releases.md): no release PR,
// no schedule, no dispatched checks. deploy-production calls release.yml with
// the deployed SHA and ci/release-on-promote.cjs tags it.
const release = readFileSync(".github/workflows/release.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const releasePleaseConfig = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
  packages: Record<string, { "bump-minor-pre-major"?: boolean; "release-as"?: string }>;
};
const changelog = readFileSync("CHANGELOG.md", "utf8");
const header = release.slice(0, release.search(/^permissions:/m));

function job(text: string, id: string) {
  const body = text.slice(text.search(/^jobs:\n/m));
  const match = body.match(
    new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  expect(match, `job ${id}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("release on promote", () => {
  it("keeps breaking changes on minor bumps before 1.0.0", () => {
    expect(releasePleaseConfig.packages["."]?.["bump-minor-pre-major"]).toBe(true);
  });

  it("cuts v1.0.0 at the production cutover promote", () => {
    expect(releasePleaseConfig.packages["."]?.["release-as"]).toBe("1.0.0");
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
    expect(tag).toMatch(/^ {4}permissions:\n {6}contents: write[^\n]*\n(?! {6})/m);
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
    expect(call).toMatch(/^ {4}permissions:\n {6}contents: write[^\n]*\n(?! {6})/m);
  });

  it("passes the release-on-promote selftest", () => {
    const out = execFileSync("node", ["ci/release-on-promote.selftest.cjs"], { encoding: "utf8" });
    expect(out).toContain("all tests passed");
  });
});
