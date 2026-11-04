// Consumer adapters, not a second token source: values come only from the pinned
// kit CSS. Keep media contexts separate; the TS export has no reduced-motion layer.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const ARTIFACTS = [
  "public/theme-tokens.css",
  "public/theme.css",
  "web/src/ember-theme.css",
  "public/styles.css",
  "src/ember-fallback-style.ts",
  "web/src/error.html",
];

// Value-free role selection and aliasing. Omit Discord/layout/avatar roles and
// duplicate semantic synonyms, never a required web role or its media override.
export const ROLES = [
  ...Array.from({ length: 5 }, (_, n) => [`g${n}`, `color-ground-${n}`]),
  ["hair1", "color-hair-1"],
  ["hair2", "color-hair-2"],
  ...Array.from({ length: 3 }, (_, n) => [`t${n + 1}`, `color-text-${n + 1}`]),
  ...[
    "ember",
    "on-accent",
    "accent-hi",
    "border",
    "live",
    "echo",
    "ok",
    "danger",
    "warn",
    "live-bg",
    "ok-bg",
    "echo-bg",
    "warn-bg",
    "danger-bg",
  ].map((name) => [name, `color-${name}`]),
  ["focus-ring", "color-focus-ring"],
  ["focus-ring-on-accent", "color-focus-ring-on-accent"],
  ["focus-width", "size-focus-width"],
  ["focus-offset", "size-focus-offset"],
  ...Array.from({ length: 11 }, (_, n) => [`space-${n + 1}`, `space-${n + 1}`]),
  ...[
    "section",
    "section-compact",
    "inset-tag-y",
    "inset-tag-x",
    "inset-tight",
    "inset-room",
    "inset-compact",
    "inset-card",
    "inset-card-lg",
  ].map((name) => [`space-${name}`, `space-${name}`]),
  ...["s", "m", "l", "pill"].map((name) => [`radius-${name}`, `radius-${name}`]),
  ...[
    "hero",
    "h1",
    "h2",
    "h3",
    "figure",
    "title",
    "body-reading",
    "body",
    "small",
    "label",
    "band",
    "lede",
    "ui",
    "figure-compact",
    "tile",
  ].map((name) => [`font-size-${name}`, `font-size-${name}`]),
  ...["display", "h2", "h3", "figure", "body", "label"].map((name) => [
    `tracking-${name}`,
    `tracking-${name}`,
  ]),
  ...["display", "ui", "accent", "data"].map((name) => [`font-${name}`, `font-${name}`]),
  ...["regular", "medium", "display", "semibold"].map((name) => [
    `font-weight-${name}`,
    `font-weight-${name}`,
  ]),
  ...["body", "button", "display", "band"].map((name) => [
    `font-width-${name}`,
    `font-width-${name}`,
  ]),
  ...["display", "heading", "title", "body", "reading", "label"].map((name) => [
    `line-height-${name}`,
    `line-height-${name}`,
  ]),
  ...[
    "ease",
    "duration-fast",
    "duration-base",
    "duration-slow",
    "duration-enter",
    "distance-enter",
    "poll-live",
    "poll-stale-after",
  ].map((name) => [`motion-${name}`, `motion-${name}`]),
  ["gradient-brand", "gradient-brand"],
];

export function parseKit(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const structure = clean.match(
    /^:root\s*\{([^{}]*)\}\s*@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*:root\s*\{([^{}]*)\}\s*\}$/,
  );
  if (!structure)
    throw new Error("unknown kit CSS structure (expected base and reduced-motion rules)");
  const declarations = (body, reduced) => {
    const values = new Map();
    for (const part of body.split(";")) {
      if (!part.trim()) continue;
      const declaration = part.trim().match(/^(--two-[\w-]+|color-scheme)\s*:\s*(.+)$/);
      if (!declaration) throw new Error("invalid kit declaration");
      const [, name, value] = declaration;
      if (values.has(name)) throw new Error(`duplicate kit declaration ${name}`);
      if (reduced && !name.startsWith("--two-motion-"))
        throw new Error("unknown reduced-motion role");
      // The pinned formatter resolves references. A changed formatter needs a
      // deliberate adapter update, not silently unresolved dependencies.
      if (/var\(|[<>]|!important/.test(value))
        throw new Error(`unresolved or unsafe kit value ${name}`);
      values.set(name, value.trim());
    }
    return values;
  };
  const base = declarations(structure[1], false);
  const reduced = declarations(structure[2], true);
  if (base.get("color-scheme") !== "dark") throw new Error("kit must remain dark only");
  for (const name of [
    "ease",
    "duration-fast",
    "duration-base",
    "duration-slow",
    "duration-enter",
  ]) {
    if (!reduced.has(`--two-motion-${name}`)) throw new Error(`missing reduced-motion ${name}`);
  }
  for (const name of reduced.keys()) {
    if (!base.has(name)) throw new Error(`reduced-motion role has no base ${name}`);
  }
  return { base, reduced };
}

