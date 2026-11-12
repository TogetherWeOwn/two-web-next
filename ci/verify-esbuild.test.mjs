import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LOCKED_ESBUILD, verifyEsbuild } from "./verify-esbuild.mjs";

const platform = `@esbuild/${process.platform}-${process.arch}`;
const write = (root, path, value) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
};
const json = (root, path, value) => write(root, path, JSON.stringify(value));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "esbuild-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = {
    packages: {
      "node_modules/esbuild": {
        version: LOCKED_ESBUILD,
        optionalDependencies: { [platform]: LOCKED_ESBUILD },
      },
      [`node_modules/${platform}`]: { version: LOCKED_ESBUILD, optional: true },
    },
  };
  json(root, "package-lock.json", lock);
  json(root, "package.json", { devDependencies: { esbuild: LOCKED_ESBUILD } });
  json(root, `node_modules/${platform}/package.json`, { version: LOCKED_ESBUILD });
  write(
    root,
    `node_modules/${platform}/bin/esbuild`,
    `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('--version') ? '${LOCKED_ESBUILD}\\n' : 'let answer=1;\\n');\n`,
  );
  const binary = join(root, "node_modules", platform, "bin", "esbuild");
  // A local executable fixture stands in for the platform binary; it does not minify.
  requireExecutable(binary);
  const shim = join(root, "node_modules", "esbuild", "bin", "esbuild");
  mkdirSync(dirname(shim), { recursive: true });
  copyFileSync(new URL("../node_modules/esbuild/bin/esbuild", import.meta.url), shim);
  requireExecutable(shim);
  mkdirSync(join(root, "node_modules", ".bin"));
  symlinkSync("../esbuild/bin/esbuild", join(root, "node_modules", ".bin", "esbuild"));
  return { root, lock, shim, binary };
}

import { chmodSync } from "node:fs";
function requireExecutable(path) {
  chmodSync(path, 0o755);
}

test("accepts the reviewed shim and a functioning locked platform fixture", (t) => {
  const { root } = fixture(t);
  assert.equal(verifyEsbuild(root).ok, true);
});

test("rejects lock, pin, optional and installed platform mismatches", (t) => {
  const { root, lock } = fixture(t);
  for (const mutate of [
    () => {
      lock.packages["node_modules/esbuild"].version = "0.0.0";
    },
    () => {
      lock.packages[`node_modules/${platform}`].optional = false;
    },
    () => {
      lock.packages["node_modules/esbuild"].optionalDependencies[platform] = "0.0.0";
    },
  ]) {
    const original = structuredClone(lock);
    mutate();
    json(root, "package-lock.json", lock);
    assert.equal(verifyEsbuild(root).ok, false);
    Object.assign(lock, original);
  }
  json(root, "package-lock.json", lock);
  json(root, "package.json", { devDependencies: { esbuild: "0.0.0" } });
  assert.equal(verifyEsbuild(root).ok, false);
  json(root, "package.json", { devDependencies: { esbuild: LOCKED_ESBUILD } });
  rmSync(join(root, "node_modules", platform, "package.json"));
  assert.equal(verifyEsbuild(root).ok, false);
  json(root, `node_modules/${platform}/package.json`, { version: "0.0.0" });
  assert.equal(verifyEsbuild(root).ok, false);
});

test("rejects a modified shim before executing it", (t) => {
  const { root, shim } = fixture(t);
  writeFileSync(shim, `${readFileSync(shim, "utf8")}\nthrow new Error('modified');\n`);
  const result = verifyEsbuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.equal(result.jsShim, false);
});

test("rejects binary version and minification failures", (t) => {
  const { root, binary } = fixture(t);
  for (const [version, minified] of [
    ["0.0.0", "let answer=1;"],
    [LOCKED_ESBUILD, "wrong"],
  ]) {
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('--version') ? '${version}\\n' : '${minified}\\n');\n`,
    );
    assert.equal(verifyEsbuild(root).ok, false);
  }
  writeFileSync(binary, "#!/usr/bin/env node\nprocess.exit(1);\n");
  assert.equal(verifyEsbuild(root).ok, false);
});
