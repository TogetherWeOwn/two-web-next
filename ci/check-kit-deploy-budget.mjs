#!/usr/bin/env node
// Final Wrangler dry-run artifact safeguard, NOT a user-latency guarantee.
// CI creates a clean output directory immediately before measuring it.
import { appendFileSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployBudget } from "./kit-deploy-budget.mjs";

export function measureDeployBundle(root, artifactDir) {
  try {
    const maxRawBytes = loadDeployBudget(root).worker.maxRawBytes;
    if (!artifactDir || !lstatSync(artifactDir).isDirectory())
      throw new Error("missing final artifact directory");
    const entry = lstatSync(join(artifactDir, "_worker.js"));
    if (!entry.isFile() || entry.size === 0) throw new Error("missing/empty canonical _worker.js");
    let rawBytes = 0;
    let files = 0;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) walk(path);
        else if (!stat.isFile()) throw new Error("non-regular final artifact evidence");
        else if (!name.endsWith(".map") && path !== join(artifactDir, "README.md")) {
          rawBytes += stat.size;
          files += 1;
          if (!Number.isSafeInteger(rawBytes)) throw new Error("unsafe final artifact byte total");
        }
      }
    };
    walk(artifactDir);
    return {
      code: rawBytes > maxRawBytes ? 1 : 0,
      rawBytes,
      maxRawBytes,
      files,
    };
  } catch (error) {
    return {
      code: 2,
      error: `cannot enforce final Kit deploy budget: ${error.message}`,
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(2);
  const result =
    args.length === 1
      ? measureDeployBundle(root, resolve(args[0]))
      : {
          code: 2,
          error: "usage: node ci/check-kit-deploy-budget.mjs <clean Wrangler outdir>",
        };
  const message =
    result.error ??
    `Final Kit deploy bundle: ${result.rawBytes}/${result.maxRawBytes} raw bytes in ${result.files} modules (exit ${result.code}).`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Final Kit artifact safeguard\n\n${message}\n`,
    );
  process.exitCode = result.code;
}
