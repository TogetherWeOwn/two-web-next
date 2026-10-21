// Theme acceptance helpers: the one-file theme-swap contract in executable
// form. Test-Author-owned: the Builder implements against these files and
// never edits them.
//
// Contract source is the brand kit (BRAND-SYSTEM.md): section 6 names the
// semantic tokens every theme must define, section 2 fixes the Logo 1
// values, and section 1 lists every hard-coded colour the swap consolidates.
// Where the draft tokens.css and the section 6 contract disagree on a name,
// both names are accepted below and the docs must name the canonical one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ContractToken {
  /** Short name from the brand-kit section 6 contract list. */
  key: string;
  /** Accepted CSS custom-property spellings (contract name first). */
  vars: string[];
  /** Logo 1 value, or a symbolic expectation documented per token. */
  value: string;
}

// The 20 semantic tokens every theme must define (brand-kit section 6:
// text page accent accent-ink accent-hover muted surface raised border
// focus-ring link success warn danger violet violet-deep gradient-brand
// gradient-brand-h display-font body-font).
export const THEME_CONTRACT: ContractToken[] = [
  { key: "text", vars: ["--theme-text"], value: "#F7F7F7" },
  { key: "page", vars: ["--theme-page"], value: "#141117" },
  { key: "accent", vars: ["--theme-accent"], value: "#FF9C36" },
  { key: "accent-ink", vars: ["--theme-accent-ink"], value: "#1D0B00" },
  { key: "accent-hover", vars: ["--theme-accent-hover"], value: "#D47500" },
  { key: "muted", vars: ["--theme-muted"], value: "#BDB7D1" },
  { key: "surface", vars: ["--theme-surface"], value: "#1E1A25" },
  { key: "raised", vars: ["--theme-raised"], value: "#272133" },
  { key: "border", vars: ["--theme-border"], value: "#3C344C" },
  // Section 6 says focus-ring; the draft theme file spells it --theme-focus.
  { key: "focus-ring", vars: ["--theme-focus", "--theme-focus-ring"], value: "#FF9C36" },
  { key: "link", vars: ["--theme-link"], value: "#FFA94D" },
  { key: "success", vars: ["--theme-success"], value: "#3DDC84" },
  { key: "warn", vars: ["--theme-warn"], value: "#FFB020" },
  { key: "danger", vars: ["--theme-danger"], value: "#FF6B8A" },
  { key: "violet", vars: ["--theme-violet"], value: "#5701AE" },
  { key: "violet-deep", vars: ["--theme-violet-deep"], value: "#3A0086" },
  { key: "gradient-brand", vars: ["--theme-gradient-brand"], value: "gradient-180" },
  { key: "gradient-brand-h", vars: ["--theme-gradient-brand-h"], value: "gradient-90" },
  // Section 6 says display-font/body-font; the draft theme file spells them
  // --two-font-display/--two-font-body on :root. Either spelling satisfies
  // the contract as long as the stack starts with the brand face.
  {
    key: "display-font",
    vars: ["--two-font-display", "--theme-display-font"],
    value: "Chakra Petch",
  },
  { key: "body-font", vars: ["--two-font-body", "--theme-body-font"], value: "Inter" },
];

// Extra semantic the draft theme file ships beyond the section 6 list.
export const THEME_PINK: ContractToken = {
  key: "pink",
  vars: ["--theme-pink"],
  value: "#FF0E52",
};

// Variant plugs: schedule/event/profile variants re-plug these seven base
// semantics (brand-kit section 6). Only the schedule variant exists today;
// it demonstrates the mechanism, and the event/profile layout sheets keep
// inheriting the base plugs with zero literals of their own.
export const VARIANT_PLUGS: Array<{ suffix: string; value: string }> = [
  { suffix: "text", value: "#F7F7F7" },
  { suffix: "page", value: "#141117" },
  { suffix: "accent", value: "#FF9C36" },
  { suffix: "accent-ink", value: "#1D0B00" },
  { suffix: "muted", value: "#BDB7D1" },
  { suffix: "surface", value: "#1E1A25" },
  { suffix: "border", value: "#3C344C" },
];

