import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createKitFrozenIntent } from "./kit-frozen-intent.mjs";

const SECRET = "SENTINEL-value-do-not-leak";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const h = (c) => c.repeat(64);
const digest = (v) => sha(JSON.stringify(v));

function fixture() {
  const locks = [
    { path: "package-lock.json", bytes: 10, sha256: h("a") },
    { path: "web/package-lock.json", bytes: 20, sha256: h("b") },
  ];
  const inputs = {
    schema: "two.kit-frozen-inputs.v1",
    target: "two-web-next-production",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    runId: "123456",
    runAttempt: "2",
    workerSha256: h("c"),
    assets: { schema: "two.kit-complete-assets.v1", treeSha256: h("d") },
    sourceConfig: { schema: "two.kit-source-config.v1", config: {} },
    files: locks.map((l) => ({ ...l, path: `source/${l.path}` })),
  };
  const tool = {
    schema: "two.kit-wrangler-tool.v1",
    name: "wrangler",
    version: "4.156.1",
    entry: "node_modules/wrangler/bin/wrangler.js",
    locks: locks.map((l) => ({ ...l })),
  };
  // Real projection of verifyKitMultipartModules(raw, worker, sourceConfig).
  const multipart = {
    schema: "two.kit-multipart-modules.v1",
    evidence: "dry-run-module-envelope-only",
    worker: {
      name: "worker.js",
      mime: "application/javascript+module",
      bytes: 100,
      sha256: inputs.workerSha256,
    },
    metadata: { bytes: 50, sha256: h("e"), bindings: [{ name: "ZED", type: "plain_text" }] },
    config: {
      schema: "two.kit-multipart-config.v1",
      evidence: "serialized-dry-run-config-fields-only",
      configSha256: h("f"),
    },
  };
  return { inputs, tool, multipart };
}

const make = (f) => createKitFrozenIntent(f.inputs, f.tool, f.multipart);
const clone = (v) => structuredClone(v);

test("descriptor is exact and digests bind each input", () => {
  const f = fixture();
  const intent = make(f);
  const { intentSha256, ...rest } = intent;
  assert.deepEqual(intent, {
    schema: "two.kit-frozen-intent.v1",
    evidence: "prepared-upload-inputs-only",
    sourceSha: f.inputs.sourceSha,
    runId: "123456",
    runAttempt: "2",
    target: "two-web-next-production",
    snapshotSha256: digest(f.inputs),
    toolSha256: digest(f.tool),
    workerSha256: f.inputs.workerSha256,
    assetInputsSha256: h("d"),
    serializedConfigSha256: h("f"),
    multipartSha256: digest(f.multipart),
    invocation: {
      command: ["versions", "upload", "--no-bundle"],
      entry: "build/worker.js",
      config: "source/web/wrangler.production.jsonc",
      assets: "adapter",
      environment: "default",
      nameOverride: false,
      sourceMaps: false,
    },
    intentSha256,
  });
  assert.equal(intentSha256, digest(rest));
});

test("construction is deterministic and does not mutate inputs", () => {
  const f = fixture();
  const before = clone(f);
  const a = make(f);
  assert.deepEqual(f, before);
  assert.deepEqual(make(clone(f)), a);
  assert.equal(make(f).intentSha256, a.intentSha256);
});

test("bound bytes change the intent digest", () => {
  const base = make(fixture());
  const mutations = [
    (f) => (f.inputs.sourceConfig.config = { extra: 1 }),
    (f) => (f.inputs.runId = "123457"),
    (f) => (f.tool.locks[0].sha256 = h("1")),
    (f) => (f.multipart.metadata.sha256 = h("2")),
    (f) => (f.multipart.metadata.bytes = 51),
    (f) => (f.multipart.worker.bytes = 101),
    (f) => (f.multipart.config.configSha256 = h("3")),
    (f) => (f.inputs.assets.treeSha256 = h("4")),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    // Keep the lock-file cross-check consistent where the mutation targets a lock.
    f.inputs.files[0].sha256 = f.tool.locks[0].sha256;
    assert.notEqual(make(f).intentSha256, base.intentSha256);
  }
});

