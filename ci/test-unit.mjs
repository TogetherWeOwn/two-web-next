#!/usr/bin/env node
// A bounded entry point: no selection must never mean the full suite.
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function selectedFiles(args, repoRoot = root) {
  if (!args.length)
    throw new Error("Select explicit test/*.test.ts files; no full-suite fallback.");
  return [...new Set(args)].map((file) => {
    if (!/^test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/.test(file)) {
      throw new Error(`Expected an exact test/*.test.ts path: ${file}`);
    }
    const path = resolve(repoRoot, file);
    if (
      !path.startsWith(`${repoRoot}/test/`) ||
      realpathSync(path) !== path ||
      !statSync(path).isFile()
    ) {
      throw new Error(`Expected a regular test file inside this checkout: ${file}`);
    }
    return file;
  });
}

export async function run(args) {
  const files = selectedFiles(args);
  execFileSync(process.execPath, [resolve(root, "ci/build-leaf-css.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [resolve(root, "ci/build-events-css.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  const { startVitest } = await import("vitest/node");
  // CLI positional filters are substring matches. Override include as well so
  // an exact file selection cannot grow to similarly named files or a suite.
  await startVitest(files, {
    root,
    config: resolve(root, "vitest.config.ts"),
    include: files,
    watch: false,
    coverage: { enabled: false },
    passWithNoTests: false,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
