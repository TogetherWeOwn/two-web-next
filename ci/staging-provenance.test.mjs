import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deploySmokeWasScoped,
  observeStaging,
  resolveStagingCandidate,
} from "./staging-provenance.mjs";
import { stagingReceipt } from "./staging-receipt.mjs";

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

test("staging receipts follow the served candidate through an out-of-order main advance and refuse disagreement", async () => {
  const worker = "12345678-0123-4567-abcd-123456789abc";
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_SHA: B,
    GITHUB_RUN_ID: "200",
    GITHUB_RUN_ATTEMPT: "1",
    STAGING_CANDIDATE: A,
    STAGING_CI_RUN_ID: "100",
    STAGING_CI_RUN_ATTEMPT: "2",
    STAGING_JOB_STATUS: "success",
    STAGING_WEB_DEPLOY_OUTCOME: "success",
  };
  const calls = [];
  const fetchOrigins = (upSha, versionSha) => async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, "https://next.togetherweown.com");
    assert.equal(options.redirect, "error");
    calls.push(endpoint.pathname);
    if (endpoint.pathname === "/up") {
      return new Response(JSON.stringify({ revision: { commit: upSha, version_id: worker } }), {
        status: 503,
      });
    }
    assert.equal(endpoint.pathname, "/version");
    return new Response(JSON.stringify({ sha: versionSha, deployedAt, extra: "private response" }));
  };
  const deploy = await stagingReceipt("deploy", env, {}, { fetchImpl: fetchOrigins(A, A), now });
  assert.ok(deploy.includes(`Workflow trigger SHA (run head) \`${B}\``));
  assert.ok(deploy.includes(`actions/runs/100/attempts/2), source \`${A}\``));
  assert.ok(deploy.includes(`Live /up source \`${A}\`, Worker version \`${worker}\``));
  assert.ok(deploy.includes(`Live /version source \`${A}\`, deployed at \`${deployedAt}\``));
  assert.match(deploy, /Identity receipt matched at observation/);
  assert.deepEqual(calls.splice(0), ["/up", "/version"]);

  const failedDeploy = await stagingReceipt(
    "deploy",
    { ...env, STAGING_JOB_STATUS: "failure" },
    {},
    { fetchImpl: fetchOrigins(A, A), now },
  );
  assert.match(failedDeploy, /Identity receipt matched at observation/);
  assert.match(failedDeploy, /This deploy run is ineligible \(deploy job failed\)/);
  assert.deepEqual(calls.splice(0), ["/up", "/version"]);

  const failedUpload = await stagingReceipt(
    "deploy",
    { ...env, STAGING_JOB_STATUS: "failure", STAGING_WEB_DEPLOY_OUTCOME: "failure" },
    {},
    { fetchImpl: fetchOrigins(A, A), now },
  );
  assert.match(failedUpload, /Identity receipt refused \(no observation\)/);
  assert.equal(calls.length, 0);

  const e2eEnv = { ...env, GITHUB_SHA: C, GITHUB_RUN_ID: "300", STAGING_SKIP_E2E: "false" };
  const event = { workflow_run: { ...run, id: 200, run_attempt: 1 } };
  const e2e = async ({ expectedProbes = ["/up", "/version"], ...override }, fetchImpl) => {
    const summary = await stagingReceipt("e2e", { ...e2eEnv, ...override }, event, {
      fetchImpl,
      now,
    });
    assert.deepEqual(calls.splice(0), expectedProbes);
    return summary;
  };
  const matched = await e2e({}, fetchOrigins(A, A));
  assert.ok(matched.includes(`Workflow trigger SHA (run head) \`${C}\``));
  assert.ok(matched.includes(`actions/runs/200/attempts/1), workflow head \`${B}\``));
  assert.match(matched, /actions\/runs\/300\/attempts\/1/);
  assert.match(matched, /Pending successful qualification and 30-minute soak/);
  assert.doesNotMatch(matched, /private response/);

  const disagreement = await e2e({}, fetchOrigins(B, A));
  assert.ok(disagreement.includes(`Live /up source \`${B}\``));
  assert.ok(disagreement.includes(`Live /version source \`${A}\``));
  assert.match(disagreement, /Identity receipt refused \(disagreement or missing proof\)/);
  assert.match(disagreement, /Soak eligibility\*\* Unproven/);
  assert.doesNotMatch(disagreement, /matched at observation|Pending successful qualification/);
  assert.match(await e2e({}, fetchOrigins(B, B)), /Identity receipt refused/);

  const malformed = await e2e({}, fetchOrigins("<private response>", C));
  assert.match(malformed, /Live \/up source unavailable/);
  assert.ok(malformed.includes(`Live /version source \`${C}\``));
  assert.doesNotMatch(malformed, /private response/);
  assert.match(malformed, /Identity receipt refused/);

  assert.match(await e2e({ STAGING_SKIP_E2E: "true" }, fetchOrigins(A, A)), /scope-skipped/);
  assert.match(
    await e2e({ GITHUB_RUN_ATTEMPT: "2" }, fetchOrigins(A, A)),
    /rerun disqualifies the commit and blocks candidates with older runs/,
  );
  const refused = await e2e({ STAGING_CANDIDATE: C, expectedProbes: [] }, fetchOrigins(C, C));
  assert.match(refused, /Candidate source unavailable/);
  assert.match(refused, /Identity receipt refused \(no observation\)/);
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

