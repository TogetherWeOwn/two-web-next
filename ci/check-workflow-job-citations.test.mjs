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
      "`wrapped-smoke` job in",
      "  `.github/workflows/e2e.yml`.",
      "[`anchored-smoke` job](../.github/workflows/e2e.yml#L9)",
      "`linked-smoke` job in [`e2e.yml`](../.github/workflows/e2e.yml)",
      "`` `example-smoke` job in `.github/workflows/e2e.yml` ``",
      "",
    ].join("\n"),
  });

  const run = repo.run();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /checked: 6, broken: 6/);
  assert.ok(run.stderr.includes(`"docs/runbook.md":1: missing job "deploy-staging" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":2: missing job "step-only" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":3: missing job "Deploy stage" in ${deploy}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":4: missing job "wrapped-smoke" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":6: missing job "anchored-smoke" in ${e2e}`));
  assert.ok(run.stderr.includes(`"docs/runbook.md":7: missing job "linked-smoke" in ${e2e}`));
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
      "",
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
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const { jobs } = parse(source);
  const docs = jobs["docs-links"];
  assert.equal(docs.if, undefined);
  assert.equal(docs["continue-on-error"], undefined);
  assert.ok(jobs["ci-ok"].needs.includes("docs-links"));
  assert.equal(
    docs.steps[0].with["fetch-depth"],
    "${{ github.event_name == 'merge_group' && '0' || '2' }}",
  );
  const fixtures = docs.steps.find(
    (step) => step.run === "node --test ci/check-workflow-job-citations.test.mjs",
  );
  assert.ok(fixtures);
  assert.equal(fixtures.if, undefined);
  assert.equal(fixtures["continue-on-error"], undefined);
  const gate = docs.steps.find(
    (step) => step.run === 'node ci/check-workflow-job-citations.mjs "$CITATION_BASE"',
  );
  assert.ok(gate);
  assert.equal(
    gate.if,
    "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
  );
  assert.equal(
    gate.env.CITATION_BASE,
    "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.merge_group.base_sha }}",
  );
  assert.equal(gate["continue-on-error"], undefined);
});
