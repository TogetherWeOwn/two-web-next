#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = join("src", `ast-grep-warning-selftest-${process.pid}.test.ts`);
try {
  writeFileSync(fixture, "expect(true).toBe(true);\n");
  const result = spawnSync("npx", ["-y", "--package", "@ast-grep/cli@0.50.0", "ast-grep", "scan"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(output || result.error?.message || "ast-grep scan exited non-zero");
  }
  if (!output.includes("ts-vacuous-literal-expect")) {
    throw new Error("ast-grep did not report the planted warning rule");
  }
  console.log("ast-grep WARN selftest: planted warning reported with exit 0");
} catch (error) {
  console.error(`ast-grep WARN selftest failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { force: true });
}
