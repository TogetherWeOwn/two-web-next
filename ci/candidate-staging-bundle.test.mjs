import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleCandidateKitWorker } from "./candidate-staging-bundle.mjs";

function fixture(t, source = "export default { fetch() { return new Response('fixture'); } };") {
  const root = mkdtempSync(join(tmpdir(), "candidate-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "web/.svelte-kit/cloudflare");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "_worker.js"), source);
  return { root, output };
}

const REFUSED = { message: "Candidate build refused: bundle" };

test("bundle compiles generated imports without executing top-level candidate code", async (t) => {
  const { root, output } = fixture(
    t,
    "import { value } from '../cloudflare-tmp/server.js';\nglobalThis.__candidateBundleExecuted = true;\nthrow new Error('candidate sentinel');\nexport default { value };\n",
  );
  mkdirSync(join(output, "../cloudflare-tmp"));
  writeFileSync(join(output, "../cloudflare-tmp/server.js"), "export const value = 42;");
  const result = await bundleCandidateKitWorker(root);
  assert.ok(Buffer.isBuffer(result));
  assert.match(result.toString(), /value = 42/);
  assert.doesNotMatch(result.toString(), /from ['"]\.\./);
  assert.equal(globalThis.__candidateBundleExecuted, undefined);
});

test("bundle leaves only workerd and Node builtins external", async (t) => {
  const { root } = fixture(
    t,
    "import { env } from 'cloudflare:workers';\nimport { createHash } from 'node:crypto';\nexport default { env, createHash };\n",
  );
  const result = (await bundleCandidateKitWorker(root)).toString();
  assert.match(result, /cloudflare:workers/);
  assert.match(result, /node:crypto/);
});

test("bundle does not discover candidate tsconfig, build config or package scripts", async (t) => {
  const { root } = fixture(t, "export const mode = process.env.NODE_ENV;");
  writeFileSync(join(root, "tsconfig.json"), "{invalid candidate config");
  writeFileSync(join(root, "esbuild.config.js"), "throw new Error('configuration executed');");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", scripts: { build: "exit 87" } }),
  );
  const result = (await bundleCandidateKitWorker(root)).toString();
  assert.match(result, /production/);
  assert.doesNotMatch(result, /process.env.NODE_ENV/);
});

for (const [name, source] of [
  ["missing module", "import x from './missing.js'; export default x;"],
  ["unsupported URL module", "export { default } from 'https://example.com/candidate.js';"],
  ["bare unresolved dependency", "export { default } from 'candidate-uninstalled-package';"],
  ["malformed code", "const candidate-private-marker = ;"],
  ["absolute external module", "export { default } from '/candidate-private-marker/missing.js';"],
  ["unsupported file loader", "import x from './candidate.wasm'; export default x;"],
]) {
  test(`bundle refuses ${name} with fixed diagnostics`, async (t) => {
    const { root, output } = fixture(t, source);
    writeFileSync(join(output, "candidate.wasm"), Buffer.from([0, 97, 115, 109]));
    await assert.rejects(bundleCandidateKitWorker(root), REFUSED);
  });
}

for (const value of [undefined, null, "relative", {}, 42]) {
  test(`bundle rejects nonabsolute input ${JSON.stringify(value)}`, async () => {
    await assert.rejects(bundleCandidateKitWorker(value), REFUSED);
  });
}

test("bundle refuses missing Kit output", async (t) => {
  const { root, output } = fixture(t);
  rmSync(join(output, "_worker.js"));
  await assert.rejects(bundleCandidateKitWorker(root), REFUSED);
});