const rejections = {
  "inputs schema": (f) => (f.inputs.schema = "two.kit-frozen-inputs.v0"),
  "inputs target": (f) => (f.inputs.target = "two-web-next-staging"),
  "short source sha": (f) => (f.inputs.sourceSha = "abc123"),
  "uppercase source sha": (f) => (f.inputs.sourceSha = "A".repeat(40)),
  "run id zero": (f) => (f.inputs.runId = "0"),
  "run id leading zero": (f) => (f.inputs.runId = "012"),
  "run id number": (f) => (f.inputs.runId = 12),
  "run attempt text": (f) => (f.inputs.runAttempt = "1x"),
  "worker sha uppercase": (f) => (f.inputs.workerSha256 = h("A")),
  "assets schema": (f) => (f.inputs.assets.schema = "other"),
  "assets tree sha": (f) => (f.inputs.assets.treeSha256 = "short"),
  "source config schema": (f) => (f.inputs.sourceConfig.schema = "other"),
  "source config body": (f) => (f.inputs.sourceConfig.config = null),
  "tool schema": (f) => (f.tool.schema = "other"),
  "tool name": (f) => (f.tool.name = "npx"),
  "tool version": (f) => (f.tool.version = "4.156.2"),
  "tool entry": (f) => (f.tool.entry = "../wrangler.js"),
  "tool entry absolute": (f) => (f.tool.entry = "/usr/bin/wrangler"),
  "lock count": (f) => f.tool.locks.pop(),
  "lock path": (f) => (f.tool.locks[1].path = "other/package-lock.json"),
  "lock bytes": (f) => (f.tool.locks[0].bytes = 0),
  "lock sha": (f) => (f.tool.locks[0].sha256 = "xyz"),
  "lock drift sha": (f) => (f.inputs.files[1].sha256 = h("9")),
  "lock drift bytes": (f) => (f.inputs.files[0].bytes = 11),
  "lock missing from files": (f) => f.inputs.files.pop(),
  "duplicate frozen lock": (f) => f.inputs.files.push(clone(f.inputs.files[0])),
  "duplicate tool lock": (f) => f.tool.locks.push(clone(f.tool.locks[0])),
  "multipart schema": (f) => (f.multipart.schema = "other"),
  "worker name": (f) => (f.multipart.worker.name = "index.js"),
  "worker mime": (f) => (f.multipart.worker.mime = "text/javascript"),
  "worker bytes": (f) => (f.multipart.worker.bytes = 0),
  "worker sha differs": (f) => (f.multipart.worker.sha256 = h("7")),
  "config missing": (f) => delete f.multipart.config,
  "config schema": (f) => (f.multipart.config.schema = "other"),
  "config evidence": (f) => (f.multipart.config.evidence = "full-config"),
  "config sha": (f) => (f.multipart.config.configSha256 = "nope"),
  "metadata bytes": (f) => (f.multipart.metadata.bytes = 0),
  "metadata sha": (f) => (f.multipart.metadata.sha256 = h("G")),
};

for (const [name, mutate] of Object.entries(rejections)) {
  test(`rejects ${name} with a fixed diagnostic`, () => {
    const f = fixture();
    mutate(f);
    // Keep each mutation independent; a second invalid tool field would mask it.
    f.multipart.metadata.secret = SECRET;
    assert.throws(
      () => make(f),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(SECRET), "diagnostic echoed raw input");
        return true;
      },
    );
  });
}

test("rejects missing arguments", () => {
  const f = fixture();
  assert.throws(() => createKitFrozenIntent(undefined, f.tool, f.multipart));
  assert.throws(() => createKitFrozenIntent(f.inputs, null, f.multipart));
  assert.throws(() => createKitFrozenIntent(f.inputs, f.tool, undefined));
});
