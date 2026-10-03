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

describe("ci heavy-job scope gates", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobBlock = (id: string) =>
    ci.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

  it.each(["a11y", "lighthouse", "bundle-budget"])("%s still fast-passes docs-only PRs", (id) => {
    const block = jobBlock(id);
    // lighthouse and bundle-budget put needs: first (no name: line above it).
    expect(block).toMatch(/(^|\n)    needs: scope\n/);
    expect(block).toMatch(/\n    if: needs\.scope\.outputs\.docs_only != 'true'\n/);
  });

  it("check still runs on every verdict and gates on the audit result", () => {
    const block = jobBlock("check");
    expect(block).toMatch(/\n    needs: \[a11y, lighthouse, bundle-budget, scope\]\n/);
    expect(block).toMatch(/\n    if: always\(\)\n/);
  });
});

describe("e2e scope gate", () => {
  const e2e = readFileSync(".github/workflows/e2e.yml", "utf8");
  const scopeJob = e2e.split("\n  scope:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  const smoke = e2e.split("\n  browser-smoke:\n")[1] ?? "";

  it("mirrors the ci.yml docs-only gate instead of running unscoped", () => {
    expect(scopeJob).toContain("bash ci/change-scope.sh");
    expect(scopeJob).toContain("docs_only:");
    expect(scopeJob).toContain("repos/$REPO/pulls/$PR_NUMBER/files");
    expect(smoke).toMatch(/\n    needs: scope\n/);
    expect(smoke).toMatch(/\n    if: needs\.scope\.outputs\.docs_only != 'true'\n/);
  });

  it("keeps the pull_request trigger unfiltered so the workflow always reports", () => {
    const trigger = e2e.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
    const prBlock = trigger.match(/(?:^|\n)  pull_request:[^\n]*((?:\n {4,}[^\n]*)*)/)?.[1] ?? "";
    expect(trigger).toMatch(/(^|\n)  pull_request:/);
    expect(prBlock).not.toMatch(/\b(paths|paths-ignore|branches|branches-ignore):/);
  });

  it("stays on standard hosted runners and skips only the smoke, never a required check", () => {
    expect(smoke).toMatch(/\n    runs-on: ubuntu-latest\n/);
    // browser-smoke is not a required check: CONTRIBUTING names exactly
    // check, gitleaks and pr-lint, so a docs-only skip never blocks a merge.
    const section =
      readFileSync("CONTRIBUTING.md", "utf8")
        .split("### Branch protection and required checks")[1]
        ?.split(/\n#{2,3} /)[0] ?? "";
    expect(section).not.toContain("browser-smoke");
  });
});

describe("changed-path fixture matrix", () => {
  it("fast-passes docs-only PRs", () => {
    expect(
      scope([
        ["docs/guide.md", ""],
        ["README.md", ""],
      ]).stdout,
    ).toBe("docs_only=true");
  });

  it("runs the full suite for code PRs", () => {
    expect(
      scope([
        ["docs/guide.md", ""],
        ["src/app.ts", ""],
      ]).stdout,
    ).toBe("docs_only=false");
  });

  // Island sources, built outputs, stylesheets, fonts, icons and the manifest
  // are executed or asserted by the suite (binder tests, bundle-budget drift,
  // a11y resource errors, e2e clicks), so asset-only PRs must run everything.
  const assetOnly = [
    "assets/islands/rsvp-button.js",
    "assets/styles.css",
    "public/islands/rsvp-button.js",
    "public/styles.css",
    "public/event-theme.css",
    "public/fonts/display-latin-700.woff2",
    "public/icons/icon-192.png",
    "public/site.webmanifest",
    "public/logo.svg",
    "public/favicon.ico",
    "src/islands/contracts.ts",
  ];
  it.each(assetOnly.map((path) => [path] as [string]))(
    "runs the full suite for island-asset path %s",
    (path) => {
      expect(scope([[path, ""]]).stdout).toBe("docs_only=false");
    },
  );

  it("counts an asset source renamed into docs/ as code", () => {
    expect(scope([["docs/rsvp-button.md", "assets/islands/rsvp-button.js"]]).stdout).toBe(
      "docs_only=false",
    );
  });
});
