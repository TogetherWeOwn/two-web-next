import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeStaging, resolveStagingCandidate } from "./staging-provenance.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const repository = "example/site";
const deployedAt = "2026-11-01T10:00:00.000Z";
const now = Date.parse("2026-11-01T11:00:00.000Z");
const run = {
  conclusion: "success",
  head_branch: "main",
  head_repository: { full_name: repository },
  display_title: `deploy ${A}`,
  head_sha: B,
};
const candidate = (workflow_run = run) =>
  resolveStagingCandidate({
    eventName: "workflow_run",
    event: { workflow_run },
    sha: C,
    repository,
  });
const identity =
  (body, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });
const observe = (body, options = {}) =>
  observeStaging({ expected: A, now, fetchImpl: identity(body), ...options });

test("candidate A survives deploy metadata B and workflow main tip C", () => {
  assert.equal(candidate(), A);
});

test("a deploy title is mandatory, exact, and lowercase", () => {
  for (const title of [
    undefined,
    `deploy ${A} extra`,
    A,
    `deploy ${"A".repeat(40)}`,
    "deploy main",
  ]) {
    assert.throws(() => candidate({ ...run, display_title: title }));
  }
});

test("untrusted, failed, non-main and missing deploy events fail closed", () => {
  for (const change of [
    { conclusion: "failure" },
    { conclusion: undefined },
    { head_branch: "feature" },
    { head_repository: { full_name: "elsewhere/site" } },
    { head_repository: undefined },
  ]) {
    assert.throws(() => candidate({ ...run, ...change }));
  }
  assert.throws(() => candidate(null));
  assert.throws(() => resolveStagingCandidate({ eventName: "push", sha: A, repository }));
});

test("manual qualification uses the exact main dispatch revision, not a deploy title", () => {
  assert.equal(
    resolveStagingCandidate({
      eventName: "workflow_dispatch",
      event: { workflow_run: run },
      sha: C,
      ref: "refs/heads/main",
      repository,
    }),
    C,
  );
  for (const ref of [undefined, "main", "refs/heads/feature", "refs/tags/v1"]) {
    assert.throws(() => resolveStagingCandidate({ eventName: "workflow_dispatch", sha: A, ref }));
  }
  assert.throws(() =>
    resolveStagingCandidate({
      eventName: "workflow_dispatch",
      sha: "main",
      ref: "refs/heads/main",
    }),
  );
});

test("qualification observes the fixed staging endpoint once without redirects or caching", async () => {
  const calls = [];
  const result = await observeStaging({
    expected: A,
    now,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ sha: A, deployedAt, extra: "not retained" }));
    },
  });
  assert.deepEqual(result, { sha: A, deployedAt });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://next.togetherweown.com/version");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers["cache-control"], "no-cache");
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test("identity evidence files retain only validated SHA and timestamp, never response data", () => {
  const directory = mkdtempSync(join(tmpdir(), "staging-identity-"));
  try {
    const canary = "synthetic-qa-token-cookie-member-data";
    const body = {
      sha: A,
      deployedAt,
      token: canary,
      cookie: `session=${canary}`,
      member: { name: canary },
      raw: [canary],
    };
    const mock = join(directory, "fetch.mjs");
    writeFileSync(
      mock,
      `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))});\n`,
    );
    for (const phase of ["before", "after"]) {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          mock,
          new URL("./staging-provenance.mjs", import.meta.url).pathname,
          "observe",
          A,
          phase,
          "staging-identity/critical",
        ],
        { cwd: directory, encoding: "utf8", timeout: 10_000 },
      );
      assert.ok(!output.includes(canary), "response data must not reach diagnostics");
      const evidence = readFileSync(
        join(directory, "staging-identity", `critical.${phase}.json`),
        "utf8",
      );
      assert.equal(evidence, `${JSON.stringify({ sha: A, deployedAt })}\n`);
      assert.ok(!evidence.includes(canary), "response data must not reach an artifact");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing, malformed, wrong and future identities never qualify", async () => {
  for (const body of [
    null,
    [],
    {},
    { sha: B, deployedAt },
    { sha: C, deployedAt },
    { sha: null, deployedAt },
    { sha: A, deployedAt: null },
    { sha: A, deployedAt: "soon" },
    { sha: A, deployedAt: "2027-01-01T00:00:00.000Z" },
  ]) {
    await assert.rejects(observe(body));
  }
});

test("a replacement during journeys refuses the after observation", async () => {
  const previous = await observe({ sha: A, deployedAt });
  await assert.rejects(observe({ sha: B, deployedAt }, { previous }));
  await assert.rejects(observe({ sha: A, deployedAt: "2026-11-01T10:30:00.000Z" }, { previous }));
  assert.deepEqual(await observe({ sha: A, deployedAt }, { previous }), previous);
});

test("an HTTP error or network failure is never retried into green", async () => {
  for (const status of [302, 404, 500]) {
    await assert.rejects(
      observe({ sha: A, deployedAt }, { fetchImpl: identity({ sha: A, deployedAt }, status) }),
    );
  }
  let calls = 0;
  await assert.rejects(
    observe(
      {},
      {
        fetchImpl: async () => {
          calls++;
          throw new Error("offline");
        },
      },
    ),
  );
  assert.equal(calls, 1);
  await assert.rejects(observe({}, { fetchImpl: async () => new Response("not JSON") }));
  await assert.rejects(observe({}, { fetchImpl: async () => new Response("x".repeat(2049)) }));
});

