import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../worker-bundle-evidence.mjs";
import { checkRehearsalInput, compareDryRun, rehearsalContext } from "./upload-rehearsal.mjs";
import { verifyUploadRehearsal } from "./verify-upload-rehearsal.mjs";

const context = rehearsalContext("a".repeat(40), { GITHUB_RUN_ID: "21", GITHUB_RUN_ATTEMPT: "3" });
const tag = `${context.sourceSha}-${context.runId}-${context.runAttempt}`;
const modules = { "_worker.js": "installed facade", "kit-adapter.js": "installed adapter" };
const expected = Object.fromEntries(
  Object.entries(modules).map(([name, text]) => [name, sha256(text)]),
);

async function multipart(parts, candidateTag = tag) {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({ main_module: "_worker.js", annotations: { "workers/tag": candidateTag } }),
  );
  for (const [name, text] of Object.entries(parts)) {
    form.set(name, new Blob([text], { type: "application/javascript+module" }), name);
  }
  return Buffer.from(await new Response(form).arrayBuffer());
}

test("dry run matches only the exact installed modules", async () => {
  const matched = await compareDryRun(await multipart(modules), expected, tag);
  assert.equal(matched.sameModuleBytes, true);
  for (const name of Object.keys(modules)) {
    const changed = await multipart({ ...modules, [name]: "changed" });
    const mismatch = await compareDryRun(changed, expected, tag);
    assert.equal(mismatch.sameModuleBytes, false);
    assert.deepEqual(mismatch.changed, [name]);
  }
  const partial = await multipart({
    "_worker.js": modules["_worker.js"],
    "unexpected.txt": "text asset",
  });
  const mismatch = await compareDryRun(partial, expected, tag);
  assert.equal(mismatch.sameModuleBytes, false);
  assert.deepEqual(mismatch.missing, ["kit-adapter.js"]);
  assert.deepEqual(mismatch.extra, ["unexpected.txt"]);
  await assert.rejects(
    compareDryRun(await multipart(modules, "wrong-tag"), expected, tag),
    /candidate tag/,
  );
});

test("dry-run multipart size and framing are bounded", async () => {
  const limit = 64 * 1024 * 1024;
  const invalid = Buffer.alloc(limit + 1);
  await assert.rejects(compareDryRun(invalid.subarray(0, 0), expected, tag), /envelope size/);
  // At the limit the size guard must admit the bytes to the next check.
  const atLimit = invalid.subarray(0, limit);
  await assert.rejects(compareDryRun(atLimit, expected, tag), /envelope boundary/);
  await assert.rejects(compareDryRun(invalid, expected, tag), /envelope size/);
  const body = await multipart(modules);
  const malformed = Buffer.concat([Buffer.from("!"), body]);
  await assert.rejects(compareDryRun(malformed, expected, tag), /envelope boundary/);
  await assert.rejects(compareDryRun(body.subarray(0, -5), expected, tag), /multipart body/);
});

test("hosted receipt verification requires an outcome bound to this parity replay", () => {
  const parity = {
    ...context,
    kitConfigSha256: sha256("production config"),
    installedOutputSha256: sha256("installed tree"),
  };
  const receipt = { ...parity, schema: "two.kit-parity-upload-rehearsal.v1", scratchRemoved: true };
  const check = (value) => verifyUploadRehearsal(value, parity, context);
  const matched = { ...receipt, outcome: "matched", comparison: { sameModuleBytes: true } };
  check(matched);
  check({ ...receipt, outcome: "module-mismatch", comparison: { sameModuleBytes: false } });
  check({ ...receipt, outcome: "invalid-envelope", error: "bad body" });
  check({ ...receipt, outcome: "wrangler-failed", status: 1 });
  assert.throws(() => check(undefined), /receipt schema/);
  assert.throws(() => check(receipt), /outcome/);
  assert.throws(() => check({ ...matched, outcome: "module-mismatch" }), /byte comparison/);
  for (const key of Object.keys(parity)) {
    assert.throws(() => check({ ...matched, [key]: "0" }), new RegExp(key));
  }
  const stale = { ...parity, runAttempt: "2" };
  const staleReceipt = { ...matched, ...stale };
  assert.throws(() => verifyUploadRehearsal(staleReceipt, stale, context), /runAttempt/);
});

test("rehearsal refuses mismatched parity identity, config or installed inputs", () => {
  const config = Buffer.from("production config");
  const files = {
    "cloudflare/_worker.js": expected["_worker.js"],
    "cloudflare/_headers": sha256("policy"),
  };
  const identity = {
    ...context,
    kitConfigSha256: sha256(config),
    installedOutputSha256: sha256(JSON.stringify(files)),
  };
  checkRehearsalInput(identity, context, config, files);
  for (const key of Object.keys(context)) {
    assert.throws(
      () => checkRehearsalInput({ ...identity, [key]: "0" }, context, config, files),
      new RegExp(key),
    );
  }
  assert.throws(
    () => checkRehearsalInput(identity, context, Buffer.from("not production"), files),
    /config digest/,
  );
  const changed = { ...files, "cloudflare/_headers": sha256("changed") };
  assert.throws(
    () => checkRehearsalInput(identity, context, config, changed),
    /installed output digest/,
  );
});
