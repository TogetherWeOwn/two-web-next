// Identity association only, not an uploader, remote byte proof or recovery gate.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { checkRollbackVersionSecrets } from "./check-production-secrets.mjs";
import { createKitFrozenIntent } from "./kit-frozen-intent.mjs";

export function createKitFrozenUploadReceipt(
  inputs,
  tool,
  multipart,
  intent,
  records,
  nativeVersion,
) {
  try {
    // The caller must reverify these inputs from disk/tool/envelope in the trusted
    // upload job and read the named version from the expected production script.
    // A saved descriptor or caller-provided native JSON does not authenticate it.
    const expected = createKitFrozenIntent(inputs, tool, multipart);
    assert.ok(isDeepStrictEqual(intent, expected));
    assert.ok(Array.isArray(records) && records.length > 0 && records.length <= 128);
    assert.ok(
      records.every(
        (record) =>
          record &&
          typeof record === "object" &&
          !Array.isArray(record) &&
          typeof record.type === "string" &&
          record.type.length > 0,
      ),
    );
    const uploads = records.filter((record) => record?.type === "version-upload");
    assert.ok(uploads.length === 1);
    const uploaded = uploads[0];
    assert.ok(
      uploaded.version === 1 &&
        uploaded.worker_name === expected.target &&
        uploaded.wrangler_environment === undefined &&
        uploaded.worker_name_overridden === false &&
        typeof uploaded.version_id === "string" &&
        uploaded.version_id.length === 36 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uploaded.version_id),
    );
    const versionTag = `${expected.sourceSha}-${expected.runId}-${expected.runAttempt}`;
    assert.ok(nativeVersion?.id === uploaded.version_id);
    assert.ok(nativeVersion?.annotations?.["workers/tag"] === versionTag);
    const nativeJson = JSON.stringify(nativeVersion);
    assert.ok(Buffer.byteLength(nativeJson) <= 1024 * 1024);
    checkRollbackVersionSecrets(nativeJson);
    return {
      schema: "two.kit-frozen-upload.v1",
      evidence: "native-version-associated-inputs-only",
      sourceSha: expected.sourceSha,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      target: expected.target,
      intentSha256: expected.intentSha256,
      versionTag,
      versionId: uploaded.version_id,
    };
  } catch {
    // Assertion diagnostics can include native binding values. Never propagate
    // them or retain native data in the receipt; only fixed fields leave here.
    throw new Error("frozen Kit upload identity association failed");
  }
}