test("the candidate cannot be inferred from a malformed expected SHA", async () => {
  await assert.rejects(observe({ sha: A, deployedAt }, { expected: "main" }));
});

test("scope never skips candidate helpers using a later revision's import inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "staging-scope-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    const write = (path, source) => writeFileSync(join(directory, path), source);
    for (const path of ["ci", "e2e", "test/helpers"]) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    for (const name of ["change-scope.sh", "e2e-test-helpers.mjs"]) {
      write(`ci/${name}`, readFileSync(new URL(name, import.meta.url), "utf8"));
    }
    write(".gitignore", "/output\n/deployed-files.tsv\n");
    write("e2e/journey.ts", 'import "../test/helpers/shared.ts";\n');
    write("test/helpers/shared.ts", "export const value = 1;\n");
    git("init", "--quiet");
    git("config", "user.name", "Scope Fixture");
    git("config", "user.email", "fixture@example.test");
    const commit = () => {
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
      return git("rev-parse", "HEAD");
    };
    const base = commit();
    write("test/helpers/shared.ts", "export const value = 2;\n");
    const deployed = commit();
    write("e2e/journey.ts", "export const journey = true;\n");
    const workflowSha = commit();
    const workflow = readFileSync(
      new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
      "utf8",
    );
    const block = workflow.match(
      /      - id: scope\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/,
    );
    assert.ok(block, "execute the actual scope step, not a duplicate implementation");
    const script = block[1]
      .replace(/^          /gm, "")
      .replaceAll("${{ github.event_name }}", "$EVENT_NAME");
    const evaluate = (head, trusted, event = "workflow_run") => {
      write("output", "");
      execFileSync("bash", ["-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          HEAD_SHA: head,
          WORKFLOW_SHA: trusted,
          EVENT_NAME: event,
          GITHUB_OUTPUT: join(directory, "output"),
          RUNNER_TEMP: directory,
        },
        timeout: 10_000,
      });
      return Object.fromEntries(
        readFileSync(join(directory, "output"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    };
    // C removed A's import. C's inventory alone would wrongly skip A's helper change.
    assert.equal(evaluate(deployed, workflowSha).skip_e2e, "false");
    assert.equal(git("rev-parse", "HEAD"), workflowSha, "never check out candidate code");
    git("checkout", "--quiet", deployed);
    assert.equal(evaluate(deployed, deployed).skip_e2e, "false");
    git("checkout", "--quiet", workflowSha);
    write("README.md", "Fixture prose.\n");
    const prose = commit();
    assert.equal(evaluate(prose, workflowSha).skip_e2e, "false");
    assert.equal(evaluate(prose, prose).skip_e2e, "true");
    assert.equal(evaluate(prose, prose, "workflow_dispatch").skip_e2e, "false");
    assert.equal(evaluate(base, base).skip_e2e, "false");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every shared staging lock preserves pending runs instead of replacing them", () => {
  for (const name of ["deploy", "e2e-staging", "staging-rollback-drill", "rollback-production"]) {
    const source = readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    );
    const blocks = [
      ...source.matchAll(
        /^( *)concurrency:\n\1  group: (.+)\n\1  cancel-in-progress: (.+)\n\1  queue: (.+)$/gm,
      ),
    ];
    const staging = blocks.filter((block) => block[2].includes("deploy-staging"));
    assert.equal(staging.length, 1, `${name} must queue its shared staging entry`);
    assert.equal(staging[0][3], "false", `${name} must not cancel an active mutation`);
    assert.equal(staging[0][4], "max", `${name} must not evict a pending deployment`);
  }
});

test("qualification pins every checker, validates ancestry and shares the staging deploy mutex", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /run: node ci\/staging-provenance\.mjs candidate/);
  assert.match(workflow, /git merge-base --is-ancestor "\$CANDIDATE_SHA" origin\/main/);
  const scope = workflow.split("  zap-baseline:")[0];
  assert.equal((scope.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(scope, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(scope, /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(scope, /ref: \$\{\{ steps\.candidate\.outputs\.sha \}\}/);
  assert.match(scope, /git diff --name-status -M "\$HEAD_SHA~1" "\$HEAD_SHA"/);
  assert.match(scope, /bash ci\/change-scope\.sh/);
  assert.equal((workflow.match(/ref: \$\{\{ needs\.scope\.outputs\.sha \}\}/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/candidate_sha: \$\{\{ needs\.scope\.outputs\.sha \}\}/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /&& 'deploy-staging'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cache: npm|uses: actions\/cache@/);
  assert.equal((workflow.match(/package-manager-cache: false/g) ?? []).length, 2);
  assert.match(workflow, /after passive\/identity passive\/commit/);
  assert.doesNotMatch(workflow, /printf.*passive\/commit/);
  for (const name of ["web-quality-origin", "zap-staging"]) {
    const child = readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    );
    assert.match(child, /ref: \$\{\{ inputs\.candidate_sha \|\| github\.sha \}\}/);
    assert.match(child, /staging-provenance\.mjs observe.* before /);
    assert.match(child, /staging-provenance\.mjs observe.* after /);
    assert.doesNotMatch(child, /cache: npm|uses: actions\/cache@/);
    assert.match(child, /package-manager-cache: false/);
  }
});
