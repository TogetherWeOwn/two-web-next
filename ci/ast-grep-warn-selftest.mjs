#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  const directory = mkdtempSync(join("src", "http", "ast-grep-boundary-selftest-"));
  let outsideDirectory;
  try {
    outsideDirectory = mkdtempSync(join("src", "ast-grep-boundary-outside-"));
    const outside = join(outsideDirectory, "boundary.ts");
    writeFileSync(outside, 'import "hono";\n');
    const extensions = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs"];
    const files = extensions.map((extension) => join(directory, `boundary.${extension}`));
    for (const file of files) writeFileSync(file, 'import "other";\n');
    const scan = () =>
      spawnSync("npx", ["-y", "--package", "@ast-grep/cli@0.50.0", "ast-grep", "scan"], {
        encoding: "utf8",
      });
    const allowed = scan();
    const allowedOutput = `${allowed.stdout ?? ""}\n${allowed.stderr ?? ""}`;
    if (allowed.error || allowed.status !== 0 || allowedOutput.includes("http-no-hono")) {
      throw new Error(
        `allowed imports or outside path failed: ${allowedOutput || allowed.error?.message}`,
      );
    }
    for (const file of files) writeFileSync(file, 'const cors = require("hono/cors");\n');
    const denied = scan();
    const deniedOutput = `${denied.stdout ?? ""}\n${denied.stderr ?? ""}`;
    if (denied.error || denied.status !== 1 || files.some((file) => !deniedOutput.includes(file))) {
      throw new Error(
        `HTTP boundary scan did not reject every file: ${deniedOutput || denied.error?.message}`,
      );
    }
    if (deniedOutput.includes(outside))
      throw new Error("HTTP boundary scan rejected a file outside src/http");
    console.log(
      "ast-grep HTTP boundary selftest: allowed and outside imports pass; all HTTP file types fail",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (outsideDirectory) rmSync(outsideDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`ast-grep WARN selftest failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { force: true });
}
