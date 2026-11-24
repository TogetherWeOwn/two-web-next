import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { sha256 } from "../worker-bundle-evidence.mjs";
import { readWranglerConfig } from "../wrangler-config.mjs";
import {
  checkRehearsalInput,
  compareDryRun,
  productionConfig,
  rehearsalContext,
  rehearseUpload,
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

test("rehearsal and verification reject scratch drift and unclean parity", async (t) => {
  const repo = resolve(import.meta.dirname, "../..");
  const config = await readFile(join(repo, productionConfig));
  const original = readWranglerConfig(config.toString());
  const dir = await mkdtemp(join(tmpdir(), "rehearsal-input-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = join(dir, "cloudflare");
  await mkdir(assets);
  const files = {};
  for (const [name, text] of Object.entries({ ...modules, _headers: "h", ".assetsignore": "i" })) {
    await writeFile(join(assets, name), text);
    files[`cloudflare/${name}`] = sha256(text);
  }
  const binding = {
    ...context,
    kitConfigSha256: sha256(config),
    installedOutputSha256: sha256(JSON.stringify(files)),
  };
  const identity = { ...binding, files };
  const parity = {
    ...binding,
    failures: [],
    approved: [],
    assets: { failures: [] },
    cutoverReadiness: [
      { name: "prefix-1033", status: 200, pending: 0 },
      { name: "transition-1037", status: 200, pending: 0 },
      { name: "missing-1034", status: 503, pending: 1 },
      { name: "malformed", status: 503, pending: null },
    ],
  };
  const execute = (drift) =>
    rehearseUpload(
      { repo, installed: { assets }, identity, context, outputIdentity: () => files },
      async (_exe, args, { cwd }) => {
        await writeFile(args.at(-1), await multipart(modules));
        assert.deepEqual(JSON.parse(await readFile(join(cwd, "wrangler.json"), "utf8")), {
          ...original,
          main: "modules/_worker.js",
          base_dir: "modules",
          rules: [{ type: "ESModule", globs: ["kit-adapter.js"] }],
          assets: { ...original.assets, directory: "../cloudflare" },
        });
        await drift?.(cwd);
        return { status: 0 };
      },
    );
  const matched = await execute();
  const check = (value, replay = parity) =>
    verifyUploadRehearsal(value, replay, identity, context, config);
  check(matched);
  assert.throws(() => check(matched, { ...parity, approved: [{}] }), /without exceptions/);
  for (const cutoverReadiness of [undefined, [], parity.cutoverReadiness.slice(1)]) {
    assert.throws(() => check(matched, { ...parity, cutoverReadiness }), /cutover readiness/);
  }
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
  for (const file of ["wrangler.json", "modules/kit-adapter.js", "modules/extra.txt"]) {
    const receipt = await execute((cwd) => writeFile(join(cwd, file), "changed"));
    assert.equal(receipt.outcome, "refused", file);
    const phase = file === "wrangler.json" ? "post-run-effective-config" : "post-run-module-root";
    assert.equal(receipt.phase, phase);
    assert.equal(receipt.scratchRemoved, true);
  }
  const missing = await execute((cwd) => rm(join(cwd, "modules/kit-adapter.js")));
  assert.equal(missing.outcome, "refused");
  assert.equal(missing.phase, "post-run-module-root");
  assert.deepEqual(await readdir(dir), ["cloudflare"]);
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
