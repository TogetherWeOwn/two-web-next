import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./tier0-changed-query-files.mjs", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const warning = "::warning::changed query files unavailable";

function runDiff(stdout, status, includeSummary = true) {
  const dir = mkdtempSync(join(tmpdir(), "tier0-query-files-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${status}\n`);
    chmodSync(git, 0o755);
    const summary = join(dir, "summary.md");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    if (includeSummary) env.GITHUB_STEP_SUMMARY = summary;
    else delete env.GITHUB_STEP_SUMMARY;
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    return {
      log: result.stdout,
      summary: includeSummary ? readFileSync(summary, "utf8") : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("successful changed-query listing preserves the existing summary bytes", () => {
  const result = runDiff("src/db/query.ts\n", 0);
  assert.equal(result.summary, "### Tier-0 changed query files\nsrc/db/query.ts\n");
  assert.equal(result.log, "");
});

test("failed changed-query listing emits a workflow warning instead of empty evidence", () => {
  const result = runDiff("", 1);
  assert.match(result.log, new RegExp(`${warning} \\(exit 1\\)`));
  assert.equal(result.summary, "### Tier-0 changed query files\n");
});

test("successful changed-query listing remains visible without a GitHub summary file", () => {
  const result = runDiff("src/db/query.ts\n", 0, false);
  assert.equal(result.log, "src/db/query.ts\n");
  assert.equal(result.summary, undefined);
});

test("the CI step runs this selftest without changing the Tier-0 WARN posture", () => {
  const step = workflow
    .split(/\n      - /)
    .find((entry) =>
      entry.startsWith("name: Tier-0 report (validators + authz + EXPLAIN, WARN)\n"),
    );
  assert(step, "the Tier-0 WARN step must exist");
  assert.match(step, /^        continue-on-error: true$/m);
  assert.match(step, /node --test ci\/tier0-changed-query-files\.test\.mjs/);
  assert.match(step, /node ci\/tier0-changed-query-files\.mjs/);
  assert.match(step, /remember_tier0_failure/);
});
