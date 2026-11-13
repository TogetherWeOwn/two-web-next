import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const css = readFileSync("web/src/app.css", "utf8");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { parse } = webRequire("svelte/compiler");

// Global inline exclusions drop these candidates from every component.
const globalExcluded = ["visible", "relative", "static", "block", "hidden", "table"];
// File-local exclusions (`@source not "<path>"`) drop every candidate in a file.
// Those files may only use Hono twin sheet classes, never Tailwind utilities.
const localExcludedFiles = () => [
  "web/src/lib/SiteMetadata.svelte",
  ...globSync("web/src/routes/admin/join-attempts/**/*.svelte"),
];
const localClasses = new Set([
  "hint",
  "filters",
  "field",
  "btn",
  "admin-table-scroll",
  "admin-table",
  "actions",
  "support-reference",
]);

type Uses = { tokens: Set<string>; unknown: string[] };
type Node = { type?: string; [key: string]: unknown };

const split = (value: string, uses: Uses) => {
  for (const token of value.split(/\s+/)) if (token) uses.tokens.add(token);
};

const maxAlternatives = 256;

// Every possible string for a finite class producer, or null when unresolved.
// Nothing is executed: only literals, templates, `+`, conditionals, logical
// operands, arrays and objects are folded; any other node is unresolved.
const concat = (left: string[] | null, right: string[] | null) => {
  if (!left || !right || left.length * right.length > maxAlternatives) return null;
  return left.flatMap((a) => right.map((b) => a + b));
};

const union = (...sets: (string[] | null)[]) => {
  if (sets.some((set) => !set)) return null;
  const all = [...new Set(sets.flat() as string[])];
  return all.length > maxAlternatives ? null : all;
};

const resolve = (raw: unknown): string[] | null => {
  const node = raw as Node | undefined;
  const list = (key: string) => (node?.[key] as Node[] | undefined) ?? [];
  const child = (key: string) => node?.[key] as Node | undefined;
  switch (node?.type) {
    case "Literal": {
      const value = node.value;
      return [value === null || typeof value === "boolean" ? "" : String(value)];
    }
    case "Identifier":
      return node.name === "undefined" ? [""] : null;
    case "TemplateLiteral": {
      let out: string[] | null = [(list("quasis")[0]?.value as { cooked: string }).cooked];
      list("expressions").forEach((inner, i) => {
        out = concat(out, resolve(inner));
        out = concat(out, [(list("quasis")[i + 1]?.value as { cooked: string }).cooked]);
      });
      return out;
    }
    case "BinaryExpression":
      return node.operator === "+" ? concat(resolve(child("left")), resolve(child("right"))) : null;
    case "ConditionalExpression":
      return union(resolve(child("consequent")), resolve(child("alternate")));
    case "LogicalExpression":
      return node.operator === "&&"
        ? union(resolve(child("right")), [""])
        : union(resolve(child("left")), resolve(child("right")));
    case "ArrayExpression": {
      let out: string[] | null = [""];
      for (const item of list("elements")) out = concat(concat(out, [" "]), resolve(item));
      return out;
    }
    case "ObjectExpression": {
      const keys: (string[] | null)[] = [[""]];
      for (const prop of list("properties")) {
        if (prop.type !== "Property") return null;
        const key = prop.key as Node;
        keys.push(!prop.computed && key.type === "Identifier" ? [String(key.name)] : resolve(key));
      }
      return union(...keys);
    }
    default:
      return null;
  }
};

// Preserve independent finite class values when another branch is unresolved.
const knownClasses = (raw: unknown, uses: Uses): void => {
  const node = raw as Node | undefined;
  const values = resolve(node);
  if (values) {
    for (const value of values) split(value, uses);
  } else if (node?.type === "ArrayExpression") {
    for (const item of (node.elements as Node[]) ?? []) knownClasses(item, uses);
  } else if (node?.type === "ConditionalExpression") {
    knownClasses(node.consequent, uses);
    knownClasses(node.alternate, uses);
  } else if (node?.type === "LogicalExpression") {
    if (node.operator !== "&&") knownClasses(node.left, uses);
    knownClasses(node.right, uses);
  } else if (node?.type === "ObjectExpression") {
    for (const prop of (node.properties as Node[]) ?? []) {
      if (prop.type !== "Property") continue;
      const key = prop.key as Node;
      if (!prop.computed && key.type === "Identifier") split(String(key.name), uses);
      else knownClasses(key, uses);
    }
  }
};

const classValue = (parts: Node[], uses: Uses) => {
  let out: string[] | null = [""];
  for (const part of parts) {
    if (part.type === "Text") out = concat(out, [String(part.data)]);
    else out = concat(out, resolve(part.expression));
  }
  if (!out) {
    uses.unknown.push("unresolved class value");
    if (parts.length === 1) knownClasses(parts[0]?.expression, uses);
  } else for (const value of out) split(value, uses);
};

const walk = (node: unknown, uses: Uses): void => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, uses));
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (n.type === "Attribute" && n.name === "class") {
    if (n.value !== true) classValue(Array.isArray(n.value) ? n.value : [n.value as Node], uses);
  } else if (n.type === "ClassDirective") {
    split(String(n.name), uses);
  } else if (n.type === "SpreadAttribute") {
    uses.unknown.push("spread attribute");
  }
  for (const value of Object.values(n)) walk(value, uses);
};

