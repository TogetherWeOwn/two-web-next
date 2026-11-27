import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = fileURLToPath(new URL("../sgconfig.yml", import.meta.url));
const nodeRule = "no-raw-byte-length-comparison-node";

export function scanByteLengthComparisons(cwd, filter) {
  const output = execFileSync(
    "npx",
    [
      "-y",
      "--package",
      "@ast-grep/cli@0.50.0",
      "ast-grep",
      "scan",
      "--config",
      config,
      "--filter",
      filter,
      "--warning",
      "--json=compact",
      "--no-ignore",
      "hidden",
    ],
    { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

export function compareByteLengthBaseline(findings, baseline) {
  const allowances = new Map();
  for (const row of baseline) {
    const key = JSON.stringify(row);
    allowances.set(key, (allowances.get(key) ?? 0) + 1);
  }

  const added = [];
  const seen = new Set();
  for (const finding of findings) {
    const file = normalize(finding.file);
    const { text, range } = finding.metaVariables.single.COMPARISON;
    // A comparison can have a byte-length access on both sides.
    const occurrence = JSON.stringify([file, range.byteOffset.start, range.byteOffset.end]);
    if (seen.has(occurrence)) continue;
    seen.add(occurrence);

    const key = JSON.stringify([file, text]);
    const remaining = allowances.get(key);
    if (!remaining) added.push({ file, text, line: range.start.line + 1 });
    else if (remaining === 1) allowances.delete(key);
    else allowances.set(key, remaining - 1);
  }
  added.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  return { added, stale: [...allowances.keys()].map((key) => JSON.parse(key)) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const baseline = JSON.parse(
    readFileSync(new URL("raw-byte-length-baseline.json", import.meta.url), "utf8"),
  );
  const findings = scanByteLengthComparisons(process.cwd(), `^${nodeRule}$`);
  const { added, stale } = compareByteLengthBaseline(findings, baseline);
  for (const { file, text, line } of added) {
    console.error(
      `${file}:${line}: Use the shared byte-limit helpers for ${JSON.stringify(text)}.`,
    );
  }
  for (const [file, text] of stale) {
    console.error(
      `Remove the unused byte-length baseline entry for ${file}: ${JSON.stringify(text)}.`,
    );
  }
  if (added.length || stale.length) process.exitCode = 1;
}
