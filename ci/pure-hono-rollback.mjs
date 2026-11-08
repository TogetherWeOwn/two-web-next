// A Kit build with every family off is not a pure-Hono rollback target.
// Create this record only from reverified Hono evidence and a named version read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

// Callers must obtain both metadata objects from authenticated GitHub API reads,
// not from the downloaded archive. This does not verify the archive's bytes or
// replace verifyPureHonoRollback; successful metadata alone cannot authorize Kit.
export function verifyPureHonoProvenance(pointer, run, artifact) {
  const repository = "TogetherWeOwn/two-web-next";
  const workflow = ".github/workflows/deploy-production.yml";
  assert.match(pointer?.sourceSha, /^[0-9a-f]{40}$/, "invalid rollback source SHA");
  assert.match(pointer?.runId, /^[1-9][0-9]*$/, "invalid rollback run ID");
  assert.match(pointer?.runAttempt, /^[1-9][0-9]*$/, "invalid rollback run attempt");
  for (const value of [
    run?.id,
    run?.run_attempt,
    run?.repository?.id,
    artifact?.id,
    artifact?.size_in_bytes,
  ])
    assert.ok(Number.isSafeInteger(value) && value > 0, "invalid GitHub metadata ID or size");
  assert.equal(String(run.id), pointer.runId, "wrong producer run");
  assert.equal(String(run.run_attempt), pointer.runAttempt, "wrong producer attempt");
  assert.equal(run.repository.full_name, repository, "wrong producer repository");
  assert.equal(run.head_repository?.full_name, repository, "fork producer");
  assert.equal(run.head_repository?.id, run.repository.id, "fork repository ID");
  assert.equal(run.path, workflow, "wrong producer workflow");
  assert.equal(run.head_branch, "main", "untrusted producer branch");
  assert.match(run.head_sha, /^[0-9a-f]{40}$/, "invalid producer workflow SHA");
  assert.equal(run.status, "completed", "unfinished producer run");
  assert.equal(run.conclusion, "success", "unsuccessful producer run");
  assert.ok(
    ["workflow_dispatch", "workflow_run", "schedule"].includes(run.event),
    "untrusted producer event",
  );
  const runUrl = `https://github.com/${repository}/actions/runs/${pointer.runId}`;
  assert.equal(run.html_url, runUrl, "wrong producer URL");
  const artifactName = `worker-bundle-production-${pointer.sourceSha}-${pointer.runId}-${pointer.runAttempt}`;
  assert.equal(artifact.name, artifactName, "wrong rollback artifact");
  assert.equal(artifact.expired, false, "expired rollback artifact");
  assert.equal(artifact.workflow_run?.id, run.id, "wrong artifact run");
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "wrong artifact workflow SHA");
  assert.equal(artifact.workflow_run?.head_branch, "main", "wrong artifact branch");
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id, "wrong artifact repository");
  assert.equal(
    artifact.workflow_run?.head_repository_id,
    run.repository.id,
    "fork artifact repository",
  );
  return {
    repository,
    workflow,
    runId: pointer.runId,
    runAttempt: pointer.runAttempt,
    sourceSha: pointer.sourceSha,
    workflowSha: run.head_sha,
    artifactId: String(artifact.id),
    artifactName,
    runUrl,
  };
}

export function readPureHonoVersion(versionId, execute = execFileSync) {
  assert.match(
    versionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "invalid pure-Hono version ID",
  );
  assert.equal(versionId.length, 36, "invalid pure-Hono version ID");
  try {
    return JSON.parse(
      execute(
        "npx",
        ["wrangler", "versions", "view", versionId, "--name", "two-web-next-production", "--json"],
        {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch {
    throw new Error("native pure-Hono version lookup failed");
  }
}

function main() {
  const [command, directory, third, fourth, ...extra] = process.argv.slice(2);
  const capture = command === "capture";
  assert.ok(
    directory &&
      third &&
      !extra.length &&
      (capture ? !fourth : ["create", "verify"].includes(command) && fourth),
    "usage: pure-hono-rollback.mjs capture <build-dir> <pointer.json> OR create|verify <build-dir> <native-version.json> <pointer.json>",
  );
  const pointerPath = capture ? third : fourth;
  const verified = verifyInventory(process.cwd(), directory, {
    sourceSha: process.env.BUILD_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    target: "two-web-next-production",
    environment: "production",
  });
  const deployed = JSON.parse(readFileSync(resolve(directory, "deployed.json"), "utf8"));
  let nativeVersion;
  if (capture) {
    nativeVersion = readPureHonoVersion(deployed.versionId);
  } else {
    const nativeRaw = readFileSync(third);
    assert.ok(nativeRaw.length <= 1024 * 1024, "native version response too large");
    nativeVersion = JSON.parse(nativeRaw.toString("utf8"));
  }
  if (capture || command === "create") {
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
