#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const semgrep = process.argv[2];
if (!semgrep) {
  console.error("usage: node ci/semgrep-warn-selftest.mjs <semgrep-bin>");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "semgrep-warn-selftest-"));
try {
  const fixture = join(dir, "warn-fixture.ts");
  writeFileSync(fixture, 'eval("1 + 1");\n');
  const result = spawnSync(semgrep, ["--config", "ci/semgrep-rules.yml", "--json", fixture], {
    encoding: "utf8",
    env: { ...process.env, SEMGREP_SEND_METRICS: "off" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "Semgrep selftest exited non-zero");
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("Semgrep selftest returned invalid JSON");
  }
  if (!report.results?.some((finding) => finding.check_id === "ts-no-eval")) {
    throw new Error("Semgrep selftest did not report the planted warning rule");
  }
  console.log("Semgrep WARN selftest: planted ts-no-eval reported with exit 0");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
