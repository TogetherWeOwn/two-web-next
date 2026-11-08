// Narrow, independent classification of the reviewed adapter output. This is
// build-input evidence, not a frozen upload, native manifest or remote readback.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./worker-bundle-evidence.mjs";

// Adapter 8.0.2 appends these exact bytes. There is currently no source prefix.
export const KIT_ASSETSIGNORE = "\n_worker.js\n_routes.json\n_headers\n_redirects";
const specialNames = new Set([
  ".assetsignore",
  "_worker.js",
  "_routes.json",
  "_headers",
  "_redirects",
]);
const mimeTypes = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/vnd.microsoft.icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function checkedDirectory(directory) {
  assert.ok(
    !directory.split("/").some((part) => part === "." || part === ".."),
    "aliased directory component",
  );
  assert.ok(!directory.includes("//"), "aliased directory separator");
  const absolute = resolve(directory);
  for (let path = absolute; ; path = dirname(path)) {
    assert.ok(lstatSync(path).isDirectory(), "directory or ancestor is not a real directory");
    if (path === dirname(path)) break;
  }
  return absolute;
}

export function classifyKitAssets(directory) {
  const root = checkedDirectory(directory);
  const files = [];
  const seen = new Set();
  function walk(path, prefix) {
    for (const name of readdirSync(path).sort()) {
      assert.match(name, /^[A-Za-z0-9._-]+$/, "unsafe asset path or URL alias");
      assert.ok(name !== "." && name !== "..", "dot path component");
      const member = prefix ? `${prefix}/${name}` : name;
      assert.ok(!seen.has(member.toLowerCase()), "case-insensitive path collision");
      seen.add(member.toLowerCase());
      const workerOnly = member === "_worker.js" || member.startsWith("_worker.js/");
      assert.ok(
        !prefix || workerOnly || !specialNames.has(name.toLowerCase()),
        "ambiguous nested control or worker name",
      );
      const full = join(path, name);
      const stat = lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), "symlink in adapter tree");
      if (stat.isDirectory()) {
        assert.ok(
          !specialNames.has(name.toLowerCase()) || member === "_worker.js" || workerOnly,
          "control path is a directory",
        );
        walk(full, member);
      } else {
        assert.ok(stat.isFile(), "non-regular adapter input");
        const bytes = readFileSync(full);
        files.push({ member, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  walk(root, "");
  assert.deepEqual(
    readFileSync(join(root, ".assetsignore")),
    Buffer.from(KIT_ASSETSIGNORE),
    "unreviewed adapter ignore bytes",
  );
  for (const required of ["_headers", "_app/version.json"]) {
    assert.ok(
      files.some((file) => file.member === required && file.bytes > 0),
      `missing or empty ${required}`,
    );
  }
  const publicAssets = [];
  const modules = [];
  const controls = [];
  const ignored = [];
  files.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  for (const file of files) {
    if (file.member === "_worker.js" || file.member.startsWith("_worker.js/")) {
      modules.push({ ...file, reason: "adapter-worker" });
    } else if ([".assetsignore", "_headers", "_redirects"].includes(file.member)) {
      controls.push(file);
    } else if (file.member === "_routes.json") {
      ignored.push({ ...file, reason: "adapter-build-only" });
    } else {
      const mime = mimeTypes[extname(file.member)];
      assert.ok(mime, `unreviewed public asset MIME: ${file.member}`);
      publicAssets.push({ url: `/${file.member}`, ...file, mime });
    }
  }
  assert.ok(
    modules.some((file) => file.bytes > 0),
    "missing or empty adapter Worker",
  );
  assert.ok(
    publicAssets.some((file) => file.member.startsWith("_app/immutable/") && file.bytes > 0),
    "immutable assets missing or empty",
  );
  const classification = { publicAssets, modules, controls, ignored };
  return {
    schema: "two.kit-complete-assets.v1",
    evidence: "independently-classified-build-inputs-only",
    ...classification,
    treeSha256: sha256(JSON.stringify(classification)),
  };
}

function main() {
  const [directory, output, ...extra] = process.argv.slice(2);
  assert.ok(
    directory && output && !extra.length,
    "usage: kit-complete-assets.mjs <adapter-dir> <output>",
  );
  const manifest = classifyKitAssets(directory);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
