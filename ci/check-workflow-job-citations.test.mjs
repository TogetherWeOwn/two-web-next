import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-workflow-job-citations.mjs", import.meta.url));
const e2e = ".github/workflows/e2e.yml";
const deploy = ".github/workflows/deploy.yml";
const actions = "https://github.com/TogetherWeOwn/two-web-next/actions/workflows";

function fixture(t, baseline = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-job-citations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, stdio: "pipe" },
    );
  git("init", "--quiet");
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git("add", "--all");
    git("commit", "--quiet", "-m", "fixture");
  };
  commit({
    [e2e]: [
      "name: e2e",
      "jobs:",
      "  'browser-smoke':",
      "    name: Browser smoke",
      "    steps:",
      "      - name: Browser step",
      "        run: |",
      "          step-only:",
      "            name: not a job",
      "",
    ].join("\n"),
    [deploy]: "jobs: { deploy-staging: { name: Deploy staging } }\n",
    ...baseline,
  });
  return {
    commit,
    run: (base = "HEAD^1") =>
      spawnSync(process.execPath, [checker, base], { cwd: root, encoding: "utf8" }),
  };
}

test("accepts job IDs and static names in explicit prose, table and workflow links", (t) => {
  const repo = fixture(t);
  repo.commit({
    "docs/runbook.md": [
      "`browser-smoke` job in `.github/workflows/e2e.yml`.",
      "`.github/workflows/deploy.yml`, job `deploy-staging`.",
      "An independent check (`e2e.yml` `Browser smoke` job).",
      "The browser-smoke job (`.github/workflows/e2e.yml`).",
      "| `browser-smoke` job | 60 min | `.github/workflows/e2e.yml` |",
      "[`Browser smoke` job](../.github/workflows/e2e.yml)",
      `[GitHub Actions → deploy.yml (\`deploy-staging\` job)](${actions}/deploy.yml)`,
      "",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /checked: 7, broken: 0/);
});

test("fails changed and added citations against the cited workflow's jobs mapping", (t) => {
  const repo = fixture(t, {
    "docs/runbook.md": "`browser-smoke` job in `.github/workflows/e2e.yml`.\n",
  });
  repo.commit({
    "docs/runbook.md": [
      "`deploy-staging` job in `.github/workflows/e2e.yml`.",
      "`step-only` job in `e2e.yml`.",
      `[\`Deploy stage\` job](${actions}/deploy.yml)`,
      "",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /checked: 3, broken: 3/);
  assert.ok(run.stderr.includes(`"docs/runbook.md":1: missing job "deploy-staging" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":2: missing job "step-only" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":3: missing job "Deploy stage" in ${deploy}`));
});

test("leaves unrelated prose, external links, examples and existing citations to review", (t) => {
  const stale = "`old-name` job in `.github/workflows/e2e.yml`.\n";
  const repo = fixture(t, { "README.md": stale });
  repo.commit({
    "README.md": [
      "# Revised introduction",
      stale,
      "The `old-name` job runs in CI.",
      "`old-name` job in `upstream.yml`.",
      "[`old-name` job in `e2e.yml`](https://github.com/sveltejs/kit/actions/workflows/e2e.yml)",
      "<!-- `old-name` job in `.github/workflows/e2e.yml`. -->",
      "```md",
      stale.trimEnd(),
      "```",
      "",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /checked: 0, broken: 0/);
});

test("fails closed when the baseline is unavailable", (t) => {
  const run = fixture(t).run("missing-base");
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /Workflow job citation check failed/);
});
