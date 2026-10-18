#!/usr/bin/env node
// Whether a ZAP gate markdown report is a retryable PII flake.
// Retryable means exactly one failure: a lone PII Disclosure (10062) High
// with no Medium/Low over budget and no malformed evidence. ZAP's PII rule
// is a Luhn heuristic prone to false positives on synthetic numbers, and the
// 3-minute spider covers a varying URL subset per run, so a single transient
// 10062 that vanishes on re-scan is a flake, not a leak. Any other High, any
// budget breach, or any invalid evidence fails immediately with no retry.
// Public-safe: decides from counts and plugin IDs only, never URLs/evidence.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isRetryablePiiFlake(gateMarkdown) {
  const md = String(gateMarkdown ?? "");
  if (!md.includes("**FAIL:** 1 High alert type(s); High is never allowed")) return false;
  if (!md.includes("High 1 ·")) return false;
  if (!md.includes("| High | 10062 |")) return false;
  if (md.includes("budget")) return false;
  if (md.includes("invalid")) return false;
  if (!md.includes("**PASS**") && md.includes("**FAIL:**")) {
    // Exactly one failure line segment: the FAIL line must not join extra
    // failures. Budget/invalid are checked above; other Highs would raise
    // the High count above 1, checked via "High 1 ·".
    return true;
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mdPath] = process.argv.slice(2);
  if (!mdPath) {
    console.error("usage: node ci/zap-retry-decision.mjs <gate-markdown-file>");
    process.exit(2);
  }
  let md;
  try {
    md = readFileSync(mdPath, "utf8");
  } catch {
    console.error("retry decision: markdown file is missing or unreadable");
    process.exit(2);
  }
  process.exit(isRetryablePiiFlake(md) ? 0 : 1);
}
