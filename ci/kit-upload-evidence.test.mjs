// Standalone node:test fixtures for the Kit upload and deployment receipts. The
// native receipt links the upload to verified LOCAL bytes. It is not proof of
// remote byte readback, asset selection, or package absence.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  kitDeploymentReceipt,
  kitUploadReceipt,
  verifyKitRehearsal,
} from "./kit-upload-evidence.mjs";
import { createKitRehearsal } from "./kit-upload-rehearsal.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const SHA = "a".repeat(40);
const VERSION = "11111111-2222-4333-8444-555555555555";
const LETTER_VERSION = "abcdefab-2222-4333-8444-555555555555";
const OTHER_VERSION = "99999999-2222-4333-8444-555555555555";
const TARGET = "two-web-next-production";
const context = { sourceSha: SHA, runId: "123", runAttempt: "1" };

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kit-upload-evidence-"));
  roots.push(root);
  for (const path of [
    "package-lock.json",
    "web/package-lock.json",
    "web/wrangler.production.jsonc",
    "web/worker.js",
    "web/_headers",
    "web/.svelte-kit/cloudflare/_worker.js",
    "web/.svelte-kit/cloudflare/_headers",
    "web/.svelte-kit/cloudflare/_routes.json",
    "web/.svelte-kit/cloudflare/_app/version.json",
    "web/.svelte-kit/cloudflare/_app/immutable/chunks/a.js",
  ])
    put(root, path, `fixture ${path}\n`);
  put(root, "dist/worker.js", "console.log('worker');\n");
  put(root, "dist/bundle-meta.json", '{"inputs":{},"outputs":{}}\n');
  put(root, "replay/worker.js", "console.log('worker');\n");
  const paths = {
    build: join(root, "dist"),
    replay: join(root, "replay"),
    saved: join(root, "rehearsal.json"),
  };
  const saved = createKitRehearsal(root, paths.build, paths.replay, context);
  writeFileSync(paths.saved, `${JSON.stringify(saved, null, 2)}\n`);
  return { root, ...paths, saved };
}

function verifier(f) {
  return (ctx = context) => verifyKitRehearsal(f.root, f.build, f.replay, savedPath(f), ctx);
}
const savedPath = (f) => join(f.root, "rehearsal.json");

function record(overrides = {}) {
  return {
    type: "version-upload",
    version: 1,
    worker_name: TARGET,
    worker_name_overridden: false,
    version_id: VERSION,
    ...overrides,
  };
}

function verifiedFixture() {
  const f = fixture();
  return { f, verified: verifier(f)() };
}

test("Actions reverifies the built receipt and runs the receipt fixture tests", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes('BUILD_SHA="$GITHUB_SHA" node ci/kit-upload-evidence.mjs verify'));
  assert.ok(
    workflow.includes(
      "node --test ci/worker-bundle-evidence.test.mjs ci/kit-upload-evidence.test.mjs",
    ),
  );
});

