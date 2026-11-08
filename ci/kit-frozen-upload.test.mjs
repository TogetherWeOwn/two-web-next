import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REQUIRED_PRODUCTION_SECRETS } from "./check-production-secrets.mjs";
import { createKitFrozenIntent } from "./kit-frozen-intent.mjs";
import { createKitFrozenUploadReceipt } from "./kit-frozen-upload.mjs";

const SECRET = "SENTINEL-value-do-not-leak";
const VERSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_ID = "ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const h = (c) => c.repeat(64);
const clone = (v) => structuredClone(v);

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
  const intent = createKitFrozenIntent(inputs, tool, multipart);
  const records = [
    { version: 1, type: "wrangler-session", wrangler_version: "4.156.1" },
    {
      version: 1,
      type: "version-upload",
      worker_name: inputs.target,
      worker_tag: "tag",
      version_id: VERSION_ID,
      preview_url: SECRET,
      worker_name_overridden: false,
    },
  ];
  const nativeVersion = {
    id: VERSION_ID,
    annotations: { "workers/tag": `${inputs.sourceSha}-${inputs.runId}-${inputs.runAttempt}` },
    resources: {
      bindings: [
        ...REQUIRED_PRODUCTION_SECRETS.map((name) => ({ name, type: "secret_text" })),
        { name: "PLAIN", type: "plain_text", text: SECRET },
      ],
    },
  };
  return { inputs, tool, multipart, intent, records, nativeVersion };
}

const run = (f) =>
  createKitFrozenUploadReceipt(f.inputs, f.tool, f.multipart, f.intent, f.records, f.nativeVersion);
const upload = (f) => f.records.find((r) => r.type === "version-upload");

test("positive control returns the exact association receipt", () => {
  const f = fixture();
  const receipt = run(f);
  assert.deepEqual(receipt, {
    schema: "two.kit-frozen-upload.v1",
    evidence: "native-version-associated-inputs-only",
    sourceSha: f.inputs.sourceSha,
    runId: "123456",
    runAttempt: "2",
    target: "two-web-next-production",
    intentSha256: f.intent.intentSha256,
    versionTag: `${f.inputs.sourceSha}-123456-2`,
    versionId: VERSION_ID,
  });
  assert.ok(!JSON.stringify(receipt).includes(SECRET));
});

test("other native log record types are allowed and inputs are not mutated", () => {
  const f = fixture();
  f.records.push({ version: 1, type: "output", note: "extra" }, { version: 1, type: "deploy" });
  const before = clone(f);
  const receipt = run(f);
  assert.deepEqual(f, before);
  assert.deepEqual(run(clone(f)), receipt);
});