// Kit lobby values after the swap (brand-kit section 6 mapping table). Names
// stay so components keep their utilities; values become Logo 1.
export const KIT_LOBBY_VALUES: Record<string, string> = {
  "--color-lobby-surface": "#141117",
  "--color-lobby-raised": "#1E1A25",
  "--color-lobby-ink": "#F7F7F7",
  "--color-lobby-muted": "#BDB7D1",
  "--color-lobby-accent": "#FF9C36",
  "--color-lobby-on-accent": "#1D0B00",
  "--color-lobby-line": "#3C344C",
  "--color-lobby-focus": "#FF9C36",
};

// Pre-swap defaults that must be gone from theme declarations (both shells
// used different limes/charcoals; section 1 calls out the split).
export const STALE_THEME_VALUES = new Set(
  [
    "#c2f45b",
    "#a3ff12",
    "#121719",
    "#151720",
    "#f5f5eb",
    "#f5f6fb",
    "#b5c1c1",
    "#c6cbea",
    "#1e292c",
    "#222430",
    "#4b5b5d",
    "#41465c",
    "#14200a",
    "#ffffff",
  ].map((hex) => hex.toLowerCase()),
);

// Logo 1 gradient stops: ember orange top, signal pink mid at 52.12%, deep
// violet bottom (icon vector direction); horizontal variant runs violet to
// orange left to right.
export const GRADIENT_STOPS = ["#ff9c36", "#ff0e52", "#5701ae"];

/** Parse every `--name: value;` declaration, comments excluded. */
export function parseCustomProperties(css: string): Map<string, string[]> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = new Map<string, string[]>();
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    const name = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (name === "") {
      continue;
    }
    const seen = out.get(name) ?? [];
    seen.push(value);
    out.set(name, seen);
  }
  return out;
}

/** First declared value for any of the accepted spellings, if present. */
export function lookupVar(vars: Map<string, string[]>, names: string[]): string | undefined {
  for (const name of names) {
    const values = vars.get(name);
    if (values !== undefined && values.length > 0) {
      return values[0];
    }
  }
  return undefined;
}

/** Strip block/line comments and HTML entities before literal matching. */
export function stripCommentsAndEntities(text: string): string {
  const blankLines = (comment: string): string => comment.replace(/[^\n]/g, " ");
  return (
    text
      // Block comments collapse to same-line whitespace so finding line
      // numbers still cite the source file exactly.
      .replace(/\/\*[\s\S]*?\*\//g, blankLines)
      // Line comments start at a boundary so URL schemes (https://) survive.
      .replace(/(^|[\s;{}])\/\/[^\n]*/g, "$1 ")
      .replace(/&#[0-9a-zA-Z]+;/g, " ")
  );
}

const COLOUR_PATTERN =
  "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\\b" +
  "|\\brgba?\\s*\\([^)]*\\)" +
  "|\\bhsla?\\s*\\([^)]*\\)" +
  "|\\boklch\\s*\\([^)]*\\)";

export function colourRegex(): RegExp {
  return new RegExp(COLOUR_PATTERN, "g");
}

export function colourRegexInsensitive(): RegExp {
  return new RegExp(COLOUR_PATTERN, "gi");
}

export interface SweepFinding {
  file: string;
  line: number;
  match: string;
}

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".svelte",
  ".html",
  ".json",
  ".webmanifest",
]);

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") {
        continue;
      }
      walkFiles(full, out);
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * Scan the shipped theme surface for raw colour literals. Roots cover the
 * Hono app, the Kit app, the reviewed asset sources, and the authored
 * public sheets plus the webmanifest. Generated outputs (minified island
 * bundles), binary assets, docs, tests, and tooling are out of scope.
 * Callers pass the allowlisted theme files; SVG brand assets are always
 * allowed, and guard-probe fixtures are ignored for cross-test isolation.
 */
