import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../worker-bundle-evidence.mjs";
import {
  checkRehearsalInput,
  moduleMime,
  productionConfig,
  rehearsalConfig,
  rehearsalContext,
  rehearsalInputs,
  rehearsalSchema,
  wranglerVersion,
} from "./upload-rehearsal.mjs";

export function verifyUploadRehearsal(receipt, parity, identity, context, configBytes) {
  assert.equal(receipt?.schema, rehearsalSchema, "invalid receipt schema");
  assert.equal(receipt.outcome, "matched", "upload rehearsal refused; see upload-rehearsal.json");
  checkRehearsalInput(identity, context, configBytes, identity.files);
  for (const key of [...Object.keys(context), "kitConfigSha256", "installedOutputSha256"]) {
    assert.equal(parity[key], identity[key], `parity ${key} mismatch`);
    assert.equal(receipt[key], identity[key], `receipt ${key} mismatch`);
  }
  for (const rows of [parity.failures, parity.approved, parity.assets.failures]) {
    assert.deepEqual(rows, [], "expected clean parity without exceptions");
  }
  assert.deepEqual(
    parity.cutoverReadiness,
    [
      { name: "prefix-1033", status: 200, pending: 0 },
      { name: "transition-1037", status: 200, pending: 0 },
      { name: "missing-1034", status: 503, pending: 1 },
      { name: "malformed", status: 503, pending: null },
    ],
    "missing or invalid installed cutover readiness evidence",
  );
  assert.equal(receipt.scratchRemoved, true, "missing rehearsal scratch cleanup");
  assert.equal(receipt.wrangler?.version, wranglerVersion, "unexpected Wrangler version");
  assert.equal(receipt.tag, `${context.sourceSha}-${context.runId}-${context.runAttempt}`);
  assert.equal(
    receipt.effectiveConfigSha256,
    sha256(rehearsalConfig(configBytes)),
    "receipt effective config digest mismatch",
  );
  const inputs = rehearsalInputs(identity.files);
  for (const key of Object.keys(inputs)) {
    assert.deepEqual(receipt[key], inputs[key], `receipt ${key} mismatch`);
  }
  const expected = inputs.moduleSha256;
  const observed = Object.fromEntries(
    Object.entries(expected).map(([name, digest]) => [name, { type: moduleMime, sha256: digest }]),
  );
  assert.deepEqual(
    receipt.comparison,
    { sameModuleBytes: true, expected, observed, missing: [], extra: [], changed: [] },
    "receipt module comparison mismatch",
  );
}

if (import.meta.main) {
  const dir = process.argv[2];
  const read = async (name) => JSON.parse(await readFile(join(dir, name), "utf8"));
  const receipt = await read("upload-rehearsal.json");
  const parity = await read("comparison.json");
  const identity = await read("identity.json");
  const configBytes = await readFile(join(import.meta.dirname, "../..", productionConfig));
  const context = rehearsalContext(process.env.EXPECTED_HEAD_SHA);
  verifyUploadRehearsal(receipt, parity, identity, context, configBytes);
  console.log("Verified matched upload rehearsal receipt against the exact all-off parity replay");
}
