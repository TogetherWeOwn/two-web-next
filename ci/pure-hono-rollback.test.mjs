import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { REQUIRED_PRODUCTION_SECRETS } from "./check-production-secrets.mjs";
import {
  createPureHonoRollback,
  readPureHonoVersion,
  verifyPureHonoProvenance,
  verifyPureHonoRollback,
} from "./pure-hono-rollback.mjs";
import { SCHEMA, deploymentReceipt, sha256, uploadReceipt } from "./worker-bundle-evidence.mjs";

const SHA = "a".repeat(40);
const VERSION = "11111111-2222-4333-8444-555555555555";
const OTHER_VERSION = "99999999-2222-4333-8444-555555555555";
const TAG = `${SHA}-123-1`;

const input = (path, packageRoot = null, bytesInOutput = 10) => ({
  path,
  bytes: 10,
  sha256: sha256(path),
  packageRoot,
  bytesInOutput,
});
const pkg = (name) => ({ name, version: "1.0.0" });

function makeVerified({ inputs, packages, absenceEligible = true, unknownExternals = [] } = {}) {
  const inventory = {
    schema: SCHEMA,
    evidence: "build-only",
    sourceSha: SHA,
    runId: "123",
    runAttempt: "1",
    target: "two-web-next-production",
    environment: "production",
    bundle: { algorithm: "sha256", sha256: "b".repeat(64), entry: "worker.js" },
    inputs: inputs ?? [
      input("src/worker.ts"),
      input("node_modules/hono/dist/hono.js", "node_modules/hono"),
    ],
    packages: packages ?? [pkg("hono")],
    externals: [],
    absenceEligible,
    unknownExternals,
  };
  return { inventory, inventorySha256: sha256(JSON.stringify(inventory)) };
}

function makeDeployed(verified) {
  const upload = uploadReceipt(verified, [
    {
      type: "version-upload",
      version: 1,
      worker_name: verified.inventory.target,
      wrangler_environment: verified.inventory.environment,
      version_id: VERSION,
    },
  ]);
  return deploymentReceipt(verified, upload, VERSION);
}

const makeNative = (overrides = {}) => ({
  id: VERSION,
  annotations: { "workers/tag": TAG },
  resources: {
    bindings: [
      ...REQUIRED_PRODUCTION_SECRETS.map((name) => ({ name, type: "secret_text" })),
      { name: "DB", type: "hyperdrive" },
    ],
  },
  ...overrides,
});

const create = (verified = makeVerified(), deployed, native = makeNative()) =>
  createPureHonoRollback(
    verified,
    deployed === undefined ? makeDeployed(verified) : deployed,
    native,
  );