test("a smoke skip is proof only on the exact successful deploy attempt", async () => {
  const trigger = {
    ...run,
    id: 55,
    run_attempt: 2,
    status: "completed",
    event: "workflow_run",
    path: ".github/workflows/deploy.yml",
  };
  const proof = {
    name: "Record adjacent staging smoke skip",
    status: "completed",
    conclusion: "success",
  };
  const job = {
    name: "deploy-staging",
    run_id: 55,
    run_attempt: 2,
    head_sha: B,
    status: "completed",
    conclusion: "success",
    steps: [proof],
  };
  const check = (changes = {}) =>
    deploySmokeWasScoped(trigger, repository, async (url, options) => {
      assert.equal(new URL(url).pathname, "/repos/example/site/actions/runs/55/attempts/2/jobs");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      return Response.json({ total_count: 1, jobs: [{ ...job, ...changes }] });
    });

  assert.equal(await check(), true);
  for (const changes of [
    { run_id: 56 },
    { run_attempt: 1 },
    { head_sha: A },
    { status: "in_progress" },
    { steps: [] },
    { steps: [proof, proof] },
  ]) {
    assert.equal(await check(changes), false);
  }
  assert.equal(
    await deploySmokeWasScoped(
      trigger,
      repository,
      async () => new Response(null, { status: 403 }),
    ),
    false,
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
    const data = join(directory, "fetch-body.json");
    writeFileSync(data, JSON.stringify(body));
    writeFileSync(
      mock,
      'import { readFileSync } from "node:fs";\nconst text = readFileSync(new URL("./fetch-body.json", import.meta.url), "utf8");\nglobalThis.fetch = async () => new Response(text);\n',
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
      /      - id: scope\n        env:\n((?:          .*\n)+)        run: \|\n((?:          .*\n|\n)+)/,
    );
    assert.ok(block, "execute the actual scope step, not a duplicate implementation");
    assert.match(block[1], /^          EVENT_NAME: \$\{\{ github\.event_name \}\}$/m);
    const scopeOutput = "${{ steps.candidate.outputs.deploy_smoke_scoped }}";
    assert.ok(block[1].includes(`DEPLOY_SMOKE_SCOPED: ${scopeOutput}`));
    const script = block[2].replace(/^          /gm, "");
    assert.doesNotMatch(script, /\$\{\{/);
    assert.match(script, /\[ "\$EVENT_NAME" = workflow_dispatch \]/);
    const evaluate = (head, trusted, event = "workflow_run", scope = "true", command = script) => {
      write("output", "");
      execFileSync("bash", ["-c", command], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          HEAD_SHA: head,
          WORKFLOW_SHA: trusted,
          EVENT_NAME: event,
          DEPLOY_SMOKE_SCOPED: scope,
          LIVE_SHA: trusted,
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
    assert.equal(evaluate(prose, prose, "workflow_run", "false").skip_e2e, "false");
    assert.equal(evaluate(prose, prose, "workflow_dispatch").skip_e2e, "false");
    assert.equal(evaluate(base, base).skip_e2e, "false");

    const deploy = readFileSync(
      new URL("../.github/workflows/deploy.yml", import.meta.url),
      "utf8",
    );
    const smokeStep = deploy.split(
      "      - name: Scope post-deploy smoke to web-affecting changes\n",
    )[1];
    const smoke = smokeStep
      .split("\n      - ")[0]
      .split("        run: |\n")[1]
      .replace(/^          /gm, "");
    assert.match(
      deploy,
      /id: forward\n +run: node ci\/staging-forward\.mjs[\s\S]*LIVE_SHA: \$\{\{ steps\.forward\.outputs\.live_sha \}\}[\s\S]*- name: Record adjacent staging smoke skip\n +if: steps\.smoke-scope\.outputs\.skip_e2e == 'true'/,
    );
    assert.equal(evaluate(prose, deployed, "workflow_run", "false", smoke).skip_e2e, "false");
    assert.equal(evaluate(prose, workflowSha, "workflow_run", "true", smoke).skip_e2e, "true");
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
  assert.match(
    workflow,
    /continue-on-error: true\n(?:.*\n)*? +run: node ci\/staging-receipt\.mjs e2e/,
  );
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
