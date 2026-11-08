// Consume only a downloadPureHonoArchive result and a fresh native version read.
// The authenticated producer verified source/dependency inputs. This consumer
// rechecks archived output bytes and receipts, not unavailable historical inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPureHonoRollback } from "./pure-hono-rollback.mjs";
import { SCHEMA, deploymentReceipt, sha256, uploadReceipt } from "./worker-bundle-evidence.mjs";

const MAX_ARCHIVE = 64 * 1024 * 1024;

export function verifyPureHonoArchiveContents(pointer, archive, transport, nativeVersion) {
  try {
    assert.ok(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= MAX_ARCHIVE);
    assert.equal(archive.length, transport.archiveBytes);
    assert.equal(sha256(archive), transport.archiveSha256);
    const { provenance } = transport;
    assert.equal(provenance.repository, "TogetherWeOwn/two-web-next");
    assert.equal(provenance.workflow, ".github/workflows/deploy-production.yml");
    for (const key of ["sourceSha", "runId", "runAttempt"])
      assert.equal(provenance[key], pointer[key]);
    assert.equal(
      provenance.artifactName,
      `worker-bundle-production-${pointer.sourceSha}-${pointer.runId}-${pointer.runAttempt}`,
    );
    const { files, texts } = JSON.parse(
      execFileSync(
        "python3",
        ["-I", fileURLToPath(new URL("./read-pure-hono-archive.py", import.meta.url))],
        {
          input: archive,
          timeout: 30_000,
          maxBuffer: 128 * 1024 * 1024,
          // No inherited credentials, Python search path or downloaded cwd.
          env: {},
          cwd: fileURLToPath(new URL(".", import.meta.url)),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
    const records = new Map(files.map((file) => [file.path, file]));
    const inventory = JSON.parse(texts["inventory.json"]);
    assert.equal(inventory.schema, SCHEMA);
    assert.equal(inventory.evidence, "build-only");
    assert.equal(inventory.target, "two-web-next-production");
    assert.equal(inventory.environment, "production");
    for (const key of ["sourceSha", "runId", "runAttempt"])
      assert.equal(inventory[key], pointer[key]);
    const inventorySha256 = sha256(texts["inventory.json"]);
    assert.equal(inventorySha256, pointer.inventorySha256);
    assert.equal(inventory.bundle.algorithm, "sha256");
    assert.equal(inventory.bundle.entry, "worker.js");
    assert.equal(inventory.bundle.sha256, pointer.bundleSha256);
    assert.equal(inventory.bundle.sha256, records.get("worker.js").sha256);
    assert.deepEqual(
      inventory.outputs.map((file) => file.path).sort(),
      ["worker.js", "worker.js.map"],
    );
    for (const output of inventory.outputs) assert.deepEqual(output, records.get(output.path));
    assert.deepEqual(inventory.metafile, records.get("bundle-meta.json"));
    const meta = JSON.parse(texts["bundle-meta.json"]);
    const directory = "dist-production";
    assert.deepEqual(
      Object.keys(meta.outputs).sort(),
      [`${directory}/worker.js`, `${directory}/worker.js.map`],
    );
    for (const output of inventory.outputs)
      assert.equal(meta.outputs[`${directory}/${output.path}`].bytes, output.bytes);
    // A successful trusted producer owns input verification. Preserve its exact
    // inventory digest; never silently expand the Hono schema to a Kit build.
    const verified = { inventory, inventorySha256 };
    const deployed = JSON.parse(texts["deployed.json"]);
    const upload = JSON.parse(texts["upload.json"]);
    assert.deepEqual(
      upload,
      uploadReceipt(verified, [
        {
          type: "version-upload",
          version: 1,
          worker_name: inventory.target,
          wrangler_environment: inventory.environment,
          version_id: pointer.versionId,
        },
      ]),
    );
    assert.deepEqual(deployed, deploymentReceipt(verified, upload, pointer.versionId));
    assert.deepEqual(JSON.parse(texts["pure-hono-rollback.json"]), pointer);
    verifyPureHonoRollback(pointer, verified, deployed, nativeVersion);
    return {
      schema: "two.pure-hono-archive-contents.v1",
      evidence: "authenticated-producer-archive",
      pointer,
      provenance,
      archiveSha256: transport.archiveSha256,
      archiveBytes: archive.length,
      files,
    };
  } catch {
    // Do not expose archive member contents, subprocess output or native values.
    throw new Error("pure-Hono archive content verification failed");
  }
}
