// Immediate same-source CI diagnostics, not an admitted B collection or pinned D.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as authority from "./bundle-inventory.mjs";
import { freezeCanonicalBuild } from "./kit-upload-rehearsal.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

export function captureCanonicalBuild(root, destination, context, inventory = authority) {
  assert.match(context.sourceSha, /^[0-9a-f]{40}$/, "explicit source SHA required");
  assert.equal(context.workflowSha, context.sourceSha, "same-source diagnostic SHA mismatch");
  assert.match(context.runId, /^[1-9][0-9]*$/, "explicit run ID required");
  assert.match(context.runAttempt, /^[1-9][0-9]*$/, "explicit run attempt required");
  assert.ok(
    ["success", "failure", "skipped", "cancelled"].includes(context.producerOutcome),
    "explicit producer outcome required",
  );
  const output = resolve(destination);
  // Do not follow an aliased output parent or replace an earlier capture.
  assert.equal(realpathSync(dirname(output)), dirname(output), "capture parent alias");
  assert.ok(lstatSync(dirname(output)).isDirectory(), "capture parent missing");
  mkdirSync(output, { mode: 0o700 });
  const path = join(output, "status.json");
  const initial = {
    schema: "two.kit-canonical-capture.v1",
    evidence: "unqualified-same-source-ci-diagnostic",
    sourceSha: context.sourceSha,
    workflowSha: context.workflowSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    producerOutcome: context.producerOutcome,
    capture: "started",
    qualified: false,
    receipt: null,
  };
  const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const original = encode(initial);
  writeFileSync(path, original, { flag: "wx", mode: 0o600 });
  function finish(fields) {
    // Only replace the exact journal this invocation created, never another file.
    assert.ok(lstatSync(path).isFile(), "capture journal replaced");
    assert.equal(readFileSync(path, "utf8"), original, "capture journal changed");
    const status = { ...initial, ...fields };
    writeFileSync(path, encode(status), { flag: "w", mode: 0o600 });
    return status;
  }
  if (["skipped", "cancelled"].includes(context.producerOutcome)) {
    finish({ capture: "unavailable" });
    throw new Error("canonical producer did not complete");
  }
  let receipt;
  try {
    freezeCanonicalBuild(root, join(output, "bytes"), inventory);
    const bytes = readFileSync(join(output, "bytes/receipt.json"));
    receipt = { path: "bytes/receipt.json", bytes: bytes.length, sha256: sha256(bytes) };
  } catch {
    // Partial copies and raw output stay available to always() artifact retention.
    // Never serialize an exception containing source paths or generated contents.
    finish({ capture: "failed" });
    throw new Error("canonical byte capture failed");
  }
  const status = finish({ capture: "complete", receipt });
  assert.equal(context.producerOutcome, "success", "canonical producer failed before capture");
  return status;
}

function main() {
  const [destination, ...extra] = process.argv.slice(2);
  assert.ok(destination && !extra.length, "usage: kit-canonical-capture.mjs <destination>");
  captureCanonicalBuild(process.cwd(), destination, {
    sourceSha: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    producerOutcome: process.env.CANONICAL_PRODUCER_OUTCOME,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error("canonical diagnostic capture failed; inspect retained status");
    process.exitCode = 1;
  }
}
