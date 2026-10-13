#!/usr/bin/env node
// Bundle the content-leaf stylesheets into a generated module so the Worker
// can inline them without a filesystem read. Follow-up to #808: the staging
// mobile audit regressed on all four content leaves (/about LCP 2239, /faq
// 2255, /rules 2250, /privacy 2197 against the 2000ms budget) right after
// #808 inlined the three stylesheets wholesale. The failing traces show
// healthy server response with render delay at ~74% of LCP, and the
// mainthread-work-breakdown pins the mechanism: style & layout cost went
// from 32.5ms observed (pre-inline green staging run) to 99.8ms observed
// (red staging run) while every other phase stayed flat. Under the audit's
// 4x CPU slowdown that ~67ms triples into the ~360ms LCP regression. The
// document grew 6.9KB -> 24.6KB of mostly dead rules (hero, join, recovery,
// admin, featured, error-search chrome never renders on leaves).
//
// So this builder inlines only the content-leaf-critical subset: every rule
// whose selector is listed in DROP_SELECTORS is removed. The list was derived
// empirically (element matching over the four rendered leaves at mobile and
// desktop widths; keep-policy: @font-face, :root, pseudo-class/element and
// otherwise dynamic selectors are never dropped) and is guarded by
// test/leaf-css-drift.test.ts, which fails closed if a dropped selector ever
// matches a rendered leaf again. SUBSET_BUDGET_BYTES fails the build if the
// subset re-bloats. The <style> block stays allowlisted by its sha256 hash,
// so style-src keeps no 'unsafe-inline'.
// Regen: node ci/build-leaf-css.mjs (drift is pinned by
// test/leaf-css-drift.test.ts — CI fails until this is re-run).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["public/styles.css", "public/theme-tokens.css", "public/theme.css"];
const OUT = "src/leaf-critical-css.ts";
// The subset measures ~10KB; 12KB leaves room for leaf-scoped additions
// while keeping style & layout cost near the pre-regression floor.
export const SUBSET_BUDGET_BYTES = 12 * 1024;

// Selectors proven to match zero elements across the rendered content leaves.
// Plain entries drop top-level rules; "media || selector" entries drop rules
// inside that @media block only. Whitespace-insensitive (see canonSelector).
// NEVER add a pseudo-class/element or otherwise dynamic selector here:
// build() refuses such entries, and the drift test guards every entry.
export const DROP_SELECTORS = [
  "(max-width: 48rem) || .base-theme .community-grid",
  "(max-width: 48rem) || .base-theme .hero",
  "(max-width: 48rem) || .base-theme .hero .strap",
  "(max-width: 48rem) || .base-theme .hero h1",
  "(max-width: 48rem) || .base-theme .hero-detail",
  "(max-width: 48rem) || .base-theme .join-layout",
  "(max-width: 48rem) || .base-theme .who",
  "(max-width: 48rem) || .join-preview",
  "(max-width: 60rem) || .base-theme .community-grid",
  "(max-width: 60rem) || .base-theme .home-events",
  "(max-width: 60rem) || .base-theme .join-layout",
  "(max-width: 60rem) || .join-panel",
  "(max-width:40rem) || .home-events",
  "(min-width: 60rem) || .base-theme [data-testid='featured-content'] .facts",
  ".actions",
  ".admin-table",
  ".admin-table th,.admin-table td",
  ".avatar",
  ".avatar img",
  ".avatar img,.avatar-initial",
  ".avatar-initial",
  ".base-theme .community-grid",
  ".base-theme .community-grid section",
  ".base-theme .community-intro h3",
  ".base-theme .community-ladder h2",
  ".base-theme .counts",
  ".base-theme .counts strong",
  ".base-theme .error-events-search",
  ".base-theme .error-events-search button",
  ".base-theme .error-events-search input",
  ".base-theme .featured-image",
  ".base-theme .header-account .link",
  ".base-theme .header-account form",
  ".base-theme .header-account form .account-caption",
  ".base-theme .hero",
  ".base-theme .hero .strap",
  ".base-theme .hero h1",
  ".base-theme .hero-detail",
  ".base-theme .hero-detail span",
  ".base-theme .hero-detail-left",
  ".base-theme .hero-detail-right",
  ".base-theme .home-event-link",
  ".base-theme .home-event-link time",
  ".base-theme .join-layout",
  ".base-theme .notice",
  ".base-theme .recovery-actions",
  ".base-theme .recovery-actions a",
  ".base-theme .recovery-code",
  ".base-theme .recovery-events",
  ".base-theme .recovery-events .card > a",
  ".base-theme .recovery-events .facts",
  ".base-theme .recovery-hero h1",
  ".base-theme .who",
  '.base-theme.schedule-theme, .base-theme[data-theme="schedule"]',
  ".counts",
  ".error-events-search button",
  ".error-events-search input",
  ".error-events-search label",
  ".error-events-search>div",
  ".featured-form",
  ".featured-image",
  ".featured-status",
  ".featured-status-expired,.featured-status-unpublished",
  ".featured-status-live",
  ".featured-status-scheduled",
  ".featured-table",
  ".featured-table th,.featured-table td",
  ".featured-table th,.featured-table time",
  ".featured-table-scroll,.admin-table-scroll",
  ".featured-window-bound",
  ".field",
  ".field .error",
  ".field .hint",
  ".field input,.field textarea,.field select",
  ".field label",
  ".filters",
  ".filters .field",
  ".hero h1",
  ".home-event-link",
  ".home-event-link h3",
  ".home-events",
  ".join-actions",
  ".join-panel",
  ".join-preview",
  ".join-preview .strap",
  ".join-preview iframe",
  ".notice",
  ".rank-stack",
  ".rank-stack dd",
  ".sr-only",
  ".who",
  "button.link",
  "section.hero",
];

