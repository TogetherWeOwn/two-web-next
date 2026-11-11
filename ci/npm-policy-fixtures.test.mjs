import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobPolicyProblems, runNpmFixtures } from "./npm-policy-fixtures.mjs";

test("both policy settings must be exact", () => {
  assert.deepEqual(jobPolicyProblems({ npm_config_ignore_scripts: "true", npm_config_min_release_age: "3" }), []);
  assert.equal(jobPolicyProblems({ npm_config_ignore_scripts: "false", npm_config_min_release_age: "3" }).length, 1);
  assert.equal(jobPolicyProblems({ npm_config_ignore_scripts: "true", npm_config_min_release_age: "0" }).length, 1);
  assert.equal(jobPolicyProblems({}).length, 2);
});

test("missing npm fails closed and removes scratch files", async () => {
  const root = mkdtempSync(join(tmpdir(), "npm-policy-test-"));
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    const result = await runNpmFixtures({ env: { RUNNER_TEMP: root }, log: () => {} });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => !check.ok));
    assert.deepEqual(readdirSync(root), []);
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects missing output argument without running fixtures", () => {
  const result = spawnSync(process.execPath, ["ci/npm-policy-fixtures.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
