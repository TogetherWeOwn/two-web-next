#!/usr/bin/env node
// Bundle the critical stylesheets into generated modules so the Worker can
// inline them without a filesystem read: the staging Lighthouse audit
// measured mobile /rules LCP just over budget with render-blocking-resources
// savings of ~150 ms across styles.css, theme-tokens.css and theme.css,
// while the <link rel="preload"> hints for those same files measured zero
// effect (the whole head fits the first response chunk). Inlining removes
// all three render-blocking requests from the homepage and the content
// leaves (/about, /faq, /rules, /privacy — the only theme="content" pages);
// each <style> block is allowlisted by its own sha256 hash, so style-src
// keeps no 'unsafe-inline'.
//
// Two bundles, one command:
// - HOME_CRITICAL_CSS (src/home-critical-css.ts): exactly the three shared
//   sources. This is all the homepage ever inlines, which is what keeps "/"
//   inside its hard byte caps (test/homepage-mobile-lcp-acceptance.test.ts,
//   test/home-theme.test.ts).
// - LEAF_CRITICAL_CSS (src/leaf-critical-css.ts): the shared sources plus
//   the leaf-only seam, assets/leaf-only.css. Rules only the content leaves
//   need (for example leaf-scoped print rules) belong in that seam, never in
//   public/theme.css: theme.css is a shared source, so anything added there
//   also lands on "/" and every externally-styled shell. The seam is a
//   build input only — it is not served from public/, carries no
//   bundle-budget or AUTHORED_CSS entry and is never linked.
//
// Regen: node ci/build-leaf-css.mjs (drift is pinned by
// test/leaf-css-delivery-acceptance.test.ts — CI fails until this is re-run).
// Keep font-fallback rationale here rather than shipping it in theme.css and
// again in the inlined block: Latin-only, Arial-metric fallback; arrows (U+2192)
// keep prior rendering. Overrides = Display's 93%/34.6% ascent/descent at 77% +
// margin: fallback hero paints >= swapped-in text (no larger repaint).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_SOURCES = ["public/styles.css", "public/theme-tokens.css", "public/theme.css"];
const LEAF_ONLY_SOURCE = "assets/leaf-only.css";
const BUNDLES = [
  { name: "HOME", sources: SHARED_SOURCES, out: "src/home-critical-css.ts" },
  {
    name: "LEAF",
    sources: [...SHARED_SOURCES, LEAF_ONLY_SOURCE],
    out: "src/leaf-critical-css.ts",
  },
];

export function buildBundle(sources, name) {
  const css = sources.map((entry) => readFileSync(join(repoRoot, entry), "utf8")).join("\n");
  if (/<\/style/i.test(css)) {
    throw new Error("refusing to inline CSS containing a closing style tag");
  }
  const sha256 = createHash("sha256").update(css, "utf8").digest("base64");
  const text =
    `// GENERATED from ${sources.join(", ")} — do not hand-edit.\n` +
    `// Regen: node ci/build-leaf-css.mjs (drift is pinned by test/leaf-css-delivery-acceptance.test.ts).\n` +
    `export const ${name}_CRITICAL_CSS: string =\n  ${JSON.stringify(css)};\n` +
    `export const ${name}_CRITICAL_CSS_SHA256: string = ${JSON.stringify(sha256)};\n`;
  return { text, sha256 };
}

for (const bundle of BUNDLES) {
  const { text, sha256 } = buildBundle(bundle.sources, bundle.name);
  writeFileSync(join(repoRoot, bundle.out), text);
  console.log(`${bundle.out}: ${text.length} chars, sha256 ${sha256}`);
}
