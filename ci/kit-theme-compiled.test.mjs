// Run after the real Kit build; no fixture utility classes keep these roles alive.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const client = "web/.svelte-kit/output/client/_app";

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith(".css") ? [path] : [];
  });
}

test("compiled Kit CSS retains pinned theme variables without utility references", () => {
  const files = cssFiles(client);
  assert.ok(files.length > 0, "Kit client CSS exists");
  const sheets = files.map((path) => readFileSync(path, "utf8"));
  const roots = sheets.flatMap((css) => [...css.matchAll(/:root(?:\s*,\s*:host)?\s*\{([^}]*)\}/g)]);
  assert.ok(roots.length > 0, "compiled CSS includes a root theme");
  const declarations = roots.map((match) => match[1]).join(";");
  for (const [name, value] of [
    ["space-inset-card-lg", "28px"],
    ["radius-pill", "999px"],
    ["font-width-button", "105%"],
    ["text-body", "16px"],
  ]) {
    assert.match(declarations, new RegExp(`(?:^|;)\\s*--${name}\\s*:\\s*${value}(?:;|$)`), name);
  }
  const raw = sheets.reduce((sum, css) => sum + Buffer.byteLength(css), 0);
  const gzip = sheets.reduce((sum, css) => sum + gzipSync(css).length, 0);
  console.log(`Kit client CSS: ${raw} raw bytes, ${gzip} gzip bytes (per-file sum; report only)`);
});
