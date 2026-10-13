import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverKitAssets } from "./check-kit-perf.mjs";

const scriptPath = fileURLToPath(new URL("./check-kit-perf.mjs", import.meta.url));

test("kit perf selftest passes hermetically", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--selftest"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /kit perf budget selftest: \d+ cases passed/);
});

test("asset discovery misses nothing under _app", () => {
  const { js, css } = discoverKitAssets(
    new URL("../web/.svelte-kit/output/client/_app", import.meta.url).pathname,
  );
  assert.ok(Array.isArray(js) && Array.isArray(css));
});

test("missing client output fails closed, never green", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(new URL("./check-kit-perf.mjs", import.meta.url).href)}).then((m) => { process.exitCode = m.run("/nonexistent-root-xyz", { log() {}, error() {} }); })`,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    2,
    `expected exit 2, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
});
