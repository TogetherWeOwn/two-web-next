// Production Hono pilot only. A build inventory is not a deployment receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "two.worker-bundle-inventory.v1";
const shaPattern = /^[0-9a-f]{40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeExternals = new Set([
  ...builtinModules.map((name) => `node:${name.replace(/^node:/, "")}`),
  "cloudflare:sockets",
  "cloudflare:workers",
]);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function inside(root, path) {
  assert.equal(typeof path, "string", "path must be a string");
  assert.ok(path && !isAbsolute(path) && !path.includes("\\"), "non-relative path");
  assert.ok(
    !path.split("/").some((part) => !part || part === "." || part === ".."),
    "non-canonical path",
  );
  const full = resolve(root, path);
  const rel = relative(realpathSync(root), realpathSync(full));
  assert.ok(
    rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel),
    "path escapes root",
  );
  assert.ok(lstatSync(full).isFile(), "expected a regular file");
  return full;
}

function file(root, path) {
  const content = readFileSync(inside(root, path));
  return { path, bytes: content.length, sha256: sha256(content) };
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `invalid ${label}`);
  return value;
}

function identity(value) {
  assert.match(value.sourceSha, shaPattern, "source SHA required");
  assert.match(value.runId, /^[1-9][0-9]*$/, "run ID required");
  assert.match(value.runAttempt, /^[1-9][0-9]*$/, "run attempt required");
  assert.equal(value.target, "two-web-next-production");
  assert.equal(value.environment, "production");
  return value;
}

export function packageRoot(path) {
  const parts = path.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const count = parts[at + 1]?.startsWith("@") ? 2 : 1;
  const name = parts.slice(at + 1, at + 1 + count).join("/");
  assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, "invalid package path");
  return { name, root: parts.slice(0, at + 1 + count).join("/") };
}

export function createInventory(root, directory, context) {
  identity(context);
  const build = resolve(root, directory);
  // Additional Wrangler modules are not necessarily represented by esbuild's
  // outputs. Fail closed rather than claiming an incomplete runtime inventory.
  const allowed = new Set([
    "worker.js",
    "worker.js.map",
    "README.md",
    "bundle-meta.json",
    "inventory.json",
    "upload.json",
    "deployed.json",
  ]);
  for (const name of readdirSync(build))
    assert.ok(allowed.has(name), `untracked bundle file: ${name}`);
  const metaFile = file(root, `${directory}/bundle-meta.json`);
  const meta = JSON.parse(readFileSync(inside(root, metaFile.path), "utf8"));
  object(meta.inputs, "metafile inputs");
  object(meta.outputs, "metafile outputs");
  assert.ok(Object.keys(meta.inputs).length > 0, "empty metafile inputs");
  assert.deepEqual(
    Object.keys(meta.outputs).sort(),
    [`${directory}/worker.js`, `${directory}/worker.js.map`].sort(),
    "unsupported output set",
  );
  const packages = new Map();
  const contributions = new Map();
  const externals = new Set();
  const outputs = Object.entries(meta.outputs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, output]) => {
      object(output, "output");
      object(output.inputs, "output inputs");
      assert.ok(Array.isArray(output.imports), "output imports missing");
      for (const imported of output.imports) {
        assert.equal(imported.external, true, "untracked internal output import");
        assert.equal(typeof imported.path, "string");
        externals.add(imported.path);
      }
      for (const [input, contribution] of Object.entries(output.inputs)) {
        assert.ok(Object.hasOwn(meta.inputs, input), "output references an unknown input");
        assert.ok(
          Number.isSafeInteger(contribution.bytesInOutput) && contribution.bytesInOutput >= 0,
          "invalid contribution",
        );
        contributions.set(input, (contributions.get(input) ?? 0) + contribution.bytesInOutput);
      }
      const record = file(root, path);
      assert.equal(record.bytes, output.bytes, "stale metafile output size");
      return { ...record, path: path.slice(directory.length + 1) };
    });
  const inputs = Object.entries(meta.inputs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, input]) => {
      const record = file(root, path);
      assert.equal(record.bytes, input.bytes, "stale metafile input size");
      const pkg = packageRoot(path);
      if (pkg && !packages.has(pkg.root)) {
        const manifest = file(root, `${pkg.root}/package.json`);
        const data = JSON.parse(readFileSync(inside(root, manifest.path), "utf8"));
        assert.equal(data.name, pkg.name, "package identity mismatch");
        assert.ok(
          typeof data.version === "string" && data.version.length > 0,
          "package version missing",
        );
        packages.set(pkg.root, { name: pkg.name, version: data.version, manifest });
      }
      return {
        ...record,
        packageRoot: pkg?.root ?? null,
        bytesInOutput: contributions.get(path) ?? 0,
      };
    });
  const unknownExternals = [...externals].filter((name) => !nativeExternals.has(name)).sort();
  const wrangler = JSON.parse(
    readFileSync(inside(root, "node_modules/wrangler/package.json"), "utf8"),
  );
  const requireWrangler = createRequire(inside(root, "node_modules/wrangler/package.json"));
  const esbuild = requireWrangler("esbuild/package.json");
  assert.equal(
    esbuild.version,
    wrangler.dependencies.esbuild,
    "unexpected Wrangler esbuild version",
  );
  return {
    schema: SCHEMA,
    evidence: "build-only",
    ...context,
    tools: { node: process.versions.node, wrangler: wrangler.version, esbuild: esbuild.version },
    build: {
      command: `wrangler deploy --dry-run --env production --outdir ${directory} --metafile ${directory}/bundle-meta.json`,
      config: file(root, "wrangler.jsonc"),
      lockfile: file(root, "package-lock.json"),
    },
    metafile: { ...metaFile, path: "bundle-meta.json" },
    // v1 permits one runtime JS module; maps are archived evidence, not runtime.
    bundle: {
      algorithm: "sha256",
      sha256: outputs.find((item) => item.path === "worker.js").sha256,
      entry: "worker.js",
    },
    outputs,
    inputs,
    packages: [...packages.values()].sort((a, b) => a.manifest.path.localeCompare(b.manifest.path)),
    externals: [...externals].sort(),
    absenceEligible: unknownExternals.length === 0,
    unknownExternals,
  };
}

