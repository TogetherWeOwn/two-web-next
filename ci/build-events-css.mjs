#!/usr/bin/env node
// Generate the events stylesheet bundle in its existing cascade order.
// The generated module is preparation only; no route consumes it yet.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export function generate() {
  const css = SOURCES.map((entry) => readFileSync(join(repoRoot, entry), "utf8")).join("\n");
  if (/<\/style/i.test(css)) {
    throw new Error("refusing to inline CSS containing a closing style tag");
  }
  const sha256 = createHash("sha256").update(css, "utf8").digest("base64");
  return (
    `// GENERATED from ${SOURCES.join(", ")} — do not hand-edit.\n` +
    `// Regen: node ci/build-events-css.mjs.\n` +
    `export const EVENTS_CRITICAL_CSS: string =\n  ${JSON.stringify(css)};\n` +
    `export const EVENTS_CRITICAL_CSS_SHA256: string = ${JSON.stringify(sha256)};\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generate();
  const output = join(repoRoot, OUT);
  const temporary = `${output}.${randomUUID()}.tmp`;
  let fd = openSync(temporary, "wx");
  try {
    writeFileSync(fd, text);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, output);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
  console.log(`${OUT}: ${text.length} chars`);
}
