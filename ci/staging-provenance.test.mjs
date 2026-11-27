import "./fixtures/staging-reservation-store.mjs";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import soakFixture from "../test/fixtures/staging-soak-receipt.json" with { type: "json" };
import { stagingLane, stagingPlans } from "./fixtures/staging-reservation-workflow.mjs";
import { isRedStagingRun } from "./resolve-promotion-sha.mjs";
import {
  deploySmokeWasScoped,
  observeStaging,
  resolveStagingCandidate,
} from "./staging-provenance.mjs";
import { stagingReceipt } from "./staging-receipt.mjs";
import { canAdmitStagingOperation, parseStagingReservation } from "./staging-reservation.mjs";
import { validateStagingSoakReceipt } from "./staging-soak-receipt.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const repository = "example/site";
const provenanceScript = fileURLToPath(new URL("./staging-provenance.mjs", import.meta.url));
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

test("staging mutation entry requires a verified caller and a successful reservation decision", async () => {
  const { assertStagingMutationAllowed } = await import("./staging-mutation-admission.mjs");
  const verifiedCaller = { operation: "mutation", verifiedOwnerId: 42 };
  const activeLease = {
    sha: A,
    allocationId: "11111111-1111-4111-8111-111111111111",
    ownerId: 42,
    issuedAt: "2026-11-01T10:30:00.000Z",
    expiresAt: "2026-11-01T11:30:00.000Z",
  };
  const instrument = (readLease, decide, caller = verifiedCaller) => {
    const effects = [];
    const enter = async () => {
      await assertStagingMutationAllowed({
        verifiedCaller: caller,
        reservationStore: {
          async readLease() {
            effects.push("read");
            return readLease();
          },
        },
        now: () => now,
        canAdmitStagingOperation(record, context) {
          effects.push({ record, context });
          return decide(record);
        },
      });
      effects.push("proceed");
    };
    return { enter, effects };
  };
  const refusal = { message: "Staging mutation reservation check refused" };
  const context = { ...verifiedCaller, nowMs: now };
  const admittedOnlyWhenAbsent = (record) => record === null;

  const present = instrument(() => activeLease, admittedOnlyWhenAbsent);
  await assert.rejects(present.enter, refusal);
  assert.deepEqual(present.effects, ["read", { record: activeLease, context }]);

  const unreadable = instrument(() => {
    throw new Error("Synthetic store failure");
  }, admittedOnlyWhenAbsent);
  await assert.rejects(unreadable.enter, refusal);
  assert.deepEqual(unreadable.effects, ["read"]);

  const incomplete = instrument(
    () => undefined,
    () => true,
  );
  await assert.rejects(incomplete.enter, refusal);
  assert.deepEqual(incomplete.effects, ["read"]);

  for (const caller of [
    null,
    {},
    { operation: "mutation" },
    { operation: "mutation", verifiedOwnerId: "42" },
    { operation: "mutation", verifiedOwnerId: 0 },
    { operation: "e2e", verifiedOwnerId: 42 },
  ]) {
    const unverified = instrument(() => null, admittedOnlyWhenAbsent, caller);
    await assert.rejects(unverified.enter, refusal);
    assert.deepEqual(unverified.effects, []);
  }

  const ambiguous = instrument(
    () => null,
    () => "allow",
  );
  await assert.rejects(ambiguous.enter, refusal);
  assert.deepEqual(ambiguous.effects, ["read", { record: null, context }]);

  const absent = instrument(() => null, admittedOnlyWhenAbsent);
  await absent.enter();
  assert.deepEqual(absent.effects, ["read", { record: null, context }, "proceed"]);

  const expiredLease = { ...activeLease, expiresAt: new Date(now).toISOString() };
  const expired = instrument(
    () => expiredLease,
    () => true,
  );
  await expired.enter();
  assert.deepEqual(expired.effects, ["read", { record: expiredLease, context }, "proceed"]);
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
  assert.match(deploy, /^- \*\*Soak eligibility\*\* Pending a qualifying staging E2E run$/m);
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

  for (const jobStatus of ["cancelled", "skipped", "", undefined, "<private response>"]) {
    const ineligible = await stagingReceipt(
      "deploy",
      { ...env, STAGING_JOB_STATUS: jobStatus },
      {},
      { fetchImpl: fetchOrigins(A, A), now },
    );
    assert.ok(ineligible.includes(`Live /up source \`${A}\`, Worker version \`${worker}\``));
    assert.ok(ineligible.includes(`Live /version source \`${A}\`, deployed at \`${deployedAt}\``));
    assert.match(ineligible, /^- Identity receipt matched at observation$/m);
    assert.match(
      ineligible,
      /^- \*\*Soak eligibility\*\* This deploy run is ineligible \(deploy job did not succeed\)$/m,
      `job status ${JSON.stringify(jobStatus)}`,
    );
    assert.doesNotMatch(ineligible, /private response|Pending a qualifying staging E2E run/);
    assert.deepEqual(calls.splice(0), ["/up", "/version"]);
  }

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

test("candidate CLI refuses a failed deploy workflow even with successful smoke-skip proof", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "staging-candidate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const event = join(directory, "event.json");
  const output = join(directory, "output");
  const requests = join(directory, "requests");
  const preload = join(directory, "fetch.mjs");
  const script = fileURLToPath(new URL("./staging-provenance.mjs", import.meta.url));
  const trigger = {
    ...run,
    id: 55,
    run_attempt: 2,
    status: "completed",
    event: "workflow_run",
    path: ".github/workflows/deploy.yml",
  };
  writeFileSync(
    join(directory, "jobs.json"),
    JSON.stringify({
      total_count: 1,
      jobs: [
        {
          name: "deploy-staging",
          run_id: trigger.id,
          run_attempt: trigger.run_attempt,
          head_sha: trigger.head_sha,
          status: "completed",
          conclusion: "success",
          steps: [
            {
              name: "Record adjacent staging smoke skip",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    preload,
    `import { appendFileSync, readFileSync } from "node:fs";
const jobs = readFileSync(new URL("./jobs.json", import.meta.url), "utf8");
globalThis.fetch = async (url) => {
  appendFileSync(new URL("./requests", import.meta.url), url + "\\n");
  return new Response(jobs);
};
`,
  );

  const execute = (conclusion) => {
    writeFileSync(event, JSON.stringify({ workflow_run: { ...trigger, conclusion } }));
    writeFileSync(output, "");
    writeFileSync(requests, "");
    const result = spawnSync(process.execPath, ["--import", preload, script, "candidate"], {
      cwd: directory,
      env: {
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: A,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  };

  const success = execute("success");
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(output, "utf8"), `sha=${A}\ndeploy_smoke_scoped=true\n`);
  assert.equal(
    readFileSync(requests, "utf8"),
    `https://api.github.com/repos/${repository}/actions/runs/55/attempts/2/jobs?per_page=100\n`,
  );

  const failure = execute("failure");
  assert.equal(failure.status, 1, failure.stderr);
  assert.equal(
    failure.stderr,
    "::error::Staging provenance refused; qualification is not evidence\n",
  );
  assert.equal(readFileSync(output, "utf8"), "");
  assert.equal(readFileSync(requests, "utf8"), "");
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

function deploySmokeFixture() {
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
  return { trigger, proof, job };
}

test("a smoke skip is proof only on the exact successful deploy attempt", async () => {
  const { trigger, proof, job } = deploySmokeFixture();
  const check = (changes = {}) =>
    deploySmokeWasScoped(trigger, repository, async (url, options) => {
      assert.equal(new URL(url).pathname, "/repos/example/site/actions/runs/55/attempts/2/jobs");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      return Response.json({ total_count: 1, jobs: [{ ...job, ...changes }] });
    });

  assert.equal(await check(), true);
  for (const changes of [
    { name: undefined },
    { run_id: 56 },
    { run_attempt: 1 },
    { head_sha: A },
    { status: "in_progress" },
    { conclusion: "failure" },
    { steps: undefined },
    { steps: [] },
    { steps: [proof, proof] },
  ]) {
    assert.equal(await check(changes), false, "invalid deploy job metadata must run full E2E");
  }
  for (const conclusion of ["skipped", "failure"]) {
    assert.equal(
      await check({ steps: [{ ...proof, conclusion }] }),
      false,
      `a ${conclusion} smoke marker must run full E2E`,
    );
  }
  for (const [scenario, payload] of [
    ["missing job count", { jobs: [job] }],
    ["missing job", { total_count: 0, jobs: [] }],
    ["multiple jobs reported", { total_count: 2, jobs: [job] }],
    ["multiple jobs returned", { total_count: 1, jobs: [job, job] }],
    ["malformed jobs collection", { total_count: 1, jobs: job }],
  ]) {
    assert.equal(
      await deploySmokeWasScoped(trigger, repository, async () => Response.json(payload)),
      false,
      `${scenario} must run full E2E`,
    );
  }
  assert.equal(
    await deploySmokeWasScoped(
      trigger,
      repository,
      async () => new Response(null, { status: 403 }),
    ),
    false,
    "an HTTP refusal must run full E2E",
  );
  assert.equal(
    await deploySmokeWasScoped(trigger, repository, async () => new Response("{")),
    false,
    "invalid JSON must run full E2E",
  );
  assert.equal(
    await deploySmokeWasScoped(trigger, repository, async () => {
      throw new TypeError("synthetic fetch refusal");
    }),
    false,
    "a rejected metadata request must run full E2E",
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

test("qualification bounds the staging identity stream and accepts matching evidence", async () => {
  const encoder = new TextEncoder();
  const candidate = { sha: A, deployedAt };
  const observeBody = (body) => observe({}, { fetchImpl: async () => new Response(body) });
  const maxPadding = 2048 - JSON.stringify({ ...candidate, padding: "" }).length;
  for (const [prefix, padding] of [
    ["", "€"],
    ["\uFEFF\uFEFF", "€".repeat(maxPadding)],
  ]) {
    const bytes = encoder.encode(prefix + JSON.stringify({ ...candidate, padding }));
    const split = bytes.indexOf(0xe2) + 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.enqueue(bytes.subarray(4, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    assert.deepEqual(await observeBody(body), candidate);
  }

  await assert.rejects(observeBody(`\uFEFF\uFEFF\uFEFF${JSON.stringify(candidate)}`), {
    message: "Staging identity is not JSON",
  });

  for (const chunks of [
    [
      encoder.encode(JSON.stringify({ ...candidate, padding: " ".repeat(maxPadding) })),
      encoder.encode(" "),
    ],
    // An incomplete UTF-8 sequence exceeds the byte cap before it emits another code unit.
    [encoder.encode(`\uFEFF\uFEFF${"€".repeat(2048)}`), Uint8Array.of(0xe2)],
  ]) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(observeBody(body), {
      message: "Staging identity response too large",
    });
    assert.equal(cancelled, true);
    assert.equal(pulls, 2);
  }
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
        ["--import", mock, provenanceScript, "observe", A, phase, "staging-identity/critical"],
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

test("a passing journey ledger cannot replace the after identity in staging evidence", (t) => {
  const workflow = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const job = workflow.match(/^  staging-journeys:\n(?:.*\n)*?(?=^  [\w-]+:)/m)?.[0] ?? "";
  const steps = job.split("\n      - name: ");
  const names = steps.map((step) => step.split("\n", 1)[0]);
  const beforeIndex = names.indexOf("Staging identity before critical journeys");
  assert.ok(beforeIndex > 0);
  const [beforeStep, runnerStep, afterStep, ledgerStep] = steps.slice(beforeIndex);
  for (const identityStep of [beforeStep, afterStep]) {
    assert.match(
      identityStep,
      /\n {8}env:\n {10}CANDIDATE_SHA: \$\{\{ needs\.scope\.outputs\.sha \}\}\n/,
    );
  }
  assert.match(beforeStep, /\n {8}id: identity-before\n/);
  assert.match(
    beforeStep,
    /\n {8}run: node ci\/staging-provenance\.mjs observe "\$CANDIDATE_SHA" before staging-identity\/critical\n?$/,
  );
  assert.match(runnerStep, /^Staging critical journeys\n {8}run: npm run e2e:staging\n/);
  assert.match(afterStep, /^Staging identity after critical journeys\n/);
  assert.match(
    afterStep,
    /\n {8}if: \$\{\{ !cancelled\(\) && steps\.identity-before\.outcome == 'success' \}\}\n/,
  );
  assert.match(
    afterStep,
    /\n {8}run: node ci\/staging-provenance\.mjs observe "\$CANDIDATE_SHA" after staging-identity\/critical\n?$/,
  );
  assert.doesNotMatch(job, /\n +continue-on-error:/);
  assert.match(ledgerStep, /\n {8}if: always\(\)\n {8}run: node ci\/check-staging-journeys\.mjs\n/);

  const { evidence, receipt } = soakFixture;
  const directory = mkdtempSync(join(tmpdir(), "staging-journey-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mock = join(directory, "fetch.mjs");
  writeFileSync(
    mock,
    `globalThis.fetch = async (url) => {
      if (url !== "https://next.togetherweown.com/version") throw new Error("Unexpected fetch");
      return new Response(process.env.FIXTURE_IDENTITY);
    };`,
  );
  for (const matches of [true, false]) {
    const cwd = join(directory, matches ? "exact" : "replaced");
    mkdirSync(join(cwd, "test-results"), { recursive: true });
    writeFileSync(
      join(cwd, "test-results/staging-journeys.json"),
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                file: "e2e/staging/fixture.spec.ts",
                title: "synthetic journey",
                tests: [{ projectName: "chromium", status: "expected", results: [] }],
              },
            ],
          },
        ],
        errors: [],
      }),
    );
    const runCli = (file, args = [], env = {}) =>
      spawnSync(
        process.execPath,
        ["--import", mock, fileURLToPath(new URL(file, import.meta.url)), ...args],
        { cwd, env, encoding: "utf8", timeout: 10_000 },
      );
    const canary = "synthetic-origin-body";
    const observeIdentity = (phase, identity) =>
      runCli(
        "./staging-provenance.mjs",
        ["observe", evidence.sha, phase, "staging-identity/critical"],
        { FIXTURE_IDENTITY: JSON.stringify({ ...identity, extra: canary }) },
      );
    const readIdentity = (phase) =>
      JSON.parse(readFileSync(join(cwd, `staging-identity/critical.${phase}.json`), "utf8"));
    const beforeResult = observeIdentity("before", evidence.e2e.before);
    assert.equal(beforeResult.status, 0, beforeResult.stderr);
    const before = readIdentity("before");
    assert.deepEqual(before, evidence.e2e.before);

    const afterResult = observeIdentity("after", {
      ...evidence.e2e.after,
      deployedAt: matches ? evidence.e2e.after.deployedAt : "2026-01-01T10:01:00.000Z",
    });
    assert.equal(afterResult.status, matches ? 0 : 1, afterResult.stderr);
    assert.ok(!(afterResult.stdout + afterResult.stderr).includes(canary));
    const ledger = runCli("./check-staging-journeys.mjs", [], {
      GITHUB_SHA: C,
      GITHUB_RUN_ID: String(evidence.e2e.runId),
      GITHUB_RUN_ATTEMPT: String(evidence.e2e.attempt),
    });
    assert.equal(ledger.status, 0, ledger.stderr);
    const diagnostic = JSON.parse(
      readFileSync(join(cwd, "test-results/staging-journey-ledger.json"), "utf8"),
    );
    assert.equal(diagnostic.verdict, "pass");
    assert.deepEqual(diagnostic.counts, { passed: 1, skipped: 0, failed: 0, flaky: 0, total: 1 });

    const conclusion = afterResult.status === 0 ? "success" : "failure";
    assert.equal(isRedStagingRun({ run_attempt: 1, status: "completed", conclusion }), !matches);
    const after = existsSync(join(cwd, "staging-identity/critical.after.json"))
      ? readIdentity("after")
      : undefined;
    const e2e = { ...evidence.e2e, conclusion, before, after };
    const validate = (input) =>
      validateStagingSoakReceipt({ ...evidence, e2e: input }, receipt, {
        nowMs: Date.parse(receipt.floorAt),
      });
    if (matches) {
      assert.deepEqual(after, evidence.e2e.after);
      assert.deepEqual(validate(e2e), receipt);
    } else {
      assert.match(afterResult.stderr, /Staging provenance refused; qualification is not evidence/);
      assert.equal(after, undefined);
      assert.throws(() => validate(e2e), /successful first-attempt E2E evidence/);
      assert.throws(
        () => validate({ ...e2e, conclusion: "success" }),
        /Staging identities do not prove the candidate/,
      );
    }
  }
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
    const readOutput = (path) =>
      Object.fromEntries(
        readFileSync(join(directory, path), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
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
      return readOutput("output");
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

    const { trigger, job } = deploySmokeFixture();
    write(
      "event.json",
      JSON.stringify({ workflow_run: { ...trigger, display_title: `deploy ${prose}` } }),
    );
    write(
      "fetch.mjs",
      'import { readFileSync } from "node:fs";\nconst text = readFileSync(new URL("./jobs.json", import.meta.url), "utf8");\nglobalThis.fetch = async () => new Response(text);\n',
    );
    for (const [steps, expected] of [
      [job.steps, "true"],
      [[], "false"],
    ]) {
      write("jobs.json", JSON.stringify({ total_count: 1, jobs: [{ ...job, steps }] }));
      write("candidate-output", "");
      execFileSync(
        process.execPath,
        ["--import", join(directory, "fetch.mjs"), provenanceScript, "candidate"],
        {
          cwd: directory,
          env: {
            GITHUB_EVENT_NAME: "workflow_run",
            GITHUB_EVENT_PATH: join(directory, "event.json"),
            GITHUB_OUTPUT: join(directory, "candidate-output"),
            GITHUB_REPOSITORY: repository,
            GITHUB_SHA: prose,
          },
          timeout: 10_000,
        },
      );
      const result = readOutput("candidate-output");
      assert.deepEqual(result, { sha: prose, deploy_smoke_scoped: expected });
      const scope = evaluate(result.sha, prose, "workflow_run", result.deploy_smoke_scoped);
      assert.equal(scope.docs_only, expected);
      assert.equal(scope.skip_e2e, expected);
    }

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
    const staging = blocks.filter((block) => block[2].includes(stagingLane.group));
    assert.equal(staging.length, 1, `${name} must queue its shared staging entry`);
    assert.equal(
      staging[0][3],
      String(stagingLane["cancel-in-progress"]),
      `${name} must not cancel an active mutation`,
    );
    assert.equal(staging[0][4], stagingLane.queue, `${name} must not evict a pending deployment`);
  }
});

test("staging reservation workflow admits qualifying E2E and gates queued mutations", () => {
  const workflow = (name) =>
    parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const deploy = workflow("deploy").jobs["deploy-staging"];
  const rollback = workflow("rollback-production");
  const rollbackJob = rollback.jobs["rollback-production"];
  const drill = workflow("staging-rollback-drill");
  const e2e = workflow("e2e-staging");
  assert.deepEqual(deploy.concurrency, stagingLane);
  assert.ok(deploy.steps.some((step) => step.run === "node ci/db-migrate.mjs apply"));
  assert.ok(rollback.on.workflow_dispatch.inputs.environment.options.includes("staging"));
  assert.match(rollbackJob.concurrency.group, /\|\| 'deploy-staging'/);
  assert.match(rollback.concurrency.group, /staging-drill-call-\{0\}/);
  assert.match(rollbackJob.concurrency.group, /staging-drill-leg-\{0\}/);
  assert.ok(rollbackJob.steps.some((step) => step.id === "rollback"));
  assert.match(drill.concurrency.group, /&& 'deploy-staging'/);
  assert.ok(drill.jobs.plan.steps.some((step) => step.id === "versions"));
  assert.equal(drill.jobs.rollback.needs, "plan");
  // Require the default success() gate for rollback. Restore can follow a
  // failed rollback, but still requires successful admission in plan.
  assert.equal(drill.jobs.rollback.if, undefined);
  assert.deepEqual(drill.jobs.restore.needs, ["plan", "rollback"]);
  assert.equal(drill.jobs.restore.if, "${{ !cancelled() && needs.plan.result == 'success' }}");
  for (const leg of [drill.jobs.rollback, drill.jobs.restore]) {
    assert.match(leg.uses, /\/rollback-production\.yml@[a-f0-9]{40}$/);
    assert.equal(leg.with.environment, "staging");
  }
  assert.match(e2e.concurrency.group, /&& 'deploy-staging'/);
  const e2eSteps = e2e.jobs["staging-journeys"].steps;
  const identityIndex = e2eSteps.findIndex((step) => step.id === "identity-before");
  assert.ok(
    identityIndex >= 0 &&
      identityIndex < e2eSteps.findIndex((step) => step.run === "npm run e2e:staging"),
  );

  const allocation = (sha, number) => ({
    sha,
    allocationId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  });
  const candidate = allocation(A, 1);
  const ownerId = 123;
  const record = {
    ...candidate,
    ownerId,
    issuedAt: "2026-11-01T10:00:00Z",
    expiresAt: "2026-11-01T10:45:00Z",
  };
  const active = {
    record,
    nowMs: Date.parse("2026-11-01T10:10:00Z"),
    e2eSha: A,
    answers: { mutation: false, e2e: true },
  };
  const otherCandidate = { ...active, e2eSha: B, answers: { mutation: false, e2e: false } };
  const soakFloor = Date.parse("2026-11-01T10:40:00Z");
  const beforeFloor = { ...active, nowMs: soakFloor - 1000 };
  const expiry = {
    ...active,
    nowMs: Date.parse(record.expiresAt),
    answers: { mutation: true, e2e: true },
  };
  const release = { ...expiry, record: null, nowMs: soakFloor };
  // A failed read is neither an expiry verdict nor a verified release.
  const unavailable = { record: undefined };
  const mutationEffects = {
    deploy: ["apply-migrations", "replace-allocation"],
    rollback: ["rollback-worker"],
    drill: ["record-versions", "rollback-worker", "restore-worker"],
  };

  for (const next of [expiry, release]) {
    let snapshot = { ...release, nowMs: Date.parse("2026-11-01T09:59:00Z") };
    let live = candidate;
    let allocationNumber = 1;
    const pending = [];
    const effects = [];
    const reads = [];
    function readReservation() {
      reads.push(snapshot.record);
      if (snapshot === unavailable) throw new Error("staging reservation unavailable");
      return { record: snapshot.record, nowMs: snapshot.nowMs, verifiedOwnerId: ownerId };
    }
    // Return canned verdicts through the admission interface. The real
    // predicate owns record validation and expiry/identity comparisons.
    function canAdmitStagingOperation(
      record,
      { operation, nowMs, verifiedOwnerId, observed, e2eSha },
    ) {
      assert.equal(record, snapshot.record);
      assert.equal(nowMs, snapshot.nowMs);
      assert.equal(verifiedOwnerId, ownerId);
      if (operation === "e2e") {
        assert.deepEqual(observed, candidate);
        assert.equal(e2eSha, snapshot.e2eSha);
      }
      return snapshot.answers[operation];
    }
    function runNext() {
      const { path, sha } = pending.shift();
      let observed;
      let restoreSha;
      for (const step of stagingPlans[path]) {
        switch (step) {
          case "observe-allocation":
            observed = live;
            break;
          case "check-mutation":
          case "check-e2e": {
            const { record, ...context } = readReservation();
            const operation = step === "check-e2e" ? "e2e" : "mutation";
            const allowed = canAdmitStagingOperation(record, {
              operation,
              ...context,
              observed,
              e2eSha: operation === "e2e" ? sha : undefined,
            });
            if (allowed !== true) throw new Error("staging reservation denied");
            break;
          }
          case "record-versions":
            restoreSha = live.sha;
            // Record the read-only plan effect to prove it also needs admission.
            effects.push(step);
            break;
          case "replace-allocation":
          case "rollback-worker":
            live = allocation(sha, ++allocationNumber);
            effects.push(step);
            break;
          case "restore-worker":
            assert.ok(restoreSha);
            live = allocation(restoreSha, ++allocationNumber);
            effects.push(step);
            break;
          case "apply-migrations":
          case "run-journeys":
            effects.push(step);
            break;
          default:
            assert.fail(`Unexpected offline step ${step}`);
        }
      }
    }

    const mutations = [
      { path: "deploy", sha: B },
      { path: "rollback", sha: C },
      { path: "drill", sha: B },
    ];
    function rejectMutations(reason) {
      for (const { path } of mutations) {
        assert.throws(runNext, { message: `staging reservation ${reason}` }, path);
      }
      assert.deepEqual(live, candidate);
    }

    // Work queued before the lease must read the active lease when admitted.
    pending.push(...mutations, { path: "e2e", sha: A });
    assert.deepEqual(reads, []);
    snapshot = active;
    rejectMutations("denied");
    assert.deepEqual(effects, []);
    runNext();
    assert.deepEqual(effects, ["run-journeys"]);

    pending.push({ path: "e2e", sha: B });
    snapshot = otherCandidate;
    assert.throws(runNext, { message: "staging reservation denied" });
    assert.deepEqual(effects, ["run-journeys"]);

    // Even after E2E releases the workflow lane, the lease protects the soak.
    for (const [phase, reason] of [
      [beforeFloor, "denied"],
      [unavailable, "unavailable"],
    ]) {
      pending.push(...mutations);
      snapshot = phase;
      rejectMutations(reason);
      assert.deepEqual(effects, ["run-journeys"]);
    }
    assert.deepEqual(reads.slice(0, 8), Array(8).fill(record));
    assert.deepEqual(reads.slice(8), [undefined, undefined, undefined]);

    pending.push({ path: "e2e", sha: A }, ...mutations);
    snapshot = next;
    runNext();
    assert.deepEqual(effects, ["run-journeys", "run-journeys"]);
    for (const { path } of mutations) {
      const before = effects.length;
      runNext();
      assert.deepEqual(effects.slice(before), mutationEffects[path]);
    }
    assert.deepEqual(live, allocation(C, 5));
    assert.deepEqual(reads.slice(-4), Array(4).fill(next.record));
    assert.deepEqual(pending, []);
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

const reservation = Object.freeze({
  sha: "a".repeat(40),
  allocationId: "11111111-1111-4111-8111-111111111111",
  ownerId: 12345,
  issuedAt: "2026-01-01T12:00:00Z",
  expiresAt: "2026-01-01T13:00:00.000Z",
});
const issuedAtMs = Date.parse(reservation.issuedAt);
const expiresAtMs = Date.parse(reservation.expiresAt);
const observed = Object.freeze({ sha: reservation.sha, allocationId: reservation.allocationId });
const mutation = Object.freeze({
  operation: "mutation",
  nowMs: issuedAtMs + 1,
  verifiedOwnerId: reservation.ownerId,
  observed,
});
const e2e = Object.freeze({ ...mutation, operation: "e2e", e2eSha: reservation.sha });

test("staging reservation parses exact identities and a bounded UTC lifetime", () => {
  assert.deepEqual(parseStagingReservation(reservation), {
    ...observed,
    ownerId: reservation.ownerId,
    issuedAtMs,
    expiresAtMs,
  });
});

test("staging reservation blocks mutations and admits only its qualifying E2E", () => {
  assert.equal(canAdmitStagingOperation(reservation, { ...mutation, nowMs: issuedAtMs }), false);
  assert.equal(canAdmitStagingOperation(reservation, { ...e2e, nowMs: issuedAtMs }), true);
  assert.equal(
    canAdmitStagingOperation(reservation, { ...mutation, nowMs: expiresAtMs - 1 }),
    false,
  );
  assert.equal(canAdmitStagingOperation(reservation, { ...e2e, nowMs: expiresAtMs - 1 }), true);

  for (const [description, override] of [
    ["different E2E SHA", { e2eSha: "b".repeat(40) }],
    ["different serving SHA", { observed: { ...observed, sha: "b".repeat(40) } }],
    ["missing observation", { observed: undefined }],
    ["missing allocation", { observed: { sha: reservation.sha } }],
    ["missing owner verification", { verifiedOwnerId: undefined }],
    ["different verified owner", { verifiedOwnerId: reservation.ownerId + 1 }],
    ["coerced owner ID", { verifiedOwnerId: String(reservation.ownerId) }],
    ["future issue time", { nowMs: issuedAtMs - 1 }],
  ]) {
    assert.equal(
      canAdmitStagingOperation(reservation, { ...e2e, ...override }),
      false,
      description,
    );
  }
});

test("staging reservation keeps its mutation hold if the allocation is lost before expiry", () => {
  const replacement = { ...observed, allocationId: "22222222-2222-4222-8222-222222222222" };
  assert.equal(
    canAdmitStagingOperation(reservation, { ...mutation, observed: replacement }),
    false,
  );
  assert.equal(canAdmitStagingOperation(reservation, { ...e2e, observed: replacement }), false);
  assert.equal(canAdmitStagingOperation(null, { ...mutation, observed: replacement }), true);
  assert.equal(
    canAdmitStagingOperation(reservation, { ...e2e, observed: replacement, nowMs: expiresAtMs }),
    true,
  );
});

test("staging reservation opens the gate at verified expiry or explicit absence", () => {
  const atExpiry = { ...mutation, nowMs: expiresAtMs };
  assert.equal(canAdmitStagingOperation(reservation, atExpiry), true);
  assert.equal(canAdmitStagingOperation(reservation, { ...atExpiry, verifiedOwnerId: 1 }), false);
  assert.equal(canAdmitStagingOperation(null, mutation), true);
  assert.equal(canAdmitStagingOperation(null, e2e), true);
  assert.equal(canAdmitStagingOperation(undefined, atExpiry), false);
  assert.equal(canAdmitStagingOperation(null, { ...mutation, operation: "rollback" }), false);
  assert.equal(canAdmitStagingOperation(null, { ...e2e, e2eSha: undefined }), false);
  assert.equal(canAdmitStagingOperation(null), false);
  for (const nowMs of [NaN, Infinity, -1, 1.5, String(expiresAtMs)]) {
    assert.equal(canAdmitStagingOperation(reservation, { ...atExpiry, nowMs }), false);
  }
});

test("staging reservation rejects malformed records and overlong lifetimes even after they would expire", () => {
  const malformed = [
    [],
    JSON.stringify(reservation),
    { ...reservation, ignored: true },
    { ...reservation, [Symbol("ignored")]: true },
    {
      ...reservation,
      get sha() {
        return reservation.sha;
      },
    },
    { ...reservation, sha: reservation.sha.slice(0, 39) },
    { ...reservation, sha: `${reservation.sha}\n` },
    { ...reservation, allocationId: `${reservation.allocationId}\n` },
    { ...reservation, allocationId: "g1111111-1111-4111-8111-111111111111" },
    { ...reservation, allocationId: "A1111111-1111-4111-8111-111111111111" },
    { ...reservation, ownerId: 0 },
    { ...reservation, ownerId: String(reservation.ownerId) },
    { ...reservation, ownerId: Number.MAX_SAFE_INTEGER + 1 },
    { ...reservation, expiresAt: undefined },
    { ...reservation, expiresAt: Infinity },
    {
      ...reservation,
      issuedAt: "2026-02-30T12:00:00Z",
      expiresAt: "2026-03-02T13:00:00Z",
    },
    { ...reservation, expiresAt: "2026-01-01T12:10:00+00:00" },
    { ...reservation, expiresAt: "2026-01-01T12:10:00.0001Z" },
    { ...reservation, expiresAt: "2026-01-01T11:59:00Z" },
    { ...reservation, expiresAt: reservation.issuedAt },
    { ...reservation, expiresAt: "2026-01-01T13:00:00.001Z" },
  ];
  for (const record of malformed) {
    assert.throws(() => parseStagingReservation(record));
    assert.equal(canAdmitStagingOperation(record, e2e), false);
    assert.equal(canAdmitStagingOperation(record, { ...mutation, nowMs: expiresAtMs + 2 }), false);
  }
});
test("exact-attempt jobs streaming preserves proof and falls back to full smoke on size or read failure", async (t) => {
  const trigger = {
    ...run,
    id: 55,
    run_attempt: 2,
    status: "completed",
    event: "workflow_run",
    path: ".github/workflows/deploy.yml",
  };
  const payload = JSON.stringify({
    total_count: 1,
    jobs: [
      {
        name: "deploy-staging",
        run_id: trigger.id,
        run_attempt: trigger.run_attempt,
        head_sha: trigger.head_sha,
        status: "completed",
        conclusion: "success",
        steps: [
          {
            name: "Record adjacent staging smoke skip",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
  });
  const encoder = new TextEncoder();
  const budget = 64 * 1024;
  const atLimit = encoder.encode(payload.padEnd(budget));
  const check = (body) => deploySmokeWasScoped(trigger, repository, async () => new Response(body));
  const workflow = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const scope = workflow.match(
    /DEPLOY_SMOKE_SCOPED: [^\n]+\n        run: \|\n((?: {10}[^\n]*\n)+)/,
  );
  assert.ok(scope);
  const directory = mkdtempSync(join(tmpdir(), "staging-jobs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "scope-output");
  const assertFullSmoke = (scoped) => {
    assert.equal(scoped, false);
    writeFileSync(output, "");
    execFileSync("bash", ["-c", scope[1]], {
      cwd: directory,
      env: {
        EVENT_NAME: "workflow_run",
        HEAD_SHA: B,
        WORKFLOW_SHA: B,
        DEPLOY_SMOKE_SCOPED: String(scoped),
        GITHUB_OUTPUT: output,
      },
      timeout: 10_000,
    });
    assert.equal(readFileSync(output, "utf8"), "docs_only=false\nskip_e2e=false\n");
  };

  const bounded = new ReadableStream({
    start(controller) {
      controller.enqueue(atLimit.subarray(0, 64));
      controller.enqueue(atLimit.subarray(64));
      controller.close();
    },
  });
  assert.equal(await check(bounded), true);

  for (const cancelTransport of [
    () => new Promise(() => {}),
    () => Promise.reject(new Error("synthetic cancellation refusal")),
  ]) {
    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(atLimit);
          else if (pulls === 2) controller.enqueue(encoder.encode(" "));
          else controller.close();
        },
        cancel() {
          cancelled = true;
          return cancelTransport();
        },
      },
      { highWaterMark: 0 },
    );
    // The synthetic stream runs in microtasks. A pending verdict at the next
    // event-loop turn means the reader waited for the stalled cancellation.
    const overflowVerdict = await Promise.race([
      check(oversized),
      new Promise((resolve) => setImmediate(() => resolve("cancellation stalled the verdict"))),
    ]);
    assertFullSmoke(overflowVerdict);
    assert.equal(pulls, 2);
    assert.equal(cancelled, true);
    assert.equal(oversized.locked, false);
  }

  const interrupted = new ReadableStream(
    {
      start(controller) {
        controller.enqueue(encoder.encode(payload));
      },
      pull(controller) {
        controller.error(new Error("synthetic interruption after proof bytes"));
      },
    },
    { highWaterMark: 0 },
  );
  assertFullSmoke(await check(interrupted));
  assert.equal(interrupted.locked, false);
  assertFullSmoke(await check(new Uint8Array()));
});
