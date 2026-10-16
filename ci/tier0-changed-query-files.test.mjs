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

function runDiff(stdout, status, includeSummary = true, stderr = "") {
  const dir = mkdtempSync(join(tmpdir(), "tier0-query-files-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(
      git,
      `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${status}\n`,
    );
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
      stderr: result.stderr,
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
  const result = runDiff("", 1, true, "fatal: merge base unavailable\n");
  assert.match(result.log, new RegExp(`${warning} \\(exit 1\\)`));
  assert.equal(result.stderr, "fatal: merge base unavailable\n");
  assert.equal(result.summary, "### Tier-0 changed query files\n");
});

test("successful changed-query listing remains visible without a GitHub summary file", () => {
  const result = runDiff("src/db/query.ts\n", 0, false);
  assert.equal(result.log, "src/db/query.ts\n");
  assert.equal(result.summary, undefined);
});

test("the blocking Check step runs this selftest and the Tier-0 reporter stays WARN-only", () => {
  const steps = workflow.split(/\n      - /);
  const checkStep = steps.find((entry) =>
    entry.startsWith("name: Check (lint + typecheck + coverage gate)\n"),
  );
  assert(checkStep, "the blocking Check step must exist");
  assert.match(checkStep, /node --test[^\n]*ci\/tier0-changed-query-files\.test\.mjs/);

  const tier0Step = steps.find((entry) =>
    entry.startsWith("name: Tier-0 report (validators + authz + EXPLAIN, WARN)\n"),
  );
  assert(tier0Step, "the Tier-0 WARN step must exist");
  assert.match(tier0Step, /^        continue-on-error: true$/m);
  assert.match(tier0Step, /node ci\/tier0-changed-query-files\.mjs/);
  assert.match(tier0Step, /remember_tier0_failure/);
  assert.doesNotMatch(tier0Step, /tier0-changed-query-files\.test\.mjs/);
});
