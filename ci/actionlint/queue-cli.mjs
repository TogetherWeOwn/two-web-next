import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [stock, patched] = process.argv.slice(2).map((path) => resolve(path));
assert(stock && patched, "pass the actual stock and patched CLI paths");
const cases = JSON.parse(readFileSync(new URL("./queue-cases.json", import.meta.url), "utf8"));
const directory = mkdtempSync(join(tmpdir(), "actionlint-cli-"));
const job = "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n";
let checked = 0;
function check(binary, name, source, valid, diagnostic) {
  const file = join(directory, `${name}.yml`);
  writeFileSync(file, source);
  const result = spawnSync(binary, ["-shellcheck=", "-pyflakes=", "-no-color", file], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.signal, null, `${name}: CLI terminated by a signal`);
  assert.equal(result.status, valid ? 0 : 1, `${name}: ${output}`);
  if (diagnostic) assert(output.includes(diagnostic), `${name}: missing ${diagnostic}: ${output}`);
  checked += 1;
  console.log(`actionlint CLI: ${name}: ${valid ? "accepted" : "rejected"}`);
}
try {
  for (const scope of ["workflow", "job"]) {
    for (const fixture of cases) {
      const concurrency = `concurrency:\n  ${fixture.block.replaceAll("\n", "\n  ")}\n`;
      const source =
        scope === "workflow"
          ? `on: push\n${concurrency}${job}`
          : `on: push\n${job}    ${concurrency.trimEnd().replaceAll("\n", "\n    ")}\n`;
      check(stock, `stock-${scope}-${fixture.name}`, source, fixture.stockValid);
      check(patched, `patched-${scope}-${fixture.name}`, source, fixture.valid, fixture.error);
    }
  }
  for (const [name, source, diagnostic] of [
    ["unrelated-malformed", `on: push\nunknown_key: true\n${job}`, "unexpected key"],
    [
      "invalid-group-expression",
      `on: push\nconcurrency:\n  group: \${{ unknown.foo }}\n${job}`,
      "undefined variable",
    ],
  ]) {
    check(stock, `stock-${name}`, source, false, diagnostic);
    check(patched, `patched-${name}`, source, false, diagnostic);
  }
  console.log(`actionlint compatibility: ${checked} actual CLI fixture invocations passed`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