describe("createPureHonoRollback", () => {
  test("returns the exact pointer for a verified pure-Hono deployment", () => {
    const verified = makeVerified();
    assert.deepEqual(create(verified), {
      schema: "two.pure-hono-rollback.v1",
      target: "two-web-next-production",
      environment: "production",
      sourceSha: SHA,
      versionId: VERSION,
      runId: "123",
      runAttempt: "1",
      bundleSha256: "b".repeat(64),
      inventorySha256: verified.inventorySha256,
      versionTag: TAG,
      expiresAt: null,
    });
  });

  describe("native version", () => {
    const cases = {
      "wrong version id": makeNative({ id: OTHER_VERSION }),
      "wrong tag": makeNative({ annotations: { "workers/tag": `${SHA}-123-2` } }),
      "missing tag": makeNative({ annotations: {} }),
      "missing annotations": makeNative({ annotations: undefined }),
      "missing resources": makeNative({ resources: undefined }),
      "missing bindings": makeNative({ resources: {} }),
      "missing one secret": makeNative({
        resources: {
          bindings: REQUIRED_PRODUCTION_SECRETS.slice(1).map((name) => ({
            name,
            type: "secret_text",
          })),
        },
      }),
      "secret with wrong binding type": makeNative({
        resources: {
          bindings: REQUIRED_PRODUCTION_SECRETS.map((name) => ({ name, type: "plain_text" })),
        },
      }),
      "absent native metadata": null,
    };
    for (const [name, native] of Object.entries(cases)) {
      test(`rejects ${name}`, () => {
        assert.throws(() => create(makeVerified(), undefined, native));
      });
    }
  });

  describe("inventory", () => {
    const hono = input("node_modules/hono/dist/hono.js", "node_modules/hono");
    const cases = {
      "missing Hono entry": { inputs: [hono], packages: [pkg("hono")] },
      "missing Hono package": { inputs: [input("src/worker.ts")], packages: [] },
      "Kit build input": {
        inputs: [input("src/worker.ts"), hono, input("web/src/routes/+page.svelte")],
        packages: [pkg("hono")],
      },
      "Kit output directory input": {
        inputs: [input("src/worker.ts"), hono, input(".svelte-kit/output/server/index.js")],
        packages: [pkg("hono")],
      },
      "nested Kit output directory input": {
        inputs: [input("src/worker.ts"), hono, input("x/.svelte-kit/generated/root.js")],
        packages: [pkg("hono")],
      },
      "SvelteKit package": {
        inputs: [input("src/worker.ts"), hono],
        packages: [pkg("hono"), pkg("@sveltejs/kit")],
      },
      "Svelte package": {
        inputs: [input("src/worker.ts"), hono],
        packages: [pkg("hono"), pkg("svelte")],
      },
      "tree-shaken SvelteKit package": {
        inputs: [
          input("src/worker.ts"),
          hono,
          input("node_modules/@sveltejs/kit/src/runtime/index.js", "node_modules/@sveltejs/kit", 0),
        ],
        packages: [pkg("hono"), pkg("@sveltejs/kit")],
      },
      "tree-shaken Svelte package": {
        inputs: [
          input("src/worker.ts"),
          hono,
          input("node_modules/svelte/src/index.js", "node_modules/svelte", 0),
        ],
        packages: [pkg("hono"), pkg("svelte")],
      },
      "unknown external": { absenceEligible: false, unknownExternals: ["some-external-pkg"] },
    };
    for (const [name, overrides] of Object.entries(cases)) {
      test(`rejects ${name}`, () => {
        assert.throws(() => create(makeVerified(overrides)));
      });
    }

    test("accepts unrelated packages whose names merely contain svelte", () => {
      const verified = makeVerified({
        inputs: [
          input("src/worker.ts"),
          input("node_modules/hono/dist/hono.js", "node_modules/hono"),
        ],
        packages: [pkg("hono"), pkg("not-svelte-kit")],
      });
      assert.equal(create(verified).versionId, VERSION);
    });
  });

  describe("deployed receipt", () => {
    const verified = makeVerified();
    const good = makeDeployed(verified);
    const cases = {
      "stale inventory digest": { ...good, inventorySha256: "c".repeat(64) },
      "stale bundle digest": { ...good, bundleSha256: "c".repeat(64) },
      "stale run id": { ...good, runId: "122" },
      "stale run attempt": { ...good, runAttempt: "2" },
      "stale source sha": { ...good, sourceSha: "d".repeat(40) },
      "stale version id": { ...good, versionId: OTHER_VERSION },
      "upload schema": { ...good, schema: "two.worker-bundle-upload.v1" },
      "unknown schema": { ...good, schema: "two.worker-bundle-deployment.v0" },
      "build-only evidence": { ...good, evidence: "build-only" },
      "missing evidence": { ...good, evidence: undefined },
      "extra field": { ...good, extra: true },
      "absent receipt": null,
    };
    for (const [name, deployed] of Object.entries(cases)) {
      test(`rejects ${name}`, () => {
        assert.throws(() => create(verified, deployed));
      });
    }
  });
});

