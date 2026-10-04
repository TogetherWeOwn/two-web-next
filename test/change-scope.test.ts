import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ci/change-scope.sh decides whether the required `check` may fast-pass a PR
// (TOG-11811) and whether the browser/staging smoke may skip it. Every doubt
// must resolve to docs_only=false and skip_e2e=false. The script prints one
// `docs_only=<bool>` line and one `skip_e2e=<bool>` line.
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
  const lines = result.stdout.trim().split("\n");
  const verdict = (key: string) =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    docsOnly: verdict("docs_only"),
    skipE2e: verdict("skip_e2e"),
    app: verdict("app"),
    worker: verdict("worker"),
    db: verdict("db"),
    full: verdict("full"),
    draft: verdict("draft"),
  };
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
    "test/app.test.ts": 'import { it } from "vitest";\n',
    "test/helpers/fixture.ts": "export {};\n",
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
    const result = scope([
      ["docs/guide.md", ""],
      ["README.md", ""],
      ["docs/new.md", ""],
    ]);
    expect(result.docsOnly).toBe("true");
    expect(result.skipE2e).toBe("true");
  });

  it("runs the suite for any code path", () => {
    const result = scope([
      ["docs/guide.md", ""],
      ["src/app.ts", ""],
    ]);
    expect(result.docsOnly).toBe("false");
    expect(result.skipE2e).toBe("false");
  });

  it("emits per-area verdicts for heavy-job gating", () => {
    const verdict = (rows: string[][]) => {
      const r = scope(rows);
      return { app: r.app, worker: r.worker, db: r.db, full: r.full, draft: r.draft };
    };
    expect(verdict([["src/app.ts", ""]])).toEqual({
      app: "true",
      worker: "false",
      db: "false",
      full: "false",
      draft: "false",
    });
    expect(
      verdict([
        ["wrangler.jsonc", ""],
        ["tail/worker.ts", ""],
      ]),
    ).toEqual({
      app: "false",
      worker: "true",
      db: "false",
      full: "false",
      draft: "false",
    });
    expect(verdict([["web/src/lib/Shell.svelte", ""]])).toEqual({
      app: "false",
      worker: "true",
      db: "false",
      full: "false",
      draft: "false",
    });
    expect(verdict([["drizzle/0001_init.sql", ""]])).toEqual({
      app: "false",
      worker: "false",
      db: "true",
      full: "false",
      draft: "false",
    });
    expect(
      verdict([
        ["docs/guide.md", ""],
        ["README.md", ""],
      ]),
    ).toEqual({
      app: "false",
      worker: "false",
      db: "false",
      full: "false",
      draft: "false",
    });
  });

  it("maps migration tooling under ci/ to db, not app", () => {
    for (const path of [
      "ci/check-migration-history.mjs",
      "ci/check-migration-history-selftest.mjs",
      "ci/check-migration-numbers.sh",
      "ci/neon-migrate.mjs",
      "ci/neon-migrate-selftest.mjs",
    ]) {
      const r = scope([[path, ""]]);
      expect({ app: r.app, db: r.db, full: r.full }, path).toEqual({
        app: "false",
        db: "true",
        full: "false",
      });
    }
    // Other ci/ tooling is still an app input.
    const other = scope([["ci/neon-backup-selftest.sh", ""]]);
    expect({ app: other.app, db: other.db }).toEqual({ app: "true", db: "false" });
  });

  it("forces a full run on lockfiles, CI, shared config and itself", () => {
    for (const path of [
      "package-lock.json",
      "web/package-lock.json",
      "package.json",
      "biome.json",
      "tsconfig.json",
      "vitest.config.ts",
      ".github/workflows/ci.yml",
      "ci/change-scope.sh",
    ]) {
      expect(scope([[path, ""]]).full, path).toBe("true");
    }
  });

  it("fails unknown paths closed to a full run", () => {
    expect(scope([["some-new-top-level-file", ""]]).full).toBe("true");
  });

  it("mirrors the draft flag without inferring it", () => {
    const prev = process.env.DRAFT;
    try {
      process.env.DRAFT = "true";
      const r = scope([["src/app.ts", ""]]);
      expect(r.draft).toBe("true");
      expect(r.app).toBe("true");
    } finally {
      if (prev === undefined) delete process.env.DRAFT;
      else process.env.DRAFT = prev;
    }
    expect(scope([["src/app.ts", ""]]).draft).toBe("false");
  });

  it("counts the old name of a rename", () => {
    expect(scope([["docs/app.md", "src/app.ts"]]).docsOnly).toBe("false");
  });

  it("treats a doc a gate reads as a gate input", () => {
    const result = scope([["docs/config.md", ""]]);
    expect(result.docsOnly).toBe("false");
    expect(result.stderr).toContain("ci/check-config-docs.mjs");
  });

  it("keeps Markdown outside docs/ in the suite", () => {
    expect(scope([["content/policy.md", ""]]).docsOnly).toBe("false");
  });

  it("fails closed on a truncated, empty or malformed list", () => {
    expect(scope([["docs/guide.md", ""]], 3001).docsOnly).toBe("false");
    expect(scope([]).docsOnly).toBe("false");
    expect(scope([["", ""]]).docsOnly).toBe("false");
    expect(scope([["test/app.test.ts", ""]], 3001).skipE2e).toBe("false");
    expect(scope([]).skipE2e).toBe("false");
    expect(scope([["", ""]]).skipE2e).toBe("false");
  });

  it("holds its verdict on large PRs (no SIGPIPE flip)", () => {
    const docs = Array.from({ length: 3000 }, (_, i) => [`docs/page-${i}.md`, ""]);
    expect(scope(docs).docsOnly).toBe("true");
    expect(scope([...docs.slice(1), ["src/app.ts", ""]]).docsOnly).toBe("false");
  });

  it("errors instead of passing when the tree cannot be searched", () => {
    const outside = mkdtempSync(join(dirname(repo), "not-a-repo-"));
    const result = scope([["docs/guide.md", ""]], 1, outside);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("skip_e2e verdict", () => {
  it("skips the smoke for test-only changes the journeys never execute", () => {
    const result = scope([
      ["test/app.test.ts", ""],
      ["test/helpers/fixture.ts", ""],
    ]);
    // Unit tests still run the required check: docs_only stays false.
    expect(result.docsOnly).toBe("false");
    expect(result.skipE2e).toBe("true");
  });

  it("skips the smoke for mixed docs and test changes", () => {
    const result = scope([
      ["docs/guide.md", ""],
      ["test/app.test.ts", ""],
      ["README.md", ""],
    ]);
    expect(result.skipE2e).toBe("true");
  });

  it("skips the smoke for a doc a gate reads: an input to check, not to journeys", () => {
    const result = scope([["docs/config.md", ""]]);
    expect(result.docsOnly).toBe("false");
    expect(result.skipE2e).toBe("true");
  });

  it("runs the smoke when a test change meets any web-affecting path", () => {
    for (const path of [
      "src/app.ts",
      "assets/islands/rsvp-button.js",
      "public/styles.css",
      "content/policy.md",
      "e2e/admin.spec.ts",
      "wrangler.jsonc",
      "bin/smoke.mjs",
      "ci/check-config-docs.mjs",
      "drizzle/0001_init.sql",
      "package.json",
      "vitest.config.ts",
    ]) {
      expect(
        scope([
          ["test/app.test.ts", ""],
          [path, ""],
        ]).skipE2e,
        path,
      ).toBe("false");
    }
  });

  it("counts both names of a rename for the smoke verdict", () => {
    // A journey moved into test/ is still observed through its old name.
    expect(scope([["test/journey.ts", "e2e/journey.ts"]]).skipE2e).toBe("false");
    // Code moved out of test/ starts being observed through its new name.
    expect(scope([["src/journey.ts", "test/journey.ts"]]).skipE2e).toBe("false");
    // Prose renamed inside docs/ or into the unit tree skips.
    expect(scope([["docs/renamed.md", "docs/guide.md"]]).skipE2e).toBe("true");
    expect(scope([["test/renamed.test.ts", "test/app.test.ts"]]).skipE2e).toBe("true");
  });

  it("fails the smoke verdict closed on a truncated list", () => {
    const docs = Array.from({ length: 3000 }, (_, i) => [`docs/page-${i}.md`, ""]);
    expect(scope(docs).skipE2e).toBe("true");
    expect(scope(docs, 3001).skipE2e).toBe("false");
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
        // The scope guard is deliberately unconditional: pinned below.
        !step.includes("Require successful scope") &&
        !step.includes("needs.scope.outputs.docs_only != 'true'"),
    );
    expect(unguarded.map((step) => step.split("\n")[0])).toEqual([]);
  });
});

describe("ci heavy-job scope gates", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobBlock = (id: string) =>
    ci.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

  it("a11y runs on app or db inputs, never on drafts", () => {
    const block = jobBlock("a11y");
    expect(block).toMatch(/(^|\n)    needs: scope\n/);
    expect(block).toContain("needs.scope.outputs.draft != 'true'");
    expect(block).toContain("needs.scope.outputs.app == 'true'");
    expect(block).toContain("needs.scope.outputs.db == 'true'");
  });

  it.each(["lighthouse", "bundle-budget"])("%s runs on app inputs, never on drafts", (id) => {
    const block = jobBlock(id);
    // lighthouse and bundle-budget put needs: first (no name: line above it).
    expect(block).toMatch(/(^|\n)    needs: scope\n/);
    expect(block).toContain("needs.scope.outputs.draft != 'true'");
    expect(block).toContain("needs.scope.outputs.app == 'true'");
  });

  it("check still runs on every verdict and gates on the audit result", () => {
    const block = jobBlock("check");
    expect(block).toMatch(/\n    needs: \[a11y, lighthouse, bundle-budget, scope\]\n/);
    expect(block).toMatch(/\n    if: always\(\)\n/);
  });

  it("ci-ok aggregates every gated job and fails closed on scope", () => {
    const block = jobBlock("ci-ok");
    expect(block).toMatch(/\n    needs: \[a11y, lighthouse, bundle-budget, check, scope\]\n/);
    expect(block).toMatch(/\n    if: always\(\)\n/);
    expect(block).toContain("SCOPE_RESULT: ${{ needs.scope.result }}");
    expect(block).toContain("CHECK_RESULT: ${{ needs.check.result }}");
  });

  it("check fails when scope did not succeed, as its first and unconditional step", () => {
    const steps = jobBlock("check").split("\n    steps:\n")[1] ?? "";
    // No `if:` between the step name and its env: it runs on every verdict.
    const guard = steps.match(
      /^      - name: Require successful scope\n        env:\n          SCOPE_RESULT: \$\{\{ needs\.scope\.result \}\}\n        run: ([^\n]+)\n/,
    )?.[1];
    expect(guard, "scope guard must be check's first, unconditional step").toBeDefined();
    // `scope` is not a required check: a red scope must not leave `check` green.
    for (const [result, expected] of [
      ["success", 0],
      ["failure", 1],
      ["cancelled", 1],
      ["skipped", 1],
      ["", 1],
    ] as const) {
      const run = spawnSync("bash", ["-c", guard ?? "exit 99"], {
        env: { SCOPE_RESULT: result },
        encoding: "utf8",
      });
      expect(run.status, `scope result ${result || "missing"}`).toBe(expected);
    }
  });

  it("ci-ok rejects scope outputs that are not exactly true or false", () => {
    const body = jobBlock("ci-ok").split("\n        run: |\n")[1] ?? "";
    const script = body
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
    const ok: Record<string, string> = {
      SCOPE_RESULT: "success",
      FULL: "false",
      APP: "false",
      WORKER: "false",
      DB: "false",
      DRAFT: "false",
      CHECK_RESULT: "success",
      A11Y_RESULT: "skipped",
      LIGHTHOUSE_RESULT: "skipped",
      BUDGET_RESULT: "skipped",
    };
    const status = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", script], { env, encoding: "utf8" }).status;
    expect(status(ok)).toBe(0);
    for (const key of ["FULL", "APP", "WORKER", "DB", "DRAFT"]) {
      expect(status({ ...ok, [key]: "" }), `${key} empty`).toBe(1);
      expect(status({ ...ok, [key]: "maybe" }), `${key} not a boolean`).toBe(1);
    }
    expect(status({ ...ok, SCOPE_RESULT: "failure" })).toBe(1);
    // A selected area whose job was skipped must not read green.
    expect(status({ ...ok, APP: "true" })).toBe(1);
  });

  it("every check step respects the draft flag", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const check = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
    const steps = check.split("\n    steps:\n")[1]?.split(/\n      - /) ?? [];
    const heavyIfs = steps
      .filter((step) => !step.includes("Docs-only fast pass"))
      .flatMap((step) => step.split("\n").filter((line) => /^        if:/.test(line)));
    expect(heavyIfs.length).toBeGreaterThan(10);
    for (const line of heavyIfs) {
      expect(line).toContain("needs.scope.outputs.draft != 'true'");
    }
  });
});

