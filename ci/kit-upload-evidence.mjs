// Kit receipts bind native version identity to a reverified local build.
// They do not prove remote byte readback, asset selection or package absence.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKitRehearsal } from "./kit-upload-rehearsal.mjs";
import { readWranglerOutput, sha256 } from "./worker-bundle-evidence.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function verifyKitRehearsal(root, buildDirectory, replayDirectory, receiptPath, context) {
  const raw = readFileSync(receiptPath, "utf8");
  const saved = JSON.parse(raw);
  const actual = createKitRehearsal(root, buildDirectory, replayDirectory, context);
  assert.deepEqual(saved, actual, "missing, stale or invalid Kit build evidence");
  return { rehearsal: actual, rehearsalSha256: sha256(raw) };
}

export function kitUploadReceipt(verified, records) {
  const { rehearsal, rehearsalSha256 } = verified;
  assert.equal(rehearsal.schema, "two.kit-upload-rehearsal.v1", "unsupported Kit build schema");
  const uploads = records.filter((record) => record?.type === "version-upload");
  assert.equal(uploads.length, 1, "expected exactly one native Wrangler version-upload record");
  const uploaded = uploads[0];
  assert.equal(uploaded.version, 1, "unknown Wrangler upload schema");
  assert.equal(uploaded.worker_name, rehearsal.target, "wrong uploaded Worker");
  // This config selects production by script name, not a named Wrangler env.
  // Pinned Wrangler serializes props.env and omits it when no --env is passed.
  assert.equal(uploaded.wrangler_environment, undefined, "unexpected named Wrangler environment");
  assert.equal(uploaded.worker_name_overridden, false, "unexpected Worker name override");
  assert.match(uploaded.version_id, uuidPattern, "upload version ID missing");
  return {
    schema: "two.kit-worker-upload.v1",
    sourceSha: rehearsal.sourceSha,
    runId: rehearsal.runId,
    runAttempt: rehearsal.runAttempt,
    target: rehearsal.target,
    environment: "production",
    rehearsalSha256,
    workerSha256: rehearsal.workerSha256,
    adapterTreeSha256: sha256(JSON.stringify(rehearsal.trees.assets)),
    versionId: uploaded.version_id,
  };
}

export function kitDeploymentReceipt(verified, upload, versionId) {
  assert.match(versionId, uuidPattern, "promoted version ID missing");
  const expected = kitUploadReceipt(verified, [
    {
      type: "version-upload",
      version: 1,
      worker_name: verified.rehearsal.target,
      worker_name_overridden: false,
      version_id: versionId,
    },
  ]);
  assert.deepEqual(upload, expected, "promoted version does not match digest-bound Kit upload");
  return {
    ...upload,
    schema: "two.kit-worker-deployment.v1",
    evidence: "promoted-and-smoke-verified",
  };
}

function main() {
  const [command, buildDirectory, replayDirectory, receiptPath, output, ...extra] =
    process.argv.slice(2);
  assert.ok(
    ["verify", "uploaded", "deployed"].includes(command) &&
      buildDirectory &&
      replayDirectory &&
      receiptPath &&
      !extra.length &&
      (command === "verify" ? !output : output),
    "usage: kit-upload-evidence.mjs verify|uploaded|deployed <build-dir> <replay-dir> <receipt> [output]",
  );
  const verified = verifyKitRehearsal(process.cwd(), buildDirectory, replayDirectory, receiptPath, {
    sourceSha: process.env.BUILD_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  if (command === "verify") {
    console.log(JSON.stringify({ rehearsalSha256: verified.rehearsalSha256 }));
    return;
  }
  const receipt =
    command === "uploaded"
      ? kitUploadReceipt(verified, readWranglerOutput(process.env.WRANGLER_OUTPUT_FILE_PATH))
      : kitDeploymentReceipt(
          verified,
          JSON.parse(readFileSync(process.env.KIT_UPLOAD_RECEIPT, "utf8")),
          process.env.PROMOTED_VERSION_ID,
        );
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
