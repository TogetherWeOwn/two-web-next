// Prepared input association only. No upload, remote identity or release authority.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "./worker-bundle-evidence.mjs";

const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function createKitFrozenIntent(inputs, tool, multipart) {
  assert.ok(
    inputs?.schema === "two.kit-frozen-inputs.v1" &&
      inputs.target === "two-web-next-production" &&
      typeof inputs.sourceSha === "string" &&
      /^[0-9a-f]{40}$/.test(inputs.sourceSha) &&
      [inputs.runId, inputs.runAttempt].every(
        (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value),
      ) &&
      digest(inputs.workerSha256) &&
      inputs.assets?.schema === "two.kit-complete-assets.v1" &&
      digest(inputs.assets.treeSha256) &&
      inputs.sourceConfig?.schema === "two.kit-source-config.v1" &&
      inputs.sourceConfig.config &&
      Array.isArray(inputs.files),
    "verified frozen inputs required for intent",
  );
  assert.ok(
    tool?.schema === "two.kit-wrangler-tool.v1" &&
      tool.name === "wrangler" &&
      tool.version === "4.156.1" &&
      tool.entry === "node_modules/wrangler/bin/wrangler.js" &&
      Array.isArray(tool.locks) &&
      isDeepStrictEqual(
        tool.locks.map((lock) => lock?.path).sort(),
        ["package-lock.json", "web/package-lock.json"],
      ),
    "checked Wrangler required for intent",
  );
  for (const lock of tool.locks) {
    assert.ok(positive(lock.bytes) && digest(lock.sha256), "invalid intent lock digest");
    const matches = inputs.files.filter((file) => file?.path === `source/${lock.path}`);
    assert.ok(
      matches.length === 1 &&
        isDeepStrictEqual(matches[0], { ...lock, path: `source/${lock.path}` }),
      "intent lock differs from frozen inputs",
    );
  }
  assert.ok(
    multipart?.schema === "two.kit-multipart-modules.v1" &&
      multipart.worker?.name === "worker.js" &&
      multipart.worker.mime === "application/javascript+module" &&
      positive(multipart.worker.bytes) &&
      multipart.worker.sha256 === inputs.workerSha256 &&
      positive(multipart.metadata?.bytes) &&
      digest(multipart.metadata.sha256) &&
      multipart.config?.schema === "two.kit-multipart-config.v1" &&
      multipart.config.evidence === "serialized-dry-run-config-fields-only" &&
      digest(multipart.config.configSha256),
    "checked serialized module and config required for intent",
  );
  // These objects must come from the disk/tool/envelope verifiers in the same
  // trusted job, not arbitrary JSON. Hashes associate their evidence; they do not
  // authenticate it or establish complete runtime/dependency qualification.
  const intent = {
    schema: "two.kit-frozen-intent.v1",
    evidence: "prepared-upload-inputs-only",
    sourceSha: inputs.sourceSha,
    runId: inputs.runId,
    runAttempt: inputs.runAttempt,
    target: inputs.target,
    snapshotSha256: sha256(JSON.stringify(inputs)),
    toolSha256: sha256(JSON.stringify(tool)),
    workerSha256: inputs.workerSha256,
    assetInputsSha256: inputs.assets.treeSha256,
    serializedConfigSha256: multipart.config.configSha256,
    multipartSha256: sha256(JSON.stringify(multipart)),
    invocation: {
      command: ["versions", "upload", "--no-bundle"],
      entry: "build/worker.js",
      config: "source/web/wrangler.production.jsonc",
      assets: "adapter",
      environment: "default",
      nameOverride: false,
    },
  };
  return { ...intent, intentSha256: sha256(JSON.stringify(intent)) };
}