describe("e2e scope gate", () => {
  const e2e = readFileSync(".github/workflows/e2e.yml", "utf8");
  const scopeJob = e2e.split("\n  scope:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  const smoke = e2e.split("\n  browser-smoke:\n")[1] ?? "";

  it("mirrors the ci.yml docs-only gate instead of running unscoped", () => {
    expect(scopeJob).toContain("bash ci/change-scope.sh");
    expect(scopeJob).toContain("docs_only:");
    expect(scopeJob).toContain("skip_e2e:");
    expect(scopeJob).toContain("repos/$REPO/pulls/$PR_NUMBER/files");
    expect(smoke).toMatch(/\n    needs: scope\n/);
    expect(smoke).toContain("needs.scope.outputs.skip_e2e != 'true'");
  });

  it("keeps the pull_request trigger unfiltered so the workflow always reports", () => {
    const trigger = e2e.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
    const prBlock = trigger.match(/(?:^|\n)  pull_request:[^\n]*((?:\n {4,}[^\n]*)*)/)?.[1] ?? "";
    expect(trigger).toMatch(/(^|\n)  pull_request:/);
    expect(prBlock).not.toMatch(/\b(paths|paths-ignore|branches|branches-ignore):/);
    // Drafts skip the smoke; undrafting re-runs via ready_for_review.
    expect(smoke).toContain("github.event.pull_request.draft != true");
    expect(trigger).toMatch(/(^|\n)  schedule:\n/);
  });

  it("stays on standard hosted runners and skips only the smoke, never a required check", () => {
    expect(smoke).toMatch(/\n    runs-on: ubuntu-latest\n/);
    // browser-smoke is not a required check: CONTRIBUTING names exactly
    // check, gitleaks and pr-lint, so a docs-only or test-only skip never
    // blocks a merge.
    const section =
      readFileSync("CONTRIBUTING.md", "utf8")
        .split("### Branch protection and required checks")[1]
        ?.split(/\n#{2,3} /)[0] ?? "";
    expect(section).not.toContain("browser-smoke");
  });
});

describe("e2e-staging scope gate", () => {
  const staging = readFileSync(".github/workflows/e2e-staging.yml", "utf8");
  const scopeJob = staging.split("\n  scope:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  const journeys = staging.split("\n  staging-journeys:\n")[1] ?? "";

  it("mirrors the e2e.yml docs-only gate without PR context", () => {
    // No PR files API here: workflow_run + workflow_dispatch carry no pull
    // request, so the scope job diffs the deployed head SHA against its
    // parent and feeds ci/change-scope.sh the same TSV shape.
    expect(scopeJob).toContain("bash ci/change-scope.sh");
    expect(scopeJob).toContain("docs_only:");
    expect(scopeJob).toContain("skip_e2e:");
    expect(scopeJob).not.toContain("pulls/$PR_NUMBER/files");
    expect(scopeJob).toContain("workflow_run.head_sha");
    expect(scopeJob).toContain("git diff --name-status");
    expect(journeys).toMatch(/\n    needs: scope\n/);
    expect(journeys).toMatch(/needs\.scope\.outputs\.skip_e2e != 'true'/);
  });

  it("keeps the deploy trigger intact and dispatches always running", () => {
    expect(staging).toMatch(/(^|\n)  workflow_run:\n/);
    expect(staging).toMatch(/(^|\n)  workflow_dispatch:\n/);
    expect(scopeJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(scopeJob).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(journeys).toContain("github.event_name == 'workflow_dispatch'");
  });

  it("stays on standard hosted runners and gates no required check", () => {
    expect(scopeJob).toMatch(/\n    runs-on: ubuntu-latest\n/);
    expect(journeys).toMatch(/\n    runs-on: ubuntu-latest\n/);
    // staging-journeys is post-deploy evidence, not a merge gate: CONTRIBUTING
    // names exactly check, gitleaks and pr-lint, so a docs-only or test-only
    // skip never blocks a merge.
    const section =
      readFileSync("CONTRIBUTING.md", "utf8")
        .split("### Branch protection and required checks")[1]
        ?.split(/\n#{2,3} /)[0] ?? "";
    expect(section).not.toContain("staging-journeys");
  });
});

describe("deploy post-deploy smoke scope", () => {
  const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
  const scopeStep =
    deploy.match(
      /      - name: Scope post-deploy smoke to web-affecting changes\n(?:        .*\n|          .*\n)+/,
    )?.[0] ?? "";
  const publicSmoke = deploy.split("      - name: Smoke test staging public routes\n")[1] ?? "";
  const jsonSmoke = deploy.split("      - name: Smoke test staging event JSON contract\n")[1] ?? "";

  it("scopes both smoke steps to web-affecting deploys without PR context", () => {
    // The job checks out the deployed SHA, so the scope step diffs HEAD
    // against its parent in the e2e-staging TSV shape; a deploy with no
    // parent fails closed and runs the smoke instead of failing the deploy.
    expect(deploy).toContain("fetch-depth: 2");
    expect(scopeStep).toContain('git rev-parse --verify --quiet "HEAD~1"');
    expect(scopeStep).toContain("bash ci/change-scope.sh");
    expect(scopeStep).toContain("git diff --name-status");
    expect(scopeStep).toContain("id: smoke-scope");
    expect(publicSmoke).toMatch(/^        if: steps\.smoke-scope\.outputs\.skip_e2e != 'true'$/m);
    expect(jsonSmoke).toMatch(/^        if: steps\.smoke-scope\.outputs\.skip_e2e != 'true'$/m);
  });

  it("keeps the deploy itself and its gates unscoped", () => {
    // The scope step sits after the Cloudflare mutations, and nothing gates
    // the deploy steps or the staging-deploy-gate re-verifications on it.
    const scopeIndex = deploy.indexOf("Scope post-deploy smoke");
    const deployIndex = deploy.indexOf("Deploy to Cloudflare Workers");
    expect(scopeIndex).toBeGreaterThan(deployIndex);
    expect(deploy).not.toMatch(/needs\.smoke-scope/);
    expect(deploy.match(/node ci\/staging-deploy-gate\.mjs/g)?.length).toBeGreaterThan(1);
  });
});

describe("changed-path fixture matrix", () => {
  it("fast-passes docs-only PRs", () => {
    const result = scope([
      ["docs/guide.md", ""],
      ["README.md", ""],
    ]);
    expect(result.docsOnly).toBe("true");
    expect(result.skipE2e).toBe("true");
  });

  it("runs the full suite for code PRs", () => {
    const result = scope([
      ["docs/guide.md", ""],
      ["src/app.ts", ""],
    ]);
    expect(result.docsOnly).toBe("false");
    expect(result.skipE2e).toBe("false");
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
      const result = scope([[path, ""]]);
      expect(result.docsOnly).toBe("false");
      expect(result.skipE2e).toBe("false");
    },
  );

  it("counts an asset source renamed into docs/ as code", () => {
    const result = scope([["docs/rsvp-button.md", "assets/islands/rsvp-button.js"]]);
    expect(result.docsOnly).toBe("false");
    expect(result.skipE2e).toBe("false");
  });
});