// Dynamic selectors always apply (hover/focus/aria/hidden states) and can
// never be proven dead from a static render, so they are never droppable.
const PSEUDO_RE =
  /::|:hover|:focus|:focus-visible|:focus-within|:active|:visited|:link|:first|:last|:nth|:not\(|:has\(|:is\(|:where\(|\[hidden\]/;

export const canonSelector = (s) =>
  s
    .replace(/'/g, '"')
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*([>+~])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// Split `selector { ... }` rules at depth zero, preserving exact source spans
// (kept rules are re-emitted byte-identical; inter-rule text is dropped).
// Braces inside comments and strings never count: a future `content: "{"`
// must mis-split loudly (via the balance check) rather than corrupt output.
export function splitRules(css) {
  const rules = [];
  let depth = 0;
  let ruleStart = 0;
  let selector = "";
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated CSS comment while building leaf CSS");
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) i += css[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "{") {
      if (depth === 0) selector = css.slice(ruleStart, i);
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector, body: css.slice(ruleStart, i + 1) });
        ruleStart = i + 1;
      }
      if (depth < 0) throw new Error("unbalanced CSS braces while building leaf CSS");
    }
    i++;
  }
  if (depth !== 0) throw new Error("unbalanced CSS braces while building leaf CSS");
  return rules;
}

export function build() {
  const css = SOURCES.map((entry) => readFileSync(join(repoRoot, entry), "utf8")).join("\n");
  if (/<\/style/i.test(css)) {
    throw new Error("refusing to inline CSS containing a closing style tag");
  }
  const dropTop = new Set();
  const dropInMedia = new Map();
  for (const entry of DROP_SELECTORS) {
    const sep = entry.indexOf(" || ");
    const rawMedia = sep === -1 ? null : entry.slice(0, sep);
    const rawSel = sep === -1 ? entry : entry.slice(sep + 4);
    if (PSEUDO_RE.test(rawSel)) {
      throw new Error(`refusing to drop dynamic selector: ${entry}`);
    }
    if (rawMedia === null) {
      dropTop.add(canonSelector(rawSel));
    } else {
      const key = canonSelector(rawMedia);
      if (!dropInMedia.has(key)) dropInMedia.set(key, new Set());
      dropInMedia.get(key).add(canonSelector(rawSel));
    }
  }
  const matched = new Set();
  const filterList = (rules, mediaKey) => {
    const out = [];
    for (const rule of rules) {
      const sel = rule.selector.trim();
      if (sel.startsWith("@media")) {
        const open = rule.body.indexOf("{");
        const inner = splitRules(rule.body.slice(open + 1, -1));
        const keptInner = filterList(inner, canonSelector(sel.slice("@media".length)));
        if (keptInner.length > 0) out.push(`${sel}{${keptInner.join("")}}`);
        continue;
      }
      if (sel.startsWith("@")) {
        out.push(rule.body);
        continue;
      }
      const key = canonSelector(sel);
      const dropSet = mediaKey === null ? dropTop : dropInMedia.get(mediaKey);
      if (dropSet !== undefined && dropSet.has(key) && !PSEUDO_RE.test(sel)) {
        matched.add(mediaKey === null ? key : `${mediaKey} || ${key}`);
        continue;
      }
      out.push(rule.body);
    }
    return out;
  };
  const subset = filterList(splitRules(css), null).join("");
  const expected = new Set();
  for (const entry of DROP_SELECTORS) {
    const sep = entry.indexOf(" || ");
    expected.add(
      sep === -1
        ? canonSelector(entry)
        : `${canonSelector(entry.slice(0, sep))} || ${canonSelector(entry.slice(sep + 4))}`,
    );
  }
  const unmatched = [...expected].filter((key) => !matched.has(key));
  if (unmatched.length > 0) {
    throw new Error(`leaf CSS DROP entries matched no rule (stale list?): ${unmatched.join("; ")}`);
  }
  if (subset.length > SUBSET_BUDGET_BYTES) {
    throw new Error(
      `leaf CSS subset is ${subset.length} bytes, over the ${SUBSET_BUDGET_BYTES}-byte budget`,
    );
  }
  const sha256 = createHash("sha256").update(subset, "utf8").digest("base64");
  const text =
    `// GENERATED from ${SOURCES.join(", ")} minus content-leaf-dead selectors — do not hand-edit.\n` +
    `// Regen: node ci/build-leaf-css.mjs (drift is pinned by test/leaf-css-drift.test.ts).\n` +
    `export const LEAF_CRITICAL_CSS: string =\n  ${JSON.stringify(subset)};\n` +
    `export const LEAF_CRITICAL_CSS_SHA256: string = ${JSON.stringify(sha256)};\n`;
  return { text, sha256, css: subset };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { text, sha256, css } = build();
  writeFileSync(join(repoRoot, OUT), text);
  console.log(`${OUT}: ${css.length} css bytes, sha256 ${sha256}`);
}
