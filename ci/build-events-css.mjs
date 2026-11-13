#!/usr/bin/env node
// Generate the current events page's stylesheet bundle in cascade order.
// Keep its bytes in sync with the served files so its CSP hash authorizes only
// the exact styles that would otherwise be loaded as blocking stylesheets.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  "public/styles.css",
  "public/theme-tokens.css",
  "public/theme.css",
  "public/schedule-theme.css",
];
const OUT = "src/events-critical-css.ts";

export function build() {
  const css = SOURCES.map((entry) => readFileSync(join(repoRoot, entry), "utf8")).join("\n");
  if (/<\/style/i.test(css)) {
    throw new Error("refusing to inline CSS containing a closing style tag");
  }
  const sha256 = createHash("sha256").update(css, "utf8").digest("base64");
  const text =
    `// GENERATED from ${SOURCES.join(", ")} — do not hand-edit.\n` +
    `// Regen: node ci/build-events-css.mjs.\n` +
    `export const EVENTS_CRITICAL_CSS: string =\n  ${JSON.stringify(css)};\n` +
    `export const EVENTS_CRITICAL_CSS_SHA256: string = ${JSON.stringify(sha256)};\n`;
  return { text, sha256 };
}

const { text, sha256 } = build();
writeFileSync(join(repoRoot, OUT), text);
console.log(`${OUT}: ${text.length} chars, sha256 ${sha256}`);