describe("verifyPureHonoRollback", () => {
  const verified = makeVerified();
  const deployed = makeDeployed(verified);
  const native = makeNative();
  const pointer = createPureHonoRollback(verified, deployed, native);

  test("returns the pointer on exact equality", () => {
    assert.deepEqual(verifyPureHonoRollback({ ...pointer }, verified, deployed, native), pointer);
  });

  for (const [name, change] of Object.entries({
    "modified version": { versionId: OTHER_VERSION },
    "modified tag": { versionTag: `${SHA}-123-2` },
    "modified inventory digest": { inventorySha256: "c".repeat(64) },
    "modified bundle digest": { bundleSha256: "c".repeat(64) },
    "modified schema": { schema: "two.pure-hono-rollback.v0" },
    "expired pointer": { expiresAt: "2020-01-01T00:00:00.000Z" },
    "future expiry added": { expiresAt: "2999-01-01T00:00:00.000Z" },
    "extra field": { extra: true },
  })) {
    test(`rejects ${name}`, () => {
      assert.throws(() =>
        verifyPureHonoRollback({ ...pointer, ...change }, verified, deployed, native),
      );
    });
  }

  test("rejects an absent pointer", () => {
    assert.throws(() => verifyPureHonoRollback(null, verified, deployed, native));
  });

  test("rejects when the native version no longer matches", () => {
    assert.throws(() =>
      verifyPureHonoRollback(pointer, verified, deployed, makeNative({ id: OTHER_VERSION })),
    );
  });
});