export function sweepColourLiterals(repoRoot: string, allowRelPaths: Set<string>): SweepFinding[] {
  const roots = ["src", "web/src", "assets", "public"];
  const findings: SweepFinding[] = [];
  for (const root of roots) {
    const files: string[] = [];
    walkFiles(join(repoRoot, root), files);
    files.sort();
    for (const full of files) {
      const rel = relative(repoRoot, full).split(sep).join("/");
      if (rel.includes("__theme_guard_probe__")) {
        continue;
      }
      if (rel.endsWith(".svg") || rel.endsWith(".svgx")) {
        continue;
      }
      if (allowRelPaths.has(rel)) {
        continue;
      }
      // Generated outputs: minified island bundles, fonts, rasters.
      if (rel.startsWith("public/islands/")) {
        continue;
      }
      if (/\.(png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|map)$/i.test(rel)) {
        continue;
      }
      const dot = rel.lastIndexOf(".");
      const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
      if (!SCAN_EXTENSIONS.has(ext)) {
        continue;
      }
      const raw = readFileSync(full, "utf8");
      const clean = stripCommentsAndEntities(raw);
      const re = colourRegexInsensitive();
      let match: RegExpExecArray | null;
      while ((match = re.exec(clean)) !== null) {
        findings.push({ file: rel, line: lineOf(clean, match.index), match: match[0] });
      }
    }
  }
  return findings;
}

export function formatFindings(findings: SweepFinding[], limit = 30): string {
  const lines = findings.slice(0, limit).map((finding) => {
    return `${finding.file}:${finding.line}: ${finding.match}`;
  });
  if (findings.length > limit) {
    lines.push(`... and ${findings.length - limit} more`);
  }
  return lines.join("\n");
}

export interface AlternateTheme {
  path: string;
  vars: Map<string, string[]>;
  mechanism: "drop-in" | "data-attribute";
  attribute: string | null;
}

/**
 * Discover the Builder-owned throwaway theme (for example a high-contrast
 * file) in public/ or the test fixtures. It must define nearly the whole
 * contract with values that differ from the default, either as a drop-in
 * replacement for the theme file or as data-attribute overrides.
 */
export function discoverAlternateTheme(repoRoot: string): AlternateTheme | null {
  const defaultVars = parseCustomProperties(
    readFileSync(join(repoRoot, "public/theme-tokens.css"), "utf8"),
  );
  const candidates: string[] = [];
  for (const entry of readdirSync(join(repoRoot, "public"))) {
    if (!entry.endsWith(".css")) {
      continue;
    }
    if (
      entry === "theme-tokens.css" ||
      entry === "theme.css" ||
      entry === "event-theme.css" ||
      entry === "profile-theme.css" ||
      entry === "schedule-theme.css" ||
      entry === "styles.css"
    ) {
      continue;
    }
    candidates.push(`public/${entry}`);
  }
  const fixtureRoot = join(repoRoot, "test/fixtures");
  try {
    const fixtureFiles: string[] = [];
    walkFiles(fixtureRoot, fixtureFiles);
    for (const full of fixtureFiles) {
      if (full.endsWith(".css")) {
        candidates.push(relative(repoRoot, full).split(sep).join("/"));
      }
    }
  } catch {
    // No fixtures directory yet; public candidates still apply.
  }
  candidates.sort();
  for (const rel of candidates) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    const vars = parseCustomProperties(text);
    let present = 0;
    let differed = 0;
    for (const token of THEME_CONTRACT) {
      const value = lookupVar(vars, token.vars);
      if (value === undefined) {
        continue;
      }
      present += 1;
      const baseline = lookupVar(defaultVars, token.vars);
      if (baseline === undefined || value.toLowerCase() !== baseline.toLowerCase()) {
        differed += 1;
      }
    }
    if (present < 15 || differed < 10) {
      continue;
    }
    const attribute = text.match(/\[data-theme=(["']?)([a-zA-Z0-9_-]+)\1\]/);
    if (attribute !== null) {
      return { path: rel, vars, mechanism: "data-attribute", attribute: attribute[2] ?? null };
    }
    if (text.includes(".base-theme")) {
      return { path: rel, vars, mechanism: "drop-in", attribute: null };
    }
  }
  return null;
}
