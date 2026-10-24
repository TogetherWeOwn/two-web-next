#!/usr/bin/env node
// Offline refusal-vocabulary check (docs/machine-errors.md "Write refusals"):
// the REFUSAL_CODES list in src/json-refusal.ts and the documented table must
// name the same codes, and no source file may answer a JSON `error` in a
// capitalized or spaced form. Read-only, network- and database-free. Prints one
// JSON summary line; exit 0 on pass, 1 on drift. Run via `npm run check:refusals`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOC = "docs/machine-errors.md";

export function documentedCodes(doc) {
  const start = doc.indexOf("## Write refusals");
  if (start < 0) return [];
  const rest = doc.slice(start + 1);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
}

// A JSON `error:` literal that is not a lowercase snake_case code, in any
// quote form: biome normalizes single quotes and spacing to the canonical
// double-quoted spelling, but leaves template literals untouched, so match
// all three delimiters (the capture group is now m[2], m[1] is the quote).
const BAD_ERROR = /\berror:\s*(["'`])([^"'`]*[A-Z ][^"'`]*)\1\s*[,}]/g;

export function evaluate({ codes, doc, sources }) {
  const failures = [];
  const documented = documentedCodes(doc);
  for (const code of codes) {
    if (!/^[a-z]+(?:_[a-z]+)*$/.test(code)) failures.push(`code not snake_case: ${code}`);
    if (!documented.includes(code)) failures.push(`undocumented code: ${code}`);
  }
  for (const code of documented) {
    if (!codes.includes(code)) failures.push(`documented but not in REFUSAL_CODES: ${code}`);
  }
  if (new Set(documented).size !== documented.length) failures.push("duplicate documented code");
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(BAD_ERROR)) {
      const line = text.slice(0, m.index).split("\n").length;
      failures.push(`non-vocabulary error "${m[2]}" at ${file}:${line}`);
    }
  }
  return { ok: failures.length === 0, codes: [...codes], failures };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

async function main() {
  if (process.argv.length > 2) {
    console.error("check:refusals takes no arguments.");
    process.exit(1);
  }
  const { REFUSAL_CODES } = await import("../src/json-refusal.ts");
  const sources = {};
  for (const path of walk(join(ROOT, "src"))) {
    sources[relative(ROOT, path)] = readFileSync(path, "utf8");
  }
  const summary = evaluate({
    codes: REFUSAL_CODES,
    doc: readFileSync(join(ROOT, DOC), "utf8"),
    sources,
  });
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