const classUses = (source: string): Uses => {
  const uses: Uses = { tokens: new Set(), unknown: [] };
  walk(parse(source, { modern: true }).fragment, uses);
  return uses;
};

const globalViolations = (source: string) => {
  const { tokens } = classUses(source);
  return globalExcluded.filter((name) => tokens.has(name));
};

const localViolations = (source: string) => {
  const { tokens, unknown } = classUses(source);
  return [
    ...[...tokens].filter((token) => !localClasses.has(token)).map((t) => `class ${t}`),
    ...unknown.map((kind) => `unknown ${kind}`),
  ];
};

describe("Kit utility source boundary", () => {
  it("scans components instead of server-helper prose", () => {
    expect(css).toMatch(/@import "tailwindcss\/utilities\.css" layer\(utilities\) source\(none\);/);
    expect(css).toContain('@source "./**/*.svelte";');
    expect(css).toContain('@source not "./lib/SiteMetadata.svelte";');
    expect(css).toContain('@source not "./routes/admin/join-attempts";');
  });

  it("excludes only prose candidates, not literal component classes", () => {
    const excluded = globalExcluded;
    expect(css).toContain(`@source not inline("${excluded.join(" ")}");`);
    for (const path of globSync("web/src/**/*.svelte")) {
      const source = readFileSync(path, "utf8");
      const attributes = [...source.matchAll(/\bclass\s*=\s*(["'`])([^]*?)\1/g)];
      for (const name of excluded) {
        expect(source, `${path}: class directive ${name}`).not.toContain(`class:${name}`);
        for (const [, , value] of attributes) {
          expect((value ?? "").split(/\s+/), `${path}: class ${name}`).not.toContain(name);
        }
      }
      expect(globalViolations(source), `${path}: global inline exclusion`).toEqual([]);
    }
  });

  it("allows only local classes in whole-file-excluded components", () => {
    const files = localExcludedFiles();
    expect(files.length).toBeGreaterThan(3);
    for (const path of files) {
      expect(localViolations(readFileSync(path, "utf8")), path).toEqual([]);
    }
  });

  it("detects global exclusions across finite class forms", () => {
    for (const markup of [
      '<p class="a hidden">x</p>',
      "<p class={`a ${ok ? 'block' : 'b'}`}>x</p>",
      "<p class={['a', cond && 'table']}>x</p>",
      "<p class={{ relative: cond }}>x</p>",
      "<p class:static={cond}>x</p>",
      "<p class={`hid${'den'}`}>x</p>",
      "<p class=\"hid{'den'}\">x</p>",
      "<p class={'hid' + 'den'}>x</p>",
      "<p class={`${a ? 'hi' : 'bl'}${b ? 'dden' : 'ock'}`}>x</p>",
      "<p class={`${a ? 'ta' : 'x'}${b ? 'ble' : 'y'}`}>x</p>",
    ]) {
      expect(globalViolations(markup), markup).not.toEqual([]);
    }
    for (const markup of [
      "<p class={['hidden', extra]}>x</p>",
      "<p class={cond ? 'hidden' : extra}>x</p>",
      "<p class={cond && (other ? 'hidden' : extra)}>x</p>",
      "<p class={{ hidden: cond, [name]: cond }}>x</p>",
    ])
      expect(globalViolations(markup), markup).toContain("hidden");
    const choices = Array.from({ length: 9 }, (_, i) => `c${i} ? 'a' : 'b'`).join(", ");
    expect(globalViolations(`<p class={['hidden', ${choices}]}>x</p>`)).toContain("hidden");
    expect(globalViolations('<p class="hint">x</p>')).toEqual([]);
    expect(globalViolations("<p class={`hid${'x'}`}>x</p>")).toEqual([]);
  });

  it("rejects utilities and unknown producers in whole-file-excluded components", () => {
    for (const markup of [
      '<p class="flex">x</p>',
      "<p class={cond ? 'hint' : 'p-4'}>x</p>",
      "<p class:flex={cond}>x</p>",
      "<p class={classes}>x</p>",
      "<p class={fn('hint')}>x</p>",
      "<p class={{ [name]: cond }}>x</p>",
      "<p {...rest}>x</p>",
      "<p class={{ ...extra }}>x</p>",
      "<p class={`hid${name}`}>x</p>",
      '<p class="hid{name}">x</p>',
      "<p class={'hid' + name}>x</p>",
      "<p class={['hint', 'x'].join(' ')}>x</p>",
    ]) {
      expect(localViolations(markup), markup).not.toEqual([]);
    }
    expect(localViolations('<p class="hint filters">x</p>')).toEqual([]);
    expect(localViolations("<p class={cond ? 'hint' : 'field'}>x</p>")).toEqual([]);
    expect(localViolations("<p class={`hi${'nt'} fil${'ters'}`}>x</p>")).toEqual([]);
    expect(localViolations("<p class={`fl${'ex'}`}>x</p>")).toEqual(["class flex"]);
  });

  it("keeps the metadata exclusion limited to class-free head content", () => {
    const metadata = readFileSync("web/src/lib/SiteMetadata.svelte", "utf8");
    const head = metadata.slice(metadata.indexOf("<svelte:head>"));
    expect(head).toMatch(/^<svelte:head>[\s\S]*<\/svelte:head>\s*$/);
    expect(head).not.toMatch(/\bclass\s*[:=]/);
    expect(head).not.toMatch(/<(?:div|span|main|section|a|button)\b/);
  });
});
