// A Kit build with every family off is not a pure-Hono rollback target.
// Create this record only from reverified Hono evidence and a named version read.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRollbackVersionSecrets } from "./check-production-secrets.mjs";
import {
  deploymentReceipt,
  packageFinding,
  uploadReceipt,
  verifyInventory,
} from "./worker-bundle-evidence.mjs";

export function createPureHonoRollback(verified, deployed, nativeVersion) {
  const { inventory, inventorySha256 } = verified;
  assert.equal(inventory.target, "two-web-next-production", "wrong rollback Worker");
  assert.equal(inventory.environment, "production", "wrong rollback environment");
  assert.ok(
    inventory.inputs.some((input) => input.path === "src/worker.ts"),
    "pure-Hono entry missing from inventory",
  );
  assert.ok(
    inventory.inputs.every(
      (input) => !input.path.startsWith("web/") && !input.path.includes(".svelte-kit/"),
    ),
    "Kit input cannot classify as pure Hono",
  );
  assert.equal(inventory.absenceEligible, true, "unresolved runtime externals");
  assert.equal(packageFinding(inventory, "hono"), "present", "Hono package missing");
  for (const name of ["@sveltejs/kit", "svelte"])
    assert.equal(
      packageFinding(inventory, name),
      "absent-from-runtime-bundle",
      "Kit package present",
    );

  const upload = uploadReceipt(verified, [
    {
      type: "version-upload",
      version: 1,
      worker_name: inventory.target,
      wrangler_environment: inventory.environment,
      version_id: deployed.versionId,
    },
  ]);
  assert.deepEqual(
    deployed,
    deploymentReceipt(verified, upload, deployed.versionId),
    "rollback target requires a matching smoke-verified Hono deployment receipt",
  );
  const versionTag = `${inventory.sourceSha}-${inventory.runId}-${inventory.runAttempt}`;
  assert.equal(nativeVersion?.id, deployed.versionId, "wrong native rollback version");
  assert.equal(nativeVersion?.annotations?.["workers/tag"], versionTag, "wrong native version tag");
  checkRollbackVersionSecrets(JSON.stringify(nativeVersion));
  return {
    schema: "two.pure-hono-rollback.v1",
    target: inventory.target,
    environment: inventory.environment,
    sourceSha: inventory.sourceSha,
    versionId: deployed.versionId,
    runId: inventory.runId,
    runAttempt: inventory.runAttempt,
    bundleSha256: inventory.bundle.sha256,
    inventorySha256,
    versionTag,
    expiresAt: null,
  };
}

export function verifyPureHonoRollback(pointer, verified, deployed, nativeVersion) {
  assert.deepEqual(
    pointer,
    createPureHonoRollback(verified, deployed, nativeVersion),
    "missing, stale or invalid pure-Hono rollback pointer",
  );
  return pointer;
}

function main() {
  const [command, directory, nativePath, pointerPath, ...extra] = process.argv.slice(2);
  assert.ok(
    ["create", "verify"].includes(command) &&
      directory &&
      nativePath &&
      pointerPath &&
      !extra.length,
    "usage: pure-hono-rollback.mjs create|verify <build-dir> <native-version.json> <pointer.json>",
  );
  const verified = verifyInventory(process.cwd(), directory, {
    sourceSha: process.env.BUILD_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    target: "two-web-next-production",
    environment: "production",
  });
  const deployed = JSON.parse(readFileSync(resolve(directory, "deployed.json"), "utf8"));
  const nativeRaw = readFileSync(nativePath);
  assert.ok(nativeRaw.length <= 1024 * 1024, "native version response too large");
  const nativeVersion = JSON.parse(nativeRaw.toString("utf8"));
  if (command === "create") {
    const pointer = createPureHonoRollback(verified, deployed, nativeVersion);
    writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx" });
  } else {
    verifyPureHonoRollback(
      JSON.parse(readFileSync(pointerPath, "utf8")),
      verified,
      deployed,
      nativeVersion,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // Never echo a native response or binding values on a malformed read.
    console.error("::error::pure-Hono rollback evidence verification failed");
    process.exitCode = 1;
  }
}
