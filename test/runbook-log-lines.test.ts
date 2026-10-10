import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = "src";
const DOCS_PATH = "docs/runbook-logs.md";

/** Recursively collect all .ts and .tsx files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (st.isFile() && (extname(entry) === ".ts" || extname(entry) === ".tsx")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract the first argument of console.error("...") calls as a literal string. */
function extractConsoleErrorLiterals(filePath: string): Array<{ literal: string; line: number }> {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const results: Array<{ literal: string; line: number }> = [];
  // Match console.error("literal" or console.error('literal' at start of call
  const re = /console\.error\(\s*(["'])(.*?)\1/g;
  for (const [idx, line] of lines.entries()) {
    if (typeof line !== "string") continue;
    // matchAll yields RegExpStringIterator; each match has capture groups as strings when matched
    for (const m of line.matchAll(re)) {
      // m[2] is the literal content (second capture group)
      const g2: string | undefined = m[2];
      if (typeof g2 === "string") {
        results.push({ literal: g2, line: idx + 1 });
      }
    }
  }
  return results;
}

/** Extract documented prefixes from the Failure log lines table in docs/runbook-logs.md. */
function extractDocumentedPrefixes(docsPath: string): Set<string> {
  const content = readFileSync(docsPath, "utf8");
  const prefixes = new Set<string>();
  // Find the Failure log lines section and its table
  const sectionMatch = content.match(/## Failure log lines([\s\S]*?)(?=\n## |$)/);
  if (!sectionMatch) return prefixes;
  const section = sectionMatch[1];
  if (typeof section !== "string") return prefixes;
  // Table rows are | prefix | ... |; the prefix cell may contain backticks
  const rowRe = /^\|\s*`?([^`|]+?)`?\s*\|/gm;
  // matchAll yields RegExpStringIterator; each match has capture groups as strings when matched
  for (const m of section.matchAll(rowRe)) {
    // m[1] is the prefix cell content
    const g1: string | undefined = m[1];
    if (typeof g1 === "string") {
      const trimmed = g1.trim();
      if (trimmed && trimmed !== "---" && !trimmed.toLowerCase().startsWith("prefix")) {
        prefixes.add(trimmed);
      }
    }
  }
  return prefixes;
}

describe("runbook log lines coverage", () => {
  it("every console.error literal first argument has a row in docs/runbook-logs.md", () => {
    const documented = extractDocumentedPrefixes(DOCS_PATH);
    const sourceFiles = collectSourceFiles(SRC_DIR);
    const missing: Array<{ file: string; line: number; literal: string }> = [];

    for (const file of sourceFiles) {
      const literals = extractConsoleErrorLiterals(file);
      for (const { literal, line } of literals) {
        // Exclude the known out-of-scope line (sync-settlement handled separately)
        if (literal === "sync attempt settlement failed") continue;
        if (!documented.has(literal)) {
          missing.push({ file, line, literal });
        }
      }
    }

    if (missing.length > 0) {
      const details = missing.map((m) => `${m.file}:${m.line}  "${m.literal}"`).join("\n  ");
      throw new Error(
        `Found console.error literals without a row in docs/runbook-logs.md Failure log lines table:\n  ${details}\n\nAdd a row for each literal (exact prefix match) or exclude it via the test allowlist if intentionally out of scope.`,
      );
    }

    // If we reach here, all literals are documented
    expect(true).toBe(true);
  });
});