describe("verifyKitRehearsal", () => {
  test("recomputes the rehearsal and returns it with its digest", () => {
    const { f, verified } = verifiedFixture();
    assert.deepEqual(verified.rehearsal, f.saved);
    assert.equal(verified.rehearsalSha256, sha256(readFileSync(savedPath(f))));
    assert.equal(verified.rehearsal.sourceSha, SHA);
    assert.equal(verified.rehearsal.workerSha256, sha256("console.log('worker');\n"));
  });

  for (const [label, ctx] of [
    ["source SHA", { ...context, sourceSha: "b".repeat(40) }],
    ["run ID", { ...context, runId: "124" }],
    ["run attempt", { ...context, runAttempt: "2" }],
  ]) {
    test(`rejects a stale ${label}`, () => {
      const f = fixture();
      assert.throws(() => verifier(f)(ctx));
    });
  }

  test("rejects a missing saved receipt", () => {
    const f = fixture();
    rmSync(savedPath(f));
    assert.throws(() => verifier(f)());
  });

  for (const [label, content] of [
    ["empty", ""],
    ["malformed JSON", "{not json"],
    ["JSON null", "null\n"],
    ["an empty object", "{}\n"],
  ]) {
    test(`rejects a saved receipt that is ${label}`, () => {
      const f = fixture();
      writeFileSync(savedPath(f), content);
      assert.throws(() => verifier(f)());
    });
  }

  test("rejects a saved receipt with an edited field", () => {
    const f = fixture();
    writeFileSync(
      savedPath(f),
      JSON.stringify({ ...f.saved, workerSha256: sha256("other") }, null, 2),
    );
    assert.throws(() => verifier(f)());
  });

  test("rejects a saved receipt with an extra property", () => {
    const f = fixture();
    writeFileSync(savedPath(f), JSON.stringify({ ...f.saved, extra: true }, null, 2));
    assert.throws(() => verifier(f)());
  });

  const sameSize = [
    ["Worker", "dist/worker.js", "console.log('WORKER');\n"],
    ["replay Worker", "replay/worker.js", "console.log('WORKER');\n"],
    [
      "asset",
      "web/.svelte-kit/cloudflare/_app/immutable/chunks/a.js",
      "fixture web/.svelte-kit/cloudflare/_app/immutable/chunks/X.js\n",
    ],
    [
      "control file",
      "web/.svelte-kit/cloudflare/_headers",
      "FIXTURE web/.svelte-kit/cloudflare/_headers\n",
    ],
    ["Wrangler config", "web/wrangler.production.jsonc", "FIXTURE web/wrangler.production.jsonc\n"],
    ["root lockfile", "package-lock.json", "FIXTURE package-lock.json\n"],
    ["web lockfile", "web/package-lock.json", "FIXTURE web/package-lock.json\n"],
  ];
  for (const [label, path, content] of sameSize) {
    test(`rejects a same-size changed ${label}`, () => {
      const f = fixture();
      const before = readFileSync(join(f.root, path));
      assert.equal(Buffer.byteLength(content), before.length, "fixture must keep size");
      put(f.root, path, content);
      assert.throws(() => verifier(f)());
    });
  }

  test("rejects an added asset", () => {
    const f = fixture();
    put(f.root, "web/.svelte-kit/cloudflare/_app/immutable/chunks/new.js", "x");
    assert.throws(() => verifier(f)());
  });

  test("rejects an added hidden control file", () => {
    const f = fixture();
    put(f.root, "web/.svelte-kit/cloudflare/.assetsignore", "_worker.js\n");
    assert.throws(() => verifier(f)());
  });

  test("rejects a removed asset", () => {
    const f = fixture();
    rmSync(join(f.root, "web/.svelte-kit/cloudflare/_routes.json"));
    assert.throws(() => verifier(f)());
  });
});

describe("kitUploadReceipt", () => {
  test("binds one native version-upload record to the verified bytes", () => {
    const { verified } = verifiedFixture();
    const { rehearsal, rehearsalSha256 } = verified;
    const receipt = kitUploadReceipt(verified, [{ type: "noise" }, record()]);
    assert.deepEqual(receipt, {
      schema: "two.kit-worker-upload.v1",
      sourceSha: SHA,
      runId: "123",
      runAttempt: "1",
      target: TARGET,
      environment: "production",
      rehearsalSha256,
      workerSha256: rehearsal.workerSha256,
      adapterTreeSha256: sha256(JSON.stringify(rehearsal.trees.assets)),
      versionId: VERSION,
    });
  });

  test("accepts the record with wrangler_environment explicitly undefined", () => {
    const { verified } = verifiedFixture();
    const receipt = kitUploadReceipt(verified, [record({ wrangler_environment: undefined })]);
    assert.equal(receipt.versionId, VERSION);
  });

  const rejected = [
    ["no records", []],
    ["no upload record", [{ type: "deploy", version: 1 }]],
    ["duplicate records", [record(), record({ version_id: OTHER_VERSION })]],
    ["identical duplicate records", [record(), record()]],
    ["wrong record type", [record({ type: "version-deploy" })]],
    ["unknown schema version", [record({ version: 2 })]],
    ["missing schema version", [record({ version: undefined })]],
    ["wrong Worker", [record({ worker_name: "two-web-next" })]],
    ["staging Worker", [record({ worker_name: "two-web-next-staging" })]],
    ["missing Worker", [record({ worker_name: undefined })]],
    ["named environment", [record({ wrangler_environment: "production" })]],
    ["empty environment", [record({ wrangler_environment: "" })]],
    ["null environment", [record({ wrangler_environment: null })]],
    ["name override", [record({ worker_name_overridden: true })]],
    ["missing name override flag", [record({ worker_name_overridden: undefined })]],
    ["missing version ID", [record({ version_id: undefined })]],
    ["malformed version ID", [record({ version_id: "not-a-uuid" })]],
    ["uppercase version ID", [record({ version_id: LETTER_VERSION.toUpperCase() })]],
    ["padded version ID", [record({ version_id: ` ${VERSION}` })]],
    ["non-string version ID", [record({ version_id: 1 })]],
  ];
  for (const [label, records] of rejected) {
    test(`rejects ${label}`, () => {
      const { verified } = verifiedFixture();
      assert.throws(() => kitUploadReceipt(verified, records));
    });
  }

  test("receipt carries no remote readback, asset selection, or absence claim", () => {
    const { verified } = verifiedFixture();
    const receipt = kitUploadReceipt(verified, [record()]);
    for (const key of ["absenceEligible", "assetSelection", "remoteSha256", "evidence"])
      assert.equal(receipt[key], undefined, key);
  });
});