const rejections = {
  "tampered intent digest": (f) => (f.intent.intentSha256 = h("0")),
  "tampered intent field": (f) => (f.intent.runId = "999"),
  "tampered intent invocation": (f) => (f.intent.invocation.sourceMaps = true),
  "resealed tampered intent": (f) => {
    const { intentSha256: _drop, ...rest } = f.intent;
    rest.assetInputsSha256 = h("9");
    f.intent = { ...rest, intentSha256: sha(JSON.stringify(rest)) };
  },
  "missing intent": (f) => (f.intent = undefined),
  "changed run context": (f) => (f.inputs.runAttempt = "3"),
  "changed source sha": (f) => (f.inputs.sourceSha = "f".repeat(40)),
  "changed tool lock": (f) => (f.tool.locks[0].sha256 = h("1")),
  "changed multipart metadata": (f) => (f.multipart.metadata.sha256 = h("2")),
  "changed worker module": (f) => {
    f.multipart.worker.sha256 = h("3");
    f.inputs.workerSha256 = h("3");
  },
  "changed config evidence": (f) => (f.multipart.config.configSha256 = h("4")),
  "changed asset tree": (f) => (f.inputs.assets.treeSha256 = h("5")),
  "records not an array": (f) => (f.records = { type: "version-upload" }),
  "no records": (f) => (f.records = []),
  "no upload record": (f) => (f.records = f.records.filter((r) => r.type !== "version-upload")),
  "duplicate upload record": (f) => f.records.push(clone(upload(f))),
  "duplicate with other id": (f) => f.records.push({ ...clone(upload(f)), version_id: OTHER_ID }),
  "null record": (f) => f.records.push(null),
  "string record": (f) => f.records.push("version-upload"),
  "array record": (f) => f.records.push([]),
  "missing record type": (f) => f.records.push({ note: SECRET }),
  "too many records": (f) => {
    for (let i = 0; i < 128; i += 1) f.records.push({ type: "output" });
  },
  "oversized native response": (f) => (f.nativeVersion.extra = "x".repeat(1024 * 1024)),
  "record schema version": (f) => (upload(f).version = 2),
  "record schema missing": (f) => delete upload(f).version,
  "wrong target": (f) => (upload(f).worker_name = "two-web-next"),
  "missing worker name": (f) => delete upload(f).worker_name,
  "wrangler environment set": (f) => (upload(f).wrangler_environment = "production"),
  "name overridden": (f) => (upload(f).worker_name_overridden = true),
  "name override missing": (f) => delete upload(f).worker_name_overridden,
  "name override truthy string": (f) => (upload(f).worker_name_overridden = "false"),
  "uuid uppercase": (f) => (upload(f).version_id = VERSION_ID.toUpperCase()),
  "uuid too short": (f) => (upload(f).version_id = VERSION_ID.slice(1)),
  "uuid with suffix": (f) => (upload(f).version_id = `${VERSION_ID}\n`),
  "uuid not string": (f) => (upload(f).version_id = 12),
  "uuid missing": (f) => delete upload(f).version_id,
  "native missing": (f) => (f.nativeVersion = null),
  "native id differs": (f) => (f.nativeVersion.id = OTHER_ID),
  "native id missing": (f) => delete f.nativeVersion.id,
  "native tag differs": (f) => (f.nativeVersion.annotations["workers/tag"] = "other"),
  "native tag has wrong attempt": (f) =>
    (f.nativeVersion.annotations["workers/tag"] = `${f.inputs.sourceSha}-123456-1`),
  "native tag with suffix": (f) => (f.nativeVersion.annotations["workers/tag"] += `-${SECRET}`),
  "native tag missing": (f) => delete f.nativeVersion.annotations,
  "native missing one secret": (f) => {
    f.nativeVersion.resources.bindings = f.nativeVersion.resources.bindings.filter(
      (b) => b.name !== REQUIRED_PRODUCTION_SECRETS[0],
    );
  },
  "native secret has wrong type": (f) => {
    f.nativeVersion.resources.bindings[0].type = "plain_text";
  },
  "native bindings missing": (f) => delete f.nativeVersion.resources,
  "native malformed binding": (f) => f.nativeVersion.resources.bindings.push({ name: SECRET }),
};

for (const [name, mutate] of Object.entries(rejections)) {
  test(`rejects ${name} with a fixed diagnostic`, () => {
    const f = fixture();
    mutate(f);
    // Plant sentinels in attacker-controlled fields; none may reach a message.
    if (Array.isArray(f.records)) f.records.push({ version: 1, type: "output", note: SECRET });
    f.nativeVersion = f.nativeVersion && { ...f.nativeVersion, note: SECRET };
    assert.throws(
      () => run(f),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(SECRET), "diagnostic echoed raw input");
        assert.ok(!error.message.includes(VERSION_ID), "diagnostic echoed version id");
        assert.ok(!error.message.includes(f.inputs.sourceSha), "diagnostic echoed source sha");
        return true;
      },
    );
  });
}

test("rejects missing arguments", () => {
  const f = fixture();
  const args = [f.inputs, f.tool, f.multipart, f.intent, f.records, f.nativeVersion];
  for (let i = 0; i < args.length; i += 1) {
    const copy = [...args];
    copy[i] = undefined;
    assert.throws(() => createKitFrozenUploadReceipt(...copy));
  }
});

test("Actions runs the upload association tests from the source workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const verified = workflow.indexOf(
    "node ci/kit-frozen-inputs.mjs verify artifacts/kit-frozen-inputs",
  );
  const tests = workflow.indexOf("node --test ci/kit-frozen-upload.test.mjs");
  const archive = workflow.indexOf("      - name: Production Kit bundle build evidence");
  assert.ok(verified >= 0 && tests > verified && archive > tests);
  const repeated = workflow.indexOf("node --test ci/kit-frozen-upload.test.mjs", tests + 1);
  assert.equal(repeated, -1);
});
