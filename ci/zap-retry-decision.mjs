#!/usr/bin/env node
// Only a validated v1 lone-10062 High verdict can authorize the workflow's
// existing single rescan. Markdown, report names and caller policy cannot.
import { pathToFileURL } from "node:url";
import { readJsonFile, validRetryVerdict } from "./zap-verdict.mjs";

export function isRetryablePiiFlake(verdict) {
  try {
    const budget = readJsonFile(new URL("./zap-budget.json", import.meta.url));
    return validRetryVerdict(verdict, budget);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error("usage: node ci/zap-retry-decision.mjs <verdict.json>");
    process.exit(2);
  }
  let verdict;
  try {
    verdict = readJsonFile(args[0]);
  } catch {
    console.error("retry denied: provide a valid bounded ZAP verdict JSON file");
    process.exit(1);
  }
  process.exit(isRetryablePiiFlake(verdict) ? 0 : 1);
}