export function roleDeclarations(kit, roles = ROLES) {
  const aliases = new Set();
  return roles.map(([alias, source]) => {
    if (!/^[a-z][\w-]*$/.test(alias) || aliases.has(alias))
      throw new Error(`alias collision or invalid alias ${alias}`);
    aliases.add(alias);
    const value = kit.base.get(`--two-${source}`);
    if (value === undefined) throw new Error(`missing kit role --two-${source}`);
    // Preserve the measured local fallback without inventing a kit font role.
    const resolved = /^font-(display|ui)$/.test(alias)
      ? value.replace(/,/, ', "Mona Sans Fallback",')
      : value;
    return [alias, source, resolved];
  });
}

const aliases =
  "--ink:var(--color-text);--paper:var(--color-page);--brand:var(--color-accent);--muted:var(--color-muted);--surface:var(--color-surface);--line:var(--color-border);";
const colors = [
  ["text", "text"],
  ["page", "page"],
  ["accent", "accent"],
  ["muted", "muted"],
  ["surface", "surface"],
  ["border", "control-border"],
];
const schedule = '.base-theme.schedule-theme,.base-theme[data-theme="schedule"]';

export function generate(root = ROOT) {
  const version = readFileSync(join(root, "vendor/design-kit/VERSION"), "utf8").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid design-kit VERSION");
  const kit = parseKit(readFileSync(join(root, "vendor/design-kit/tokens.css"), "utf8"));
  const roles = roleDeclarations(kit);
  const get = (name) => {
    const value = kit.base.get(`--two-${name}`);
    if (value === undefined) throw new Error(`missing kit role --two-${name}`);
    return value;
  };
  const hooks = (prefix, kitStack = false) =>
    colors
      .map(([name, source]) => {
        const fallback = kitStack
          ? `var(--color-lobby-${{ text: "ink", page: "surface", accent: "accent", muted: "muted", surface: "raised", border: "line" }[name]})`
          : get(source);
        return `--color-${name}:var(--theme-${prefix}${name},${fallback});`;
      })
      .join("");
  // Keep palette/interaction roles in the facade and type scale in the shared
  // sheet; other roles live beside theme rules. All three sheets are already
  // served together. Scoping keeps legacy pages unchanged and fits the original
  // raw AND gzip ceilings without a new request or a budget increase.
  const foundation = ([alias]) =>
    /^(g\d$|t\d$|hair\d$|ember$|on-accent$|accent-hi$|border$|live|echo|ok|danger|warn|focus-)/.test(
      alias,
    );
  const shared = ([alias]) =>
    /^(font-size-|font-weight-|font-width-|line-height-|tracking-|space-\d+$|radius-)/.test(alias);
  const display = roles.find(([name]) => name === "font-display")[2];
  const declarations = (selected) =>
    selected
      .map(([alias, , value]) => {
        // Share equal pinned stacks, but follow either role if the kit diverges.
        return `--${alias}:${alias === "font-ui" && value === display ? "var(--font-display)" : value};`;
      })
      .join("");
  const facade = `.base-theme{${hooks("")}${aliases}color-scheme:dark;${declarations(roles.filter(foundation))}}${schedule}{${hooks("schedule-")}${aliases}}`;
  const reduced = roles
    .filter(([, source]) => kit.reduced.has(`--two-${source}`))
    .map(([alias, source]) => `--${alias}:${kit.reduced.get(`--two-${source}`)};`)
    .join("");
  const sharedCss = `.base-theme{${declarations(roles.filter(shared))}}`;
  const roleCss = `.base-theme{${declarations(roles.filter((role) => !foundation(role) && !shared(role)))}}@media(prefers-reduced-motion:reduce){.base-theme{${reduced}}}`;
  const source = readFileSync(join(root, "assets/theme.css"), "utf8");
  const sharedSource = readFileSync(join(root, "assets/styles.css"), "utf8");
  const compact = (css) =>
    transformSync(css, { loader: "css", minify: true, legalComments: "none" }).code;
  const kitColors = [
    ["surface", "surface"],
    ["raised", "raised"],
    ["ink", "text"],
    ["muted", "muted"],
    ["accent", "accent"],
    ["on-accent", "accent-ink"],
    ["line", "control-border"],
    ["focus", "accent"],
  ];
  const utility = (alias) => {
    if (
      /^(g\d|hair\d|t\d|ember|on-accent|accent-hi|border|live|echo|ok|danger|warn|focus-ring)/.test(
        alias,
      )
    )
      return `color-${alias}`;
    if (alias.startsWith("font-size-")) return alias.replace("font-size-", "text-");
    if (alias.startsWith("line-height-")) return alias.replace("line-height-", "leading-");
    return alias;
  };
  // Tailwind emits utility roles on demand. Shared author sheets already expose
  // every type/space/motion alias; keep only their missing foundation here.
  // Forcing every utility plus a second alias bridge duplicates those bytes.
  const kitCss = `/* GENERATED from two-design-kit ${version}; run node ci/build-ember-tokens.mjs. */\n@theme{${kitColors.map(([alias, source]) => `--color-lobby-${alias}:${get(source)};`).join("")}${roles.map(([alias, , value]) => `--${utility(alias)}:${value};`).join("")}--font-sans:var(--font-ui);}\n.base-theme{${hooks("", true)}${aliases}${declarations(roles.filter(foundation))}}\n${schedule}{${hooks("schedule-", true)}}\n`;
  const validation = transformSync(kitCss, { loader: "css", logLevel: "silent" });
  if (validation.warnings.length) throw new Error("invalid generated Kit stylesheet");
  // The catastrophic fallback must render without fonts or stylesheet fetches.
  // Generate its embedded roles and CSP hash together, retaining a system face.
  const fallbackStyle = `body{max-width:35rem;margin:3rem auto;padding:0 1.5rem;background:${get("color-ground-0")};color:${get("color-text-1")};font:1rem/1.6 system-ui;color-scheme:dark}a{display:inline-block;padding:.5rem;color:${get("color-ember")}}a:focus-visible{outline:${get("size-focus-width")} solid ${get("color-focus-ring")};outline-offset:${get("size-focus-offset")}}@media(forced-colors:active){a:focus-visible{outline-color:Highlight}}`;
  const fallbackHash = createHash("sha256").update(fallbackStyle).digest("base64");
  const fallbackModule = `// GENERATED from two-design-kit ${version}; run node ci/build-ember-tokens.mjs.\nexport const KIT_FALLBACK_INLINE_STYLE: string =\n  ${JSON.stringify(fallbackStyle)};\nexport const KIT_FALLBACK_STYLE_SHA256: string = "${fallbackHash}";\n`;
  const fallbackHtml = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">\n<title>Error — Together We Own</title>\n<style>${fallbackStyle}</style>\n<main><b>Together We Own</b><h1>%sveltekit.status%: Page unavailable</h1><p>Please try again later.</p><p><a href="/">Home</a> <a href="/events">Events</a></p></main>\n</html>\n`;
  return new Map([
    [ARTIFACTS[0], compact(facade)],
    [ARTIFACTS[1], compact(roleCss + source)],
    [ARTIFACTS[2], kitCss],
    [ARTIFACTS[3], compact(sharedSource + sharedCss)],
    [ARTIFACTS[4], fallbackModule],
    [ARTIFACTS[5], fallbackHtml],
  ]);
}

export function build(root = ROOT, check = false) {
  for (const [path, css] of generate(root)) {
    if (check) {
      if (readFileSync(join(root, path), "utf8") !== css)
        throw new Error(`generated token drift: ${path}`);
    } else {
      writeFileSync(join(root, path), css);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--check")) {
    console.error("Usage: node ci/build-ember-tokens.mjs [--check]");
    process.exitCode = 2;
  } else {
    try {
      build(ROOT, args[0] === "--check");
      console.log("ember adapters: in sync");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