describe("verifyPureHonoProvenance", () => {
  const REPO = "TogetherWeOwn/two-web-next";
  const WORKFLOW = ".github/workflows/deploy-production.yml";
  const RUN_URL = "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123";
  const ARTIFACT_NAME = `worker-bundle-production-${SHA}-123-1`;
  const pointer = create();

  const makeRun = (overrides = {}) => ({
    id: 123,
    run_attempt: 1,
    head_sha: SHA,
    repository: { id: 42, full_name: REPO },
    head_repository: { id: 42, full_name: REPO },
    path: WORKFLOW,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    html_url: RUN_URL,
    ...overrides,
  });
  const makeArtifact = (overrides = {}) => ({
    id: 456,
    name: ARTIFACT_NAME,
    expired: false,
    size_in_bytes: 1024,
    workflow_run: {
      id: 123,
      head_sha: SHA,
      head_branch: "main",
      repository_id: 42,
      head_repository_id: 42,
    },
    ...overrides,
  });
  const expected = {
    repository: REPO,
    workflow: WORKFLOW,
    runId: "123",
    runAttempt: "1",
    sourceSha: SHA,
    workflowSha: SHA,
    artifactId: "456",
    artifactName: ARTIFACT_NAME,
    runUrl: RUN_URL,
  };

  for (const event of ["workflow_dispatch", "workflow_run", "schedule"]) {
    test(`accepts a ${event} run and returns sanitized provenance`, () => {
      assert.deepEqual(
        verifyPureHonoProvenance(pointer, makeRun({ event }), makeArtifact()),
        expected,
      );
    });
  }

  test("accepts a workflow tip sha that differs from the candidate pointer sha", () => {
    const tip = "d".repeat(40);
    const artifact = makeArtifact();
    artifact.workflow_run = { ...artifact.workflow_run, head_sha: tip };
    assert.deepEqual(verifyPureHonoProvenance(pointer, makeRun({ head_sha: tip }), artifact), {
      ...expected,
      sourceSha: SHA,
      workflowSha: tip,
    });
  });

  const runCases = {
    "wrong run id": { id: 124 },
    "string run id": { id: "123" },
    "missing run id": { id: undefined },
    "null run id": { id: null },
    "fractional run id": { id: 123.5 },
    "stale attempt": { run_attempt: 2 },
    "string attempt": { run_attempt: "1" },
    "missing attempt": { run_attempt: undefined },
    "head sha differing from artifact workflow run sha": { head_sha: "d".repeat(40) },
    "short head sha": { head_sha: "abc123" },
    "uppercase head sha": { head_sha: "A".repeat(40) },
    "non-hex head sha": { head_sha: "g".repeat(40) },
    "null head sha": { head_sha: null },
    "missing head sha": { head_sha: undefined },
    "fork repository name": { repository: { id: 42, full_name: "attacker/two-web-next" } },
    "fork head repository name": {
      head_repository: { id: 42, full_name: "attacker/two-web-next" },
    },
    "different repository id": { repository: { id: 43, full_name: REPO } },
    "different head repository id": { head_repository: { id: 43, full_name: REPO } },
    "missing repository id": { repository: { full_name: REPO } },
    "missing head repository id": { head_repository: { full_name: REPO } },
    "string repository id": { repository: { id: "42", full_name: REPO } },
    "null repository": { repository: null },
    "null head repository": { head_repository: null },
    "missing head repository": { head_repository: undefined },
    "wrong workflow path": { path: ".github/workflows/deploy-staging.yml" },
    "missing workflow path": { path: undefined },
    "wrong branch": { head_branch: "feature" },
    "null branch": { head_branch: null },
    "pending status": { status: "in_progress" },
    "queued status": { status: "queued" },
    "failed conclusion": { conclusion: "failure" },
    "cancelled conclusion": { conclusion: "cancelled" },
    "null conclusion": { conclusion: null },
    "pull request event": { event: "pull_request" },
    "pull request target event": { event: "pull_request_target" },
    "push event": { event: "push" },
    "missing event": { event: undefined },
    "wrong run url": {
      html_url: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/124",
    },
    "foreign run url": {
      html_url: "https://example.com/TogetherWeOwn/two-web-next/actions/runs/123",
    },
    "missing run url": { html_url: undefined },
  };
  for (const [name, change] of Object.entries(runCases)) {
    test(`rejects a run with ${name}`, () => {
      assert.throws(() => verifyPureHonoProvenance(pointer, makeRun(change), makeArtifact()));
    });
  }

  const artifactCases = {
    "zero id": { id: 0 },
    "negative id": { id: -1 },
    "fractional id": { id: 1.5 },
    "unsafe integer id": { id: Number.MAX_SAFE_INTEGER + 1 },
    "string id": { id: "456" },
    "missing id": { id: undefined },
    "null id": { id: null },
    "stale sha in name": { name: `worker-bundle-production-${"d".repeat(40)}-123-1` },
    "stale run in name": { name: `worker-bundle-production-${SHA}-122-1` },
    "stale attempt in name": { name: `worker-bundle-production-${SHA}-123-2` },
    "wrong name prefix": { name: `worker-bundle-staging-${SHA}-123-1` },
    "missing name": { name: undefined },
    "expired artifact": { expired: true },
    "string expired": { expired: "false" },
    "missing expired": { expired: undefined },
    "null expired": { expired: null },
    "zero size": { size_in_bytes: 0 },
    "negative size": { size_in_bytes: -1 },
    "fractional size": { size_in_bytes: 1.5 },
    "unsafe size": { size_in_bytes: Number.MAX_SAFE_INTEGER + 1 },
    "string size": { size_in_bytes: "1024" },
    "missing size": { size_in_bytes: undefined },
    "null workflow run": { workflow_run: null },
    "missing workflow run": { workflow_run: undefined },
    "wrong workflow run id": {
      workflow_run: { ...makeArtifact().workflow_run, id: 124 },
    },
    "stale workflow run sha": {
      workflow_run: { ...makeArtifact().workflow_run, head_sha: "d".repeat(40) },
    },
    "wrong workflow run branch": {
      workflow_run: { ...makeArtifact().workflow_run, head_branch: "feature" },
    },
    "wrong workflow run repository id": {
      workflow_run: { ...makeArtifact().workflow_run, repository_id: 43 },
    },
    "wrong workflow run head repository id": {
      workflow_run: { ...makeArtifact().workflow_run, head_repository_id: 43 },
    },
    "missing workflow run repository id": {
      workflow_run: { ...makeArtifact().workflow_run, repository_id: undefined },
    },
    "null workflow run head repository id": {
      workflow_run: { ...makeArtifact().workflow_run, head_repository_id: null },
    },
  };
  for (const [name, change] of Object.entries(artifactCases)) {
    test(`rejects an artifact with ${name}`, () => {
      assert.throws(() => verifyPureHonoProvenance(pointer, makeRun(), makeArtifact(change)));
    });
  }

  test("rejects absent run and artifact metadata", () => {
    assert.throws(() => verifyPureHonoProvenance(pointer, null, makeArtifact()));
    assert.throws(() => verifyPureHonoProvenance(pointer, makeRun(), null));
  });

  test("rejects a pointer for a different run", () => {
    assert.throws(() =>
      verifyPureHonoProvenance({ ...pointer, runId: "122" }, makeRun(), makeArtifact()),
    );
  });
});

