import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rehearsalContext } from "./upload-rehearsal.mjs";

export function verifyUploadRehearsal(receipt, parity, context) {
  assert.equal(receipt?.schema, "two.kit-parity-upload-rehearsal.v1", "invalid receipt schema");
  for (const [key, value] of Object.entries(context)) {
    assert.equal(parity[key], value, `parity ${key} mismatch`);
    assert.equal(receipt[key], value, `receipt ${key} mismatch`);
  }
  for (const key of ["kitConfigSha256", "installedOutputSha256"]) {
    assert.match(parity[key] ?? "", /^[a-f0-9]{64}$/, `invalid parity ${key}`);
    assert.equal(receipt[key], parity[key], `receipt ${key} mismatch`);
  }
  assert.equal(receipt.scratchRemoved, true, "missing rehearsal scratch cleanup");
  const { status, signal, error, outcome, comparison } = receipt;
  switch (outcome) {
    case "matched":
    case "module-mismatch":
      assert.equal(comparison?.sameModuleBytes, outcome === "matched", "invalid byte comparison");
      break;
    case "invalid-envelope":
      assert.ok(error, "missing invalid envelope diagnostic");
      break;
    case "wrangler-failed":
      assert.ok(
        error || signal || (Number.isInteger(status) && status !== 0),
        "missing Wrangler failure diagnostic",
      );
      break;
    default:
      assert.fail("invalid receipt outcome");
  }
}

if (import.meta.main) {
  const dir = process.argv[2];
  const read = async (name) => JSON.parse(await readFile(join(dir, name), "utf8"));
  const receipt = await read("upload-rehearsal.json");
  const parity = await read("comparison.json");
  verifyUploadRehearsal(receipt, parity, rehearsalContext(process.env.EXPECTED_HEAD_SHA));
  console.log(`Verified upload rehearsal receipt (${receipt.outcome}) against parity comparison`);
}
