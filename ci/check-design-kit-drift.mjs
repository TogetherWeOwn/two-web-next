// Design-kit drift gate: the vendored kit outputs must match the pinned tag.
//
// Per the kit pinning README, two-web-next vendors the built files and pins
// a release tag in vendor/design-kit/VERSION. This check fails when the
// vendored copies differ from the tag's generated outputs, so a silent
// hand-edit or a stale vendor cannot pass `npm run check`.
//
// Usage: node ci/check-design-kit-drift.mjs [--selftest]
// Stdout is pure JSON (pipe it to jq); the human one-liner goes to stderr.
// Exit 0 is pass, 1 is drift, 2 is usage.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KIT_DIR = join(ROOT, "vendor/design-kit");
const VERSION_PATH = join(KIT_DIR, "VERSION");
const CSS_PATH = join(KIT_DIR, "tokens.css");
const TS_PATH = join(KIT_DIR, "tokens.ts");
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(message);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function readVersion() {
  let raw;
  try {
    raw = readFileSync(VERSION_PATH, "utf8").trim();
  } catch {
    fail(`missing ${VERSION_PATH}: run the kit README sync for the pinned tag`);
  }
  if (!TAG_PATTERN.test(raw)) {
    fail(`bad kit tag ${JSON.stringify(raw)} in vendor/design-kit/VERSION: want vX.Y.Z`);
  }
  return raw;
}

function selftest() {
  const tag = readVersion();
  const css = readFileSync(CSS_PATH, "utf8");
  const ts = readFileSync(TS_PATH, "utf8");
  if (css.length === 0 || ts.length === 0) fail("vendored kit output is empty");
  if (!css.startsWith("/* DO NOT EDIT")) fail("tokens.css lost its generated header");
  if (!ts.startsWith("// DO NOT EDIT")) fail("tokens.ts lost its generated header");
  if (!css.includes("--two-color-bg-canvas")) fail("tokens.css misses --two-color-bg-canvas");
  if (!ts.includes("twoColorBgCanvas")) fail("tokens.ts misses twoColorBgCanvas");
  console.error(`design-kit drift selftest ok at ${tag}`);
  process.stdout.write(`${JSON.stringify({ ok: true, tag, mode: "selftest" })}\n`);
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) fail(`kit fetch ${res.status} for ${url}`);
    return await res.text();
  } catch (error) {
    fail(`kit fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function check() {
  const tag = readVersion();
  const base = `https://raw.githubusercontent.com/TogetherWeOwn/two-design-kit/${tag}`;
  const [wantCss, wantTs] = await Promise.all([
    fetchText(`${base}/dist/css/tokens.css`),
    fetchText(`${base}/dist/ts/tokens.ts`),
  ]);
  const gotCss = readFileSync(CSS_PATH, "utf8");
  const gotTs = readFileSync(TS_PATH, "utf8");
  const drift = [];
  if (gotCss !== wantCss)
    drift.push(`tokens.css differs from ${tag} (local ${gotCss.length}B, tag ${wantCss.length}B)`);
  if (gotTs !== wantTs)
    drift.push(`tokens.ts differs from ${tag} (local ${gotTs.length}B, tag ${wantTs.length}B)`);
  if (drift.length > 0) fail(drift.join("; "));
  console.error(`design-kit drift ok at ${tag}`);
  process.stdout.write(`${JSON.stringify({ ok: true, tag })}\n`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
} else if (args.length === 0) {
  await check();
} else {
  console.error("usage: node ci/check-design-kit-drift.mjs [--selftest]");
  process.exit(2);
}
