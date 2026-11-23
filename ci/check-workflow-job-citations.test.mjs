import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const checker = fileURLToPath(new URL("./check-workflow-job-citations.mjs", import.meta.url));
const e2e = ".github/workflows/e2e.yml";
const deploy = ".github/workflows/deploy.yml";
const actions = "https://github.com/TogetherWeOwn/two-web-next/actions/workflows";

function fixture(t, baseline = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-job-citations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
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
    [e2e]: `jobs:
  'browser-smoke':
    name: Browser smoke
    steps:
      - run: |
          step-only:
            name: not a job
`,
    [deploy]: "jobs: { deploy-staging: { name: Deploy staging } }\n",
    ...baseline,
  });
  return {
    commit,
    rename: (from, to) => git("mv", "--", from, to),
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
      '[`Browser smoke` job](<../.github/workflows/e2e.yml> "CI [browser]")',
      `[GitHub Actions → deploy.yml (\`deploy-staging\` job)](${actions}/deploy.yml)`,
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
      "<!--\n```\n--!>\n`example-smoke` job in `e2e.yml`\n-->",
      "~~~md\n<!--\n~~~",
      "`wrapped-smoke` job in",
      "  `.github/workflows/e2e.yml`.",
      "[`anchored-smoke` job](../.github/workflows/e2e.yml#L9 (Pinned job))",
      "`linked-smoke` job ([`e2e.yml`](../.github/workflows/e2e.yml))",
      "`` `example-smoke` job in `.github/workflows/e2e.yml` ``",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /checked: 6, broken: 6/, run.stderr);
  assert.ok(run.stderr.includes(`"docs/runbook.md":1: missing job "deploy-staging" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":2: missing job "step-only" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":3: missing job "Deploy stage" in ${deploy}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":12: missing job "wrapped-smoke" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":14: missing job "anchored-smoke" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":15: missing job "linked-smoke" in ${e2e}`));
});

test("leaves unrelated prose, external links, examples and existing citations to review", (t) => {
  const stale = "`old-name` job in `.github/workflows/e2e.yml`.\n";
  const repo = fixture(t, { "README.md": stale });
  repo.commit({
    "README.md": [
      "# Revised introduction",
      stale,
      "The `old-name` job runs in CI.",
      "The deploy job (`deploy.yml`) has protected credentials.",
      "`old-name` job in `upstream.yml`.",
      "[`old-name` job in `e2e.yml`](https://github.com/sveltejs/kit/actions/workflows/e2e.yml)",
      "`outside` job in [`e2e.yml`](https://github.com/sveltejs/kit/actions/workflows/e2e.yml)",
      "<!-- `old-name` job in `.github/workflows/e2e.yml`. -->",
      "`separate-paragraph` job in",
      "",
      "`.github/workflows/e2e.yml`",
      "```md",
      stale.trimEnd(),
      "```",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /checked: 0, broken: 0/);
});

test("checks root docs and .yaml citations while keeping existing citations on a rename", (t) => {
  const stale = "`old-name` job in `.github/workflows/e2e.yml`.\n";
  const repo = fixture(t, { "OLD.md": stale.repeat(20) });
  repo.rename("OLD.md", "README.md");
  repo.commit({
    ".github/workflows/extra.yaml": "jobs: { new-check: { name: New check } }\n",
    "README.md":
      stale.repeat(20) +
      "`new-check` job in `.github/workflows/extra.yaml`.\n" +
      "`removed` job in `.github/workflows/removed.yml`.\n",
  });

  const run = repo.run();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /checked: 2, broken: 1/);
  assert.match(run.stderr, /"README\.md":22: missing job "removed"/);
});

test("a merge group comparison sees citations from earlier commits in the group", (t) => {
  const repo = fixture(t);
  repo.commit({ "README.md": "`browser-smoke` job in `.github/workflows/e2e.yml`.\n" });
  repo.commit({ [e2e]: "jobs: { renamed-smoke: {} }\n" });

  const run = repo.run("HEAD~2");
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /"README\.md":1: missing job "browser-smoke"/);
});

test("fails closed when the baseline is unavailable", (t) => {
  const run = fixture(t).run("missing-base");
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /Workflow job citation check failed/);
});

test("docs-links requires the fixtures and the citation check on PRs and merge groups", () => {
  const { jobs } = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const docs = jobs["docs-links"];
  assert.deepEqual([docs.if, docs["continue-on-error"]], [undefined, undefined]);
  assert.ok(jobs["ci-ok"].needs.includes("docs-links"));
  const depth = "${{ github.event_name == 'merge_group' && '0' || '2' }}";
  assert.equal(docs.steps[0].with["fetch-depth"], depth);
  const steps = docs.steps.filter((step) => step.run?.includes("check-workflow-job-citations"));
  assert.deepEqual(steps, [
    {
      name: "Workflow job citation fixtures",
      run: "node --test ci/check-workflow-job-citations.test.mjs",
    },
    {
      name: "Check added workflow job citations",
      if: "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
      env: {
        CITATION_BASE:
          "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.merge_group.base_sha }}",
      },
      run: 'node ci/check-workflow-job-citations.mjs "$CITATION_BASE"',
    },
  ]);
});
