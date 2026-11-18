import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./http-boundary-suppressions.mjs", import.meta.url));
const sources = {
  ts: 'export const value = <string>"text";',
  mts: 'export const value: string = "text";',
  cts: 'const value: string = "text"; module.exports = value;',
  tsx: 'export const view = <div>{"text" as string}</div>;',
  jsx: "export const view = <div>text</div>;",
  js: 'export const text = "// ast-grep-ignore: example-rule";',
  mjs: "export const text = `/* ast-grep-ignore */`;",
  cjs: 'module.exports = "ast-grep-ignore"; return;',
};

function scan(t, files, { throughPackageScript = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "http-suppressions-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  if (throughPackageScript) {
    // Use the real script wiring; keep the fixture out of the checkout.
    copyFileSync(new URL("../package.json", import.meta.url), join(cwd, "package.json"));
    mkdirSync(join(cwd, "ci"));
    symlinkSync(guard, join(cwd, "ci/http-boundary-suppressions.mjs"));
  }
  const [command, ...args] = throughPackageScript
    ? ["npm", "--offline", "--ignore-scripts", "--silent", "run", "scan:fetch-await"]
    : [process.execPath, guard];
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}

test("the fetch-await scan rejects line and block directives in every supported file type, including hidden paths", (t) => {
  const files = Object.entries(sources).map(([extension, source], index) => {
    const path = `src/http/nested/.hidden/sample.${extension}`;
    const directive = index % 2 ? "/* ast-grep-ignore */" : "// ast-grep-ignore: example-rule";
    return [path, `${source}\n${directive}\nvoid 0;\n`];
  });
  const result = scan(t, Object.fromEntries(files), { throughPackageScript: true });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    result.stderr.trim().split("\n").sort(),
    files.map(([path]) => `${path}:2: ast-grep suppression is forbidden in the HTTP core`).sort(),
  );
});

test("accepts supported syntax, ordinary text and comments, and out-of-scope files", (t) => {
  const result = scan(t, {
    ...Object.fromEntries(
      Object.entries(sources).map(([extension, source]) => [
        `src/http/sample.${extension}`,
        `// Ordinary explanation.\n${source}\n`,
      ]),
    ),
    "src/http/notes.txt": "// ast-grep-ignore\n",
    "src/http-adapter/sample.ts": "// ast-grep-ignore\nexport {};\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("fails closed with a distinct diagnostic when comments cannot be inspected", (t) => {
  const result = scan(t, { "src/http/malformed.ts": "const value = ;\n" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^src\/http\/malformed\.ts: could not inspect comments:/);
});