describe("kitDeploymentReceipt", () => {
  function uploaded() {
    const { verified } = verifiedFixture();
    return { verified, upload: kitUploadReceipt(verified, [record()]) };
  }

  test("promotes exactly the uploaded version", () => {
    const { verified, upload } = uploaded();
    const deployed = kitDeploymentReceipt(verified, upload, VERSION);
    assert.deepEqual(deployed, {
      ...upload,
      schema: "two.kit-worker-deployment.v1",
      evidence: "promoted-and-smoke-verified",
    });
  });

  test("does not mutate the upload receipt", () => {
    const { verified, upload } = uploaded();
    const copy = structuredClone(upload);
    kitDeploymentReceipt(verified, upload, VERSION);
    assert.deepEqual(upload, copy);
  });

  test("rejects a deployed version that differs from the upload", () => {
    const { verified, upload } = uploaded();
    assert.throws(() => kitDeploymentReceipt(verified, upload, OTHER_VERSION));
  });

  for (const [label, value] of [
    ["missing", undefined],
    ["malformed", "latest"],
    ["uppercase", LETTER_VERSION.toUpperCase()],
    ["empty", ""],
  ]) {
    test(`rejects a ${label} promoted version ID`, () => {
      const { verified, upload } = uploaded();
      assert.throws(() => kitDeploymentReceipt(verified, upload, value));
    });
  }

  for (const field of [
    "rehearsalSha256",
    "workerSha256",
    "adapterTreeSha256",
    "sourceSha",
    "runId",
    "runAttempt",
  ]) {
    test(`rejects an upload with a stale ${field}`, () => {
      const { verified, upload } = uploaded();
      const stale = { ...upload, [field]: field === "sourceSha" ? "c".repeat(40) : "0" };
      assert.throws(() => kitDeploymentReceipt(verified, stale, VERSION));
    });
  }

  for (const [label, change] of [
    ["schema", { schema: "two.kit-worker-deployment.v1" }],
    ["target", { target: "two-web-next" }],
    ["environment", { environment: "staging" }],
    ["unknown property", { extra: true }],
    ["evidence property", { evidence: "promoted-and-smoke-verified" }],
  ]) {
    test(`rejects an upload with a wrong ${label}`, () => {
      const { verified, upload } = uploaded();
      assert.throws(() => kitDeploymentReceipt(verified, { ...upload, ...change }, VERSION));
    });
  }

  test("rejects an upload missing a property", () => {
    const { verified, upload } = uploaded();
    const { workerSha256: _removed, ...partial } = upload;
    assert.throws(() => kitDeploymentReceipt(verified, partial, VERSION));
  });

  test("rejects an upload bound to a different rehearsal of changed bytes", () => {
    const { upload } = uploaded();
    const other = fixture();
    put(other.root, "dist/worker.js", "console.log('WORKER');\n");
    put(other.root, "replay/worker.js", "console.log('WORKER');\n");
    const changed = createKitRehearsal(other.root, other.build, other.replay, context);
    writeFileSync(savedPath(other), `${JSON.stringify(changed, null, 2)}\n`);
    assert.throws(() => kitDeploymentReceipt(verifier(other)(), upload, VERSION));
  });
});
