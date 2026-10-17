// Gradual-promotion proof harness: hermetic contract tests.
//
// The fixture is exercised against the REAL bin/smoke.mjs checker over
// loopback, the generated config against the production-exclusion rules,
// and the workflow against its pins (exact central action SHA, manual
// dispatch only, staging credentials only, no restore step). No network
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
import { probeVersion } from "./probe.mjs";
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

test("healthy fixture passes the real smoke checker across all 17 routes", async (t) => {
  const { base, paths } = await serveFixture(t, fixtureEnv("ok"));
  const logs = [];
  const ok = await smoke(base, { log: (line) => logs.push(line), allowIndexable: false });
  assert.equal(ok, true, logs.join("\n"));
  assert.equal(paths.length, 17);
  assert.match(logs.at(-1), /^smoke: 17 routes, 0 failed assertions$/);
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
  assert.match(PINNED_ACTION, /@1dcce452d9066c02e4ab3d99931edf75d50388d7$/);
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
});
