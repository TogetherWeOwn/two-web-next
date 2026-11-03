// Ember token sync: the Hono and Kit sheets must carry the kit's values.
//
// vendor/design-kit/tokens.css is the source of truth (pinned tag, drift
// gate in ci/check-design-kit-drift.mjs). The served sheets carry kit values
// as literals -- theme-tokens.css cannot @import the 8 KB kit file without
// blowing its budget and the inlined leaf bundle, and Tailwind @theme needs
// literals -- so this check fails when a sheet default differs from the
// vendored value. A kit update is VERSION + re-vendor + new literals here.
// Value mapping (old ramp to kit) in docs/home-theme.md.
//
// Usage: node ci/check-ember-token-sync.mjs [--selftest]
// Stdout is pure JSON (pipe it to jq); the human one-liner goes to stderr.
// Exit 0 is pass, 1 is drift, 2 is usage.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VENDOR_CSS = join(ROOT, "vendor/design-kit/tokens.css");
const HONO_TOKENS = join(ROOT, "public/theme-tokens.css");
const HONO_THEME = join(ROOT, "public/theme.css");
const KIT_APP = join(ROOT, "web/src/app.css");

// [sheet declaration, kit variable]. Hook names stay ours; values stay kit's.
const HONO_MAP = [
  ["--color-text", "--two-text"],
  ["--color-page", "--two-page"],
  ["--color-accent", "--two-accent"],
  ["--color-muted", "--two-muted"],
  ["--color-surface", "--two-surface"],
  ["--color-border", "--two-control-border"],
  ["--font-display", "--two-font-display"],
];
const KIT_MAP = [
  ["--color-lobby-surface", "--two-surface"],
  ["--color-lobby-raised", "--two-raised"],
  ["--color-lobby-ink", "--two-text"],
  ["--color-lobby-muted", "--two-muted"],
  ["--color-lobby-accent", "--two-accent"],
  ["--color-lobby-on-accent", "--two-accent-ink"],
  ["--color-lobby-line", "--two-control-border"],
  ["--color-lobby-focus", "--two-accent"],
  ["--font-display", "--two-font-display"],
];

function fail(message) {
  console.error(message);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

const norm = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

// A Hono default is `var(--theme-*, <kit literal>)`; a Kit @theme value is
// the literal. Either way the literal must equal the vendored kit value.
function literalOf(declarationValue) {
  const hooked = declarationValue.match(/^var\(--theme[a-z-]*,\s*(.+)\)$/);
  return norm(hooked ? hooked[1] : declarationValue);
}

function parseVars(css) {
  const vars = new Map();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    vars.set(match[1], norm(match[2]));
  }
  return vars;
}

function checkFile(path, map, vendor, scope) {
  const css = readFileSync(path, "utf8");
  // The Kit sheet also maps the same hooks onto the lobby utilities outside
  // @theme; only the @theme block carries kit literals, so scope to it.
  const body = scope ? (css.match(scope)?.[1] ?? fail(`${path} lost its @theme block`)) : css;
  const found = [];
  for (const [decl, kitVar] of map) {
    const re = new RegExp(`${decl}\\s*:\\s*([^;{}]+);`, "g");
    const matches = [...body.matchAll(re)];
    if (matches.length === 0) fail(`${path} no longer defines ${decl}`);
    for (const match of matches) {
      const got = literalOf(match[1]);
      const want = vendor.get(kitVar);
      if (want === undefined) fail(`vendored kit output lost ${kitVar}`);
      if (got !== want) {
        fail(`${path} ${decl} is ${got}, vendored ${kitVar} is ${want}`);
      }
      found.push(decl);
    }
  }
  return found;
}

function selftest() {
  if (HONO_MAP.length === 0 || KIT_MAP.length === 0) fail("mapping table is empty");
  const vendor = parseVars(readFileSync(VENDOR_CSS, "utf8"));
  if (vendor.size === 0) fail("vendored kit output has no variables");
  const hono = checkFile(HONO_TOKENS, HONO_MAP, vendor);
  const kit = checkFile(KIT_APP, KIT_MAP, vendor, /@theme\s*\{([^}]*)\}/);
  const theme = readFileSync(HONO_THEME, "utf8");
  const focus = theme.match(/\.base-theme\s*:focus-visible\s*\{([^}]*)\}/);
  if (!focus || !/outline:\s*2px solid var\(--brand\)/.test(focus[1])) {
    fail("public/theme.css lost the 2px ember :focus-visible ring");
  }
  if (!/outline-offset:\s*3px/.test(focus[1])) fail("public/theme.css lost the 3px focus offset");
  if (!/color-scheme:\s*dark/.test(readFileSync(HONO_TOKENS, "utf8"))) {
    fail("public/theme-tokens.css lost color-scheme: dark");
  }
  const summary = `ember token sync selftest ok (${hono.length} hono, ${kit.length} kit)`;
  console.error(summary);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "selftest", summary })}\n`);
}

function check() {
  const vendor = parseVars(readFileSync(VENDOR_CSS, "utf8"));
  const hono = checkFile(HONO_TOKENS, HONO_MAP, vendor);
  const kit = checkFile(KIT_APP, KIT_MAP, vendor, /@theme\s*\{([^}]*)\}/);
  const summary = `ember token sync ok (${hono.length} hono, ${kit.length} kit)`;
  console.error(summary);
  process.stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
} else if (args.length === 0) {
  check();
} else {
  console.error("usage: node ci/check-ember-token-sync.mjs [--selftest]");
  process.exit(2);
}
