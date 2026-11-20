import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../worker-bundle-evidence.mjs";
import { checkRehearsalInput, compareDryRun, rehearsalContext } from "./upload-rehearsal.mjs";

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
  assert.throws(() => checkRehearsalInput(identity, context, config, changed), /installed output digest/);
});
