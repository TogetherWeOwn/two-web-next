import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./tier0-changed-query-files.mjs", import.meta.url));
const warning = "::warning::changed query files unavailable";

function runDiff(stdout, status) {
  const dir = mkdtempSync(join(tmpdir(), "tier0-query-files-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${status}\n`);
    chmodSync(git, 0o755);
    const summary = join(dir, "summary.md");
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    return { log: result.stdout, summary: readFileSync(summary, "utf8") };
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
  assert.match(result.log, new RegExp(warning));
  assert.equal(result.summary, "### Tier-0 changed query files\n");
});
