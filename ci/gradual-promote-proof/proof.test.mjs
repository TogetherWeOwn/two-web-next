// Gradual-promotion proof harness: hermetic contract tests.
//
// The fixture is exercised against the REAL bin/smoke.mjs checker over
// loopback, the generated config against the production-exclusion rules,
// and the workflow against its pins (exact central action SHA, manual
// dispatch only, staging credentials only, no post-action restore). No network
// beyond loopback, no Cloudflare credentials.
//
// Run: node --test ci/gradual-promote-proof/proof.test.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { smoke } from "../../bin/smoke.mjs";
import { handleProofRequest } from "./fixture.mjs";
import { probeVersion, probeVersionWithRetry } from "./probe.mjs";
import {
  PINNED_ACTION,
  PROOF_WORKER_NAME,
  assertProofConfig,
  assertProofDomain,
  assertProofWorkerName,
  buildEvidence,
  buildProofConfig,
  deployedVersionAt100,
  fixtureModeForRunMode,
  versionIdForTag,
} from "./proof-lib.mjs";

const ORIGINAL = "12345678-1234-1234-1234-123456789abc";
const CANDIDATE = "22345678-1234-1234-1234-123456789abc";

function fixtureEnv(mode = "ok") {
  return {
    CF_VERSION_METADATA: { id: CANDIDATE, tag: "proof-candidate-1-1-success" },
    PROOF_MODE: mode,
    PROOF_LABEL: "candidate",
  };
}

async function serveFixture(t, env) {
  const paths = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url);
    const result = handleProofRequest(
      new Request(`http://${request.headers.host}${request.url}`),
      env,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(await result.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, paths };
}

test("healthy fixture passes the real smoke checker across all 23 routes", async (t) => {
  const { base, paths } = await serveFixture(t, fixtureEnv("ok"));
  const logs = [];
  const ok = await smoke(base, { log: (line) => logs.push(line), allowIndexable: false });
  assert.equal(ok, true, logs.join("\n"));
  assert.equal(paths.length, 23);
  assert.match(logs.at(-1), /^smoke: 23 routes, 0 failed assertions$/);
});

test("healthy fixture passes the real smoke checker with a matching version override", async (t) => {
  const { base } = await serveFixture(t, fixtureEnv("ok"));
  const logs = [];
  const ok = await smoke(base, {
    log: (line) => logs.push(line),
    allowIndexable: false,
    versionOverride: `${PROOF_WORKER_NAME}="${CANDIDATE}"`,
  });
  assert.equal(ok, true, logs.join("\n"));
});

test("fail-up fixture is rejected by the real smoke checker", async (t) => {
  const { base } = await serveFixture(t, fixtureEnv("fail-up"));
  const logs = [];
  const ok = await smoke(base, { log: (line) => logs.push(line), allowIndexable: false });
  assert.equal(ok, false);
  assert.ok(
    logs.some((line) => line.startsWith("FAIL /up: expected HTTP 200")),
    logs.join("\n"),
  );
});

test("attribution probe proves which version served /up", async (t) => {
  const { base } = await serveFixture(t, fixtureEnv("ok"));
  const hit = await probeVersion(base, CANDIDATE);
  assert.equal(hit.attributionOk, true);
  assert.equal(hit.servedVersionTag, "proof-candidate-1-1-success");
  assert.equal(hit.servedLabel, "candidate");
  const miss = await probeVersion(base, ORIGINAL, {
    versionOverride: `${PROOF_WORKER_NAME}="${ORIGINAL}"`,
  });
  assert.equal(miss.attributionOk, false);
  assert.equal(miss.overrideRequested, true);
  assert.equal(miss.servedVersionId, CANDIDATE);
});

