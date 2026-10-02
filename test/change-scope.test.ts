import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ci/change-scope.sh decides whether the required `check` may fast-pass a PR
// (TOG-11811). Every doubt must resolve to docs_only=false.
const script = resolve("ci/change-scope.sh");
let repo: string;

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function scope(rows: string[][], expected = rows.length, cwd = repo) {
  const list = join(cwd, "..", `pr-files-${Math.random().toString(36).slice(2)}.tsv`);
  writeFileSync(list, rows.map((row) => `${row.join("\t")}\n`).join(""));
  // The ceiling keeps git from finding a repository above the fixture root.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) };
  const result = spawnSync("bash", [script, list, String(expected)], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

beforeEach(() => {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "change-scope-"),
  );
  repo = join(root, "repo");
  const files: Record<string, string> = {
    "README.md": "# readme\n",
    "docs/guide.md": "See docs/config.md.\n",
    "docs/config.md": "| KEY |\n",
    "ci/check-config-docs.mjs": 'readFileSync("docs/config.md")\n',
    "content/policy.md": "policy\n",
    "src/app.ts": "export {};\n",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git("init", "-q");
  git("add", ".");
});

afterEach(() => rmSync(dirname(repo), { recursive: true, force: true }));

describe("change-scope gate", () => {
  it("fast-passes prose that nothing reads", () => {
    expect(
      scope([
        ["docs/guide.md", ""],
        ["README.md", ""],
        ["docs/new.md", ""],
      ]).stdout,
    ).toBe("docs_only=true");
  });

  it("runs the suite for any code path", () => {
    expect(
      scope([
        ["docs/guide.md", ""],
        ["src/app.ts", ""],
      ]).stdout,
    ).toBe("docs_only=false");
  });

  it("counts the old name of a rename", () => {
    expect(scope([["docs/app.md", "src/app.ts"]]).stdout).toBe("docs_only=false");
  });

  it("treats a doc a gate reads as a gate input", () => {
    const result = scope([["docs/config.md", ""]]);
    expect(result.stdout).toBe("docs_only=false");
    expect(result.stderr).toContain("ci/check-config-docs.mjs");
  });

  it("keeps Markdown outside docs/ in the suite", () => {
    expect(scope([["content/policy.md", ""]]).stdout).toBe("docs_only=false");
  });

  it("fails closed on a truncated, empty or malformed list", () => {
    expect(scope([["docs/guide.md", ""]], 3001).stdout).toBe("docs_only=false");
    expect(scope([]).stdout).toBe("docs_only=false");
    expect(scope([["", ""]]).stdout).toBe("docs_only=false");
  });

  it("holds its verdict on large PRs (no SIGPIPE flip)", () => {
    const docs = Array.from({ length: 3000 }, (_, i) => [`docs/page-${i}.md`, ""]);
    expect(scope(docs).stdout).toBe("docs_only=true");
    expect(scope([...docs.slice(1), ["src/app.ts", ""]]).stdout).toBe("docs_only=false");
  });

  it("errors instead of passing when the tree cannot be searched", () => {
    const outside = mkdtempSync(join(dirname(repo), "not-a-repo-"));
    const result = scope([["docs/guide.md", ""]], 1, outside);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("check job", () => {
  it("guards every heavy step behind the scope verdict", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const check = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
    const steps = check.split("\n    steps:\n")[1]?.split(/\n      - /) ?? [];
    expect(steps.length).toBeGreaterThan(10);
    const unguarded = steps.filter(
      (step) =>
        !step.includes("Docs-only fast pass") &&
        !step.includes("needs.scope.outputs.docs_only != 'true'"),
    );
    expect(unguarded.map((step) => step.split("\n")[0])).toEqual([]);
  });
});
