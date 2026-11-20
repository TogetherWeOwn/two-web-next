import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "../worker-bundle-evidence.mjs";
import {
  checkEffectiveConfig,
  checkModuleRoot,
  checkRehearsalInput,
  compareDryRun,
  rehearsalConfig,
  rehearsalContext,
  rehearsalInputs,
  rehearsalSchema,
  wranglerVersion,
} from "./upload-rehearsal.mjs";
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
  assert.deepEqual(mismatch.extra, [`sha256:${sha256("unexpected.txt")}`]);
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

test("hosted verification requires a match bound to this parity replay", async () => {
  const original = {
    main: ".svelte-kit/cloudflare/_worker.js",
    assets: { directory: ".svelte-kit/cloudflare", binding: "ASSETS", run_worker_first: true },
    vars: { KIT_ROUTE_HOME: "false" },
  };
  const config = Buffer.from(JSON.stringify(original));
  const effective = rehearsalConfig(config);
  assert.deepEqual(JSON.parse(effective), {
    ...original,
    main: "modules/_worker.js",
    base_dir: "modules",
    rules: [{ type: "ESModule", globs: ["kit-adapter.js"] }],
    assets: { ...original.assets, directory: "../cloudflare" },
  });
  const assets = { ...expected, _headers: sha256("h"), ".assetsignore": sha256("i") };
  const files = Object.fromEntries(Object.entries(assets).map(([k, v]) => [`cloudflare/${k}`, v]));
  const binding = {
    ...context,
    kitConfigSha256: sha256(config),
    installedOutputSha256: sha256(JSON.stringify(files)),
  };
  const identity = { ...binding, files };
  const parity = { ...binding, failures: [], approved: [], assets: { failures: [] } };
  const matched = {
    ...binding,
    ...rehearsalInputs(files),
    effectiveConfigSha256: sha256(effective),
    schema: rehearsalSchema,
    scratchRemoved: true,
    wrangler: { version: wranglerVersion },
    tag,
    outcome: "matched",
    comparison: await compareDryRun(await multipart(modules), expected, tag),
  };
  const check = (value, replay = parity) =>
    verifyUploadRehearsal(value, replay, identity, context, config);
  check(matched);
  for (const outcome of [undefined, "module-mismatch", "refused", "wrangler-failed"]) {
    assert.throws(() => check({ ...matched, outcome }), /rehearsal refused/);
  }
  assert.throws(() => check(undefined), /receipt schema/);
  assert.throws(() => check({ ...matched, comparison: { sameModuleBytes: true } }), /comparison/);
  for (const key of [...Object.keys(binding), "effectiveConfigSha256", "controlFiles"]) {
    assert.throws(() => check({ ...matched, [key]: "0" }), /mismatch/);
  }
  const stale = { runAttempt: "2" };
  assert.throws(() => check({ ...matched, ...stale }, { ...parity, ...stale }), /runAttempt/);
});

test("scratch checks refuse configuration, module bytes and file-set drift", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rehearsal-input-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "wrangler.json");
  await writeFile(config, "original");
  await checkEffectiveConfig(config, sha256("original"));
  await writeFile(config, "changed");
  await assert.rejects(checkEffectiveConfig(config, sha256("original")), /config digest/);
  await rm(config);
  await writeFile(join(dir, "_worker.js"), modules["_worker.js"]);
  await assert.rejects(checkModuleRoot(dir, expected), /file set/);
  await writeFile(join(dir, "kit-adapter.js"), modules["kit-adapter.js"]);
  await checkModuleRoot(dir, expected);
  await writeFile(join(dir, "kit-adapter.js"), "changed");
  await assert.rejects(checkModuleRoot(dir, expected), /module digest/);
  await writeFile(join(dir, "unexpected.txt"), "extra");
  await assert.rejects(checkModuleRoot(dir, expected), /file set/);
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