describe("readPureHonoVersion", () => {
  const FAILURE = "native pure-Hono version lookup failed";
  const MARKER = "SECRET_MARKER_8f3a1c";

  test("runs the exact wrangler command and returns the parsed object", () => {
    const calls = [];
    const native = makeNative();
    const execute = (...args) => {
      calls.push(args);
      return JSON.stringify(native);
    };
    assert.deepEqual(readPureHonoVersion(VERSION, execute), native);
    assert.deepEqual(calls, [
      [
        "npx",
        ["wrangler", "versions", "view", VERSION, "--name", "two-web-next-production", "--json"],
        {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ],
    ]);
  });

  for (const [name, id] of Object.entries({
    "uppercase UUID": "AAAAAAAA-2222-4333-8444-555555555555",
    "empty string": "",
    "non-UUID": "not-a-uuid",
    "option-like": "--name",
    "trailing newline": `${VERSION}\n`,
    "leading space": ` ${VERSION}`,
    "shell metacharacters": `${VERSION};id`,
    "appended argument": `${VERSION} --json`,
    "non-string": null,
  })) {
    test(`rejects ${name} without invoking the child process`, () => {
      let called = false;
      const execute = () => {
        called = true;
        return "{}";
      };
      assert.throws(() => readPureHonoVersion(id, execute));
      assert.equal(called, false);
    });
  }

  test("throws the fixed failure for malformed JSON without echoing the body", () => {
    const execute = () => `{not json ${MARKER}`;
    assert.throws(
      () => readPureHonoVersion(VERSION, execute),
      (error) => {
        assert.equal(error.message, FAILURE);
        assert.ok(!String(error.message).includes(MARKER));
        return true;
      },
    );
  });

  test("never surfaces child process error output", () => {
    const execute = () => {
      const error = new Error(`Command failed: ${MARKER}`);
      error.stdout = MARKER;
      error.stderr = MARKER;
      throw error;
    };
    assert.throws(
      () => readPureHonoVersion(VERSION, execute),
      (error) => {
        assert.equal(error.message, FAILURE);
        assert.ok(!String(error.stack ?? "").includes(MARKER));
        assert.ok(!JSON.stringify(error).includes(MARKER));
        return true;
      },
    );
  });
});

describe("production workflow wiring", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const stepStart = (name) => workflow.indexOf(`      - name: ${name}\n`);
  const BIND = "Bind bundle evidence to the smoke-verified promoted version";
  const CAPTURE = "Capture native pure-Hono rollback evidence";
  const ARCHIVE = "Archive production bundle inventory and receipts";

  test("captures native rollback evidence between the bind and archive steps", () => {
    const bind = stepStart(BIND);
    const capture = stepStart(CAPTURE);
    const archive = stepStart(ARCHIVE);
    assert.ok(bind >= 0 && capture >= 0 && archive >= 0);
    assert.ok(bind < capture && capture < archive);
    assert.equal(workflow.indexOf(`      - name: ${CAPTURE}\n`, capture + 1), -1);
  });

  test("runs the capture command with the build sha and production credentials", () => {
    const capture = stepStart(CAPTURE);
    const block = workflow.slice(capture, stepStart(ARCHIVE));
    assert.match(
      block,
      /run: node workflow-tip\/ci\/pure-hono-rollback\.mjs capture dist-production dist-production\/pure-hono-rollback\.json\n/,
    );
    assert.match(block, /BUILD_SHA: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
    assert.match(
      block,
      /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_API_TOKEN \}\}/,
    );
    assert.match(
      block,
      /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_ACCOUNT_ID \}\}/,
    );
  });
});
