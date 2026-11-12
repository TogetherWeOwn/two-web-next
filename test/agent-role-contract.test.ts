import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const role = (name: string) =>
  readFileSync(new URL(`../.claude/agents/${name}.md`, import.meta.url), "utf8");

const metadata = (source: string, key: string) => {
  const frontmatter = source.replace(/\r\n/g, "\n").split("---\n")[1];
  return frontmatter
    ?.split("\n")
    .find((line) => line.startsWith(`${key}: `))
    ?.slice(key.length + 2);
};

describe("repository delegation contract", () => {
  it.each(["\n", "\r\n"])("reads metadata with %j line endings", (newline) => {
    const source = ["---", "model: gpt-6.1-sol", "tools: Read, Grep", "---", "Body"].join(newline);
    expect(metadata(source, "model")).toBe("gpt-6.1-sol");
    expect(metadata(source, "tools")).toBe("Read, Grep");
  });

  it("retains the configured model routes and tool lists", () => {
    const builder = role("builder");
    const reviewer = role("cross-reviewer");
    expect(metadata(builder, "model")).toBe("claude/claude-sonnet-5-5");
    expect(metadata(builder, "tools")).toBe("Read, Grep, Glob, Bash, Edit, Write");
    expect(metadata(reviewer, "model")).toBe("gpt-6.1-sol");
    expect(metadata(reviewer, "tools")).toBe("Read, Grep, Glob, Bash");
  });

  it("requires independent concurrent assessment and evidence without test execution", () => {
    const reviewer = role("cross-reviewer");
    expect(metadata(reviewer, "description")).toContain(
      "Start alongside the primary assessment on the same pinned head",
    );
    for (const requirement of [
      "until both assessments have recorded independent findings",
      "reconcile afterwards, before decisions",
      "A changed head needs applicable revalidation",
      "Do not run tests, builds, installs",
      "concrete input/state/sequence and wrong outcome",
      "evidence establishing it",
      "not a security boundary",
    ]) {
      expect(reviewer).toContain(requirement);
    }
    expect(reviewer).not.toContain("Use after the main-thread review");
    expect(reviewer).not.toContain("running existing tests");
  });

  it("allows substantial qualified work while retaining integration and authority limits", () => {
    const builder = role("builder");
    expect(metadata(builder, "description")).toContain(
      "including substantial implementation, testing, docs and refactoring",
    );
    for (const requirement of [
      "within your actual qualification and authorization",
      "Keep small cohesive work together",
      "within verified native, provider, tool, host and approved-budget capacity",
      "assigned native task-owned isolated workspace",
      "Architecture, primary review and specialist decisions remain with qualified authorized workers",
      "Do not perform design work or exercise Security or Release Manager authority",
      "Full suites and CI gates run only on GitHub Actions for the exact head",
      "Never commit, push, open PRs or change Paperclip issues",
      "caller does that and remains the accountable integrator",
    ]) {
      expect(builder).toContain(requirement);
    }
    expect(builder).not.toContain("the main thread keeps those");
  });

  it("does not turn role wording into runtime qualification or experimental activation", () => {
    for (const name of ["builder", "cross-reviewer"]) {
      const source = role(name);
      expect(source).toContain("Agent model overrides");
      expect(source).toContain("metadata");
      expect(source).toContain("NO-GO holds remain");
    }
  });
});