// Models Cloudflare's documented override rule: a version override is
// applied only when the named version is in the current deployment (at
// any share, including 0%); otherwise normal routing serves the live
// version. This is the platform behaviour the workflow's 0% candidate
// deploy exists for: probing an uploaded-only candidate must fail.
async function serveDeploymentModel(t, deployed, envByVersion, liveVersion) {
  const server = createServer(async (request, response) => {
    const override = request.headers["cloudflare-workers-version-overrides"];
    const match = typeof override === "string" ? override.match(/="([^"]+)"/) : null;
    const served =
      match && deployed.has(match[1]) && envByVersion.has(match[1]) ? match[1] : liveVersion;
    const result = handleProofRequest(
      new Request(`http://${request.headers.host}${request.url}`),
      envByVersion.get(served),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(await result.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("override probe fails for an undeployed candidate and passes once it is deployed at 0%", async (t) => {
  const envByVersion = new Map([
    [
      ORIGINAL,
      {
        CF_VERSION_METADATA: { id: ORIGINAL, tag: "proof-original-1-1" },
        PROOF_MODE: "ok",
        PROOF_LABEL: "original",
      },
    ],
    [CANDIDATE, fixtureEnv("ok")],
  ]);
  const deployed = new Set([ORIGINAL]);
  const base = await serveDeploymentModel(t, deployed, envByVersion, ORIGINAL);
  const override = `${PROOF_WORKER_NAME}="${CANDIDATE}"`;
  // Uploaded only, not in the deployment: the override is ignored and
  // the live original answers, so attribution must fail.
  const undeployed = await probeVersion(base, CANDIDATE, { versionOverride: override });
  assert.equal(undeployed.attributionOk, false);
  assert.equal(undeployed.servedVersionId, ORIGINAL);
  // Deployed at 0%: still no live traffic, but the override now applies.
  deployed.add(CANDIDATE);
  const atZero = await probeVersion(base, CANDIDATE, { versionOverride: override });
  assert.equal(atZero.attributionOk, true);
  assert.equal(atZero.servedVersionId, CANDIDATE);
  // Live traffic (no override) is still the original at 100%.
  const live = await probeVersion(base, ORIGINAL);
  assert.equal(live.attributionOk, true);
});

test("retried probe survives stale edges and records every attempt", async () => {
  const servedIds = [ORIGINAL, ORIGINAL, CANDIDATE];
  let calls = 0;
  const fetchImpl = async () => {
    const id = servedIds[Math.min(calls, servedIds.length - 1)];
    calls += 1;
    return new Response("ok", { status: 200, headers: { "x-proof-version-id": id } });
  };
  const sleeps = [];
  const attempts = [];
  const record = await probeVersionWithRetry("http://127.0.0.1:1", CANDIDATE, {
    fetchImpl,
    attempts: 6,
    delayMs: 5_000,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(record.attributionOk, true);
  assert.equal(record.servedVersionId, CANDIDATE);
  assert.deepEqual(
    attempts.map((a) => [a.attempt, a.servedVersionId, a.attributionOk]),
    [
      [1, ORIGINAL, false],
      [2, ORIGINAL, false],
      [3, CANDIDATE, true],
    ],
  );
  assert.deepEqual(sleeps, [5_000, 5_000]);

  // Exhaustion: every attempt is recorded and the last one fails.
  const exhaustedAttempts = [];
  const exhausted = await probeVersionWithRetry("http://127.0.0.1:1", CANDIDATE, {
    fetchImpl: async () =>
      new Response("ok", { status: 200, headers: { "x-proof-version-id": ORIGINAL } }),
    attempts: 2,
    delayMs: 0,
    onAttempt: (attempt) => exhaustedAttempts.push(attempt),
  });
  assert.equal(exhausted.attributionOk, false);
  assert.equal(exhaustedAttempts.length, 2);

  // A network error on one attempt is recorded, not thrown away.
  let errorCalls = 0;
  const errorAttempts = [];
  const recovered = await probeVersionWithRetry("http://127.0.0.1:1", CANDIDATE, {
    fetchImpl: async () => {
      errorCalls += 1;
      if (errorCalls === 1) throw new Error("connection reset");
      return new Response("ok", { status: 200, headers: { "x-proof-version-id": CANDIDATE } });
    },
    attempts: 3,
    delayMs: 0,
    onAttempt: (attempt) => errorAttempts.push(attempt),
  });
  assert.equal(recovered.attributionOk, true);
  assert.equal(errorAttempts[0].attributionOk, false);
  assert.match(errorAttempts[0].error, /connection reset/);

  // Bounds are enforced before any fetch happens.
  await assert.rejects(
    () => probeVersionWithRetry("http://127.0.0.1:1", CANDIDATE, { attempts: 0 }),
    /attempts must be/,
  );
  await assert.rejects(
    () => probeVersionWithRetry("http://127.0.0.1:1", CANDIDATE, { attempts: 2, delayMs: -1 }),
    /delay-ms must be/,
  );
});

test("target lock admits only the synthetic Worker and its workers.dev host", () => {
  assert.equal(assertProofWorkerName(PROOF_WORKER_NAME), PROOF_WORKER_NAME);
  for (const bad of ["two-web-next", "two-web-next-production", "two-gradual-promote-proof2", ""]) {
    assert.throws(() => assertProofWorkerName(bad), /refusing live Worker|must be exactly/);
  }
  assert.equal(
    assertProofDomain("two-gradual-promote-proof.example-account.workers.dev"),
    "two-gradual-promote-proof.example-account.workers.dev",
  );
  for (const bad of [
    "togetherweown.com",
    "next.togetherweown.com",
    "two-web-next.example-account.workers.dev",
    "two-gradual-promote-proof.workers.dev",
    "Two-Gradual-Promote-Proof.example-account.workers.dev",
  ]) {
    assert.throws(() => assertProofDomain(bad), /refusing live host|must look like|lowercase/);
  }
});

test("run mode derives the fixture mode so the forced failure cannot be faked", () => {
  assert.equal(fixtureModeForRunMode("success"), "ok");
  assert.equal(fixtureModeForRunMode("rollback"), "fail-up");
  assert.throws(() => fixtureModeForRunMode("partial"), /run mode/);
});

test("generated config isolates both action halves on the synthetic Worker", () => {
  const config = buildProofConfig({ mode: "fail-up", label: "candidate" });
  assert.equal(config.name, PROOF_WORKER_NAME);
  assert.equal(config.env.production.name, PROOF_WORKER_NAME);
  assert.equal(config.main, "ci/gradual-promote-proof/fixture.mjs");
  assert.equal(config.env.production.vars.PROOF_MODE, "fail-up");
  const drifted = [
    (c) => {
      c.env.production.name = "two-web-next-production";
    },
    (c) => {
      c.routes = [{ pattern: "togetherweown.com", custom_domain: true }];
    },
    (c) => {
      c.env.production.hyperdrive = [{ binding: "DB", id: "x" }];
    },
    (c) => {
      c.env.production.queues = { producers: [] };
    },
    (c) => {
      c.workers_dev = false;
    },
    (c) => {
      delete c.env.production.version_metadata;
    },
    (c) => {
      c.env.production.vars.PROOF_MODE = "ok";
    },
    (c) => {
      c.env.staging = { name: PROOF_WORKER_NAME };
    },
    (c) => {
      c.main = "src/worker.ts";
    },
    // An environment-specific entrypoint would change what the action's
    // `--env production` steps upload while rollback targets the top level.
    (c) => {
      c.env.production.main = "src/worker.ts";
    },
    // Binding kinds absent from any denylist are still not allowlisted.
    (c) => {
      c.env.production.workflows = [{ name: "w", binding: "W", class_name: "W" }];
    },
    (c) => {
      c.ai = { binding: "AI" };
    },
    (c) => {
      c.preview_urls = true;
    },
    (c) => {
      c.env.production.preview_urls = true;
    },
    (c) => {
      c.compatibility_date = "2024-01-01";
    },
    (c) => {
      c.vars.EXTRA = "x";
    },
    (c) => {
      c.observability.enabled = true;
    },
  ];
  for (const mutate of drifted) {
    const copy = JSON.parse(JSON.stringify(config));
    mutate(copy);
    assert.throws(() => assertProofConfig(copy));
  }
});

test("independent readback takes the newest single-version 100% deployment", () => {
  const deployments = [
    {
      id: "d-new",
      created_on: "2026-10-17T02:00:00Z",
      versions: [{ version_id: CANDIDATE, percentage: 100 }],
    },
    {
      id: "d-old",
      created_on: "2026-10-17T01:00:00Z",
      versions: [{ version_id: ORIGINAL, percentage: 100 }],
    },
  ];
  assert.deepEqual(deployedVersionAt100(deployments), {
    deploymentId: "d-new",
    versionId: CANDIDATE,
    createdOn: "2026-10-17T02:00:00Z",
  });
  assert.throws(
    () =>
      deployedVersionAt100([
        {
          id: "d-split",
          created_on: "2026-10-17T03:00:00Z",
          versions: [
            { version_id: CANDIDATE, percentage: 5 },
            { version_id: ORIGINAL, percentage: 95 },
          ],
        },
      ]),
    /not a single version at 100%/,
  );
  assert.equal(
    versionIdForTag(
      [{ id: ORIGINAL, annotations: { "workers/tag": "proof-original-1-1" } }],
      "proof-original-1-1",
    ),
    ORIGINAL,
  );
  assert.throws(() => versionIdForTag([], "proof-original-1-1"), /no version found/);
});

test("evidence record names the expected final version for each run mode", () => {
  const base = {
    workerName: PROOF_WORKER_NAME,
    domain: "two-gradual-promote-proof.example-account.workers.dev",
    original: { versionId: ORIGINAL, tag: "proof-original-1-1" },
    candidate: { versionId: CANDIDATE, tag: "proof-candidate-1-1-rollback" },
    actionOutcome: "failure",
    finalDeployedVersionId: ORIGINAL,
    sightings: [],
  };
  const rollback = buildEvidence({ ...base, runMode: "rollback" });
  assert.equal(rollback.schema, "gradual-promote-proof/v1");
  assert.equal(rollback.action, PINNED_ACTION);
  assert.equal(rollback.expectedFinalVersionId, ORIGINAL);
  const success = buildEvidence({ ...base, runMode: "success", actionOutcome: "success" });
  assert.equal(success.expectedFinalVersionId, CANDIDATE);
  assert.throws(
    () => buildEvidence({ ...base, runMode: "success", workerName: "two-web-next-production" }),
    /refusing live Worker/,
  );
});

test("workflow pins the exact central action and keeps production unreachable", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/gradual-promote-proof.yml", import.meta.url),
    "utf8",
  );
  // The unchanged pinned action, invoked exactly once.
  assert.equal(workflow.split(PINNED_ACTION).length - 1, 1);
  assert.match(PINNED_ACTION, /@89c290be20c0044efaf6916f28341c76e75fff06$/);
  // Manual dispatch from main only: no other trigger keys in the on: block.
  const onBlock = workflow.match(/^on:\n([\s\S]*?)\n\npermissions:/m)?.[1] ?? "";
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /^\s+(push|pull_request|schedule|workflow_run|release):/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  // Staging-scoped credentials only; the production secret names never appear.
  assert.doesNotMatch(workflow, /PRODUCTION_CLOUDFLARE/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  // No restore path of its own: restoration is the action's rollback or a
  // documented manual operator step, never a hidden workflow step, and the
  // deliberate failure is never masked.
  assert.doesNotMatch(workflow, /wrangler rollback/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.match(workflow, /id: gradual\n\s+uses: /);
  assert.match(workflow, /name: Independent readback and evidence record\n\s+if: always\(\)/);
  assert.match(workflow, /allow-indexable: "false"/);
  // Candidate upload precedes the action; readback follows it.
  const uploadAt = workflow.indexOf('CANDIDATE_TAG="proof-candidate-');
  const actionAt = workflow.indexOf(PINNED_ACTION);
  const readbackAt = workflow.indexOf("Independent readback and evidence record");
  assert.ok(uploadAt !== -1 && uploadAt < actionAt && actionAt < readbackAt);
  // The candidate must be IN the deployment (at 0%) before the override
  // probe, or Cloudflare ignores the override and the original answers.
  const zeroDeployAt = workflow.indexOf(
    '"${ORIGINAL_VERSION}@100" --version-tag "${CANDIDATE_TAG}@0%"',
  );
  const overrideProbeAt = workflow.indexOf("probe-candidate-override.jsonl");
  assert.ok(zeroDeployAt !== -1 && zeroDeployAt < overrideProbeAt);
  // The 0% split must collapse back to the original alone at 100% before
  // the action: the action refuses to start from a split deployment.
  const restoreAt = workflow.indexOf("Restore the single-version original before the action");
  assert.ok(overrideProbeAt < restoreAt && restoreAt < actionAt);
  const restoreBlock = workflow.slice(restoreAt, actionAt);
  assert.ok(restoreBlock.includes('--version-tag "${ORIGINAL_TAG}@100%"'));
  assert.ok(restoreBlock.includes("--assert-deployed"));
  // Every live attribution probe retries with bounded attempts; a single
  // stale edge response must not fail the run.
  assert.equal(workflow.split("--attempts 6 --delay-ms 5000").length - 1, 3);
  assert.equal(workflow.split('probe.mjs "https://$DOMAIN"').length - 1, 3);
});

test("proof pin equals the production deploy pin so they cannot drift", () => {
  const deploy = readFileSync(
    new URL("../../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const match = deploy.match(/TogetherWeOwn\/\.github\/actions\/gradual-promote@([0-9a-f]{40})/);
  assert.ok(match, "production deploy must pin the central gradual-promote action");
  const productionPin = `TogetherWeOwn/.github/actions/gradual-promote@${match[1]}`;
  assert.equal(PINNED_ACTION, productionPin);
  const workflow = readFileSync(
    new URL("../../.github/workflows/gradual-promote-proof.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.includes(productionPin),
    "proof workflow must invoke the production action pin",
  );
});