export function verifyInventory(root, directory, expected) {
  const raw = readFileSync(inside(root, `${directory}/inventory.json`), "utf8");
  const saved = JSON.parse(raw);
  assert.equal(saved.schema, SCHEMA, "unsupported inventory schema");
  identity(expected);
  const actual = createInventory(root, directory, expected);
  assert.deepEqual(saved, actual, "missing, stale or invalid bundle evidence");
  return { inventory: actual, inventorySha256: sha256(raw) };
}

// Only call after verifying the artifact and its expected identity. Presence is
// conservative: even entirely tree-shaken metafile inputs count as present.
export function packageFinding(inventory, name) {
  assert.equal(inventory.schema, SCHEMA);
  if (inventory.packages.some((pkg) => pkg.name === name)) return "present";
  return inventory.absenceEligible ? "absent-from-runtime-bundle" : "unknown";
}

export function readWranglerOutput(path) {
  assert.ok(typeof path === "string" && path.length > 0, "Wrangler output path required");
  const raw = readFileSync(path);
  assert.ok(raw.length <= 1024 * 1024, "Wrangler output too large");
  const text = raw.toString("utf8").trim();
  assert.ok(text.length > 0, "Wrangler output empty");
  return text.split("\n").map((line) => JSON.parse(line));
}

export function uploadReceipt(verified, records) {
  const { inventory, inventorySha256 } = verified;
  const uploads = records.filter((record) => record.type === "version-upload");
  assert.equal(uploads.length, 1, "expected exactly one native Wrangler version-upload record");
  const uploaded = uploads[0];
  assert.equal(uploaded.version, 1, "unknown Wrangler upload schema");
  assert.equal(uploaded.worker_name, inventory.target, "wrong uploaded Worker");
  assert.equal(uploaded.wrangler_environment, inventory.environment, "wrong uploaded environment");
  assert.match(uploaded.version_id, uuidPattern, "upload version ID missing");
  return {
    schema: "two.worker-bundle-upload.v1",
    sourceSha: inventory.sourceSha,
    runId: inventory.runId,
    runAttempt: inventory.runAttempt,
    target: inventory.target,
    environment: inventory.environment,
    inventorySha256,
    bundleSha256: inventory.bundle.sha256,
    versionId: uploaded.version_id,
  };
}

export function deploymentReceipt(verified, upload, versionId) {
  assert.match(versionId, uuidPattern, "promoted version ID missing");
  const expected = uploadReceipt(verified, [
    {
      type: "version-upload",
      version: 1,
      worker_name: verified.inventory.target,
      wrangler_environment: verified.inventory.environment,
      version_id: versionId,
    },
  ]);
  assert.deepEqual(upload, expected, "promoted version does not match digest-bound upload");
  return {
    ...upload,
    schema: "two.worker-bundle-deployment.v1",
    evidence: "promoted-and-smoke-verified",
  };
}

function main() {
  const [command, directory = "dist-production"] = process.argv.slice(2);
  const root = process.cwd();
  const context = identity({
    sourceSha: process.env.BUILD_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    target: "two-web-next-production",
    environment: "production",
  });
  if (command === "create") {
    writeFileSync(
      resolve(root, directory, "inventory.json"),
      json(createInventory(root, directory, context)),
      { flag: "wx" },
    );
  } else {
    const verified = verifyInventory(root, directory, context);
    if (command === "verify") {
      console.log(
        json({
          evidence: verified.inventory.evidence,
          sourceSha: verified.inventory.sourceSha,
          bundleSha256: verified.inventory.bundle.sha256,
          samples: {
            hono: packageFinding(verified.inventory, "hono"),
            vitest: packageFinding(verified.inventory, "vitest"),
          },
        }),
      );
    } else if (command === "uploaded") {
      const records = readWranglerOutput(process.env.WRANGLER_OUTPUT_FILE_PATH);
      writeFileSync(
        resolve(root, directory, "upload.json"),
        json(uploadReceipt(verified, records)),
        { flag: "wx" },
      );
    } else if (command === "deployed") {
      const upload = JSON.parse(readFileSync(inside(root, `${directory}/upload.json`), "utf8"));
      writeFileSync(
        resolve(root, directory, "deployed.json"),
        json(deploymentReceipt(verified, upload, process.env.PROMOTED_VERSION_ID)),
        { flag: "wx" },
      );
    } else {
      throw new Error("usage: worker-bundle-evidence.mjs create|verify|uploaded|deployed [outdir]");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
