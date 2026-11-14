import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const css = readFileSync("web/src/app.css", "utf8");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { parse } = webRequire("svelte/compiler");
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

type Node = { type?: string; [key: string]: unknown };
type Limits = { bytes: number; nodes: number; depth: number };
const defaults: Limits = { bytes: 1024 * 1024, nodes: 10000, depth: 128 };

// Only literal attributes are certified here. Dynamic output and forwarding
// remain unresolved until the symbolic analysis supports them.
const classUses = (source: string, limits = defaults) => {
  if (Buffer.byteLength(source, "utf8") > limits.bytes) throw new Error("source byte limit");
  const tokens = new Set<string>();
  const unknown: string[] = [];
  let nodes = 0;
  const add = (text: string) => {
    for (const token of text.split(/\s+/)) if (token) tokens.add(token);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > limits.depth) throw new Error("AST depth limit");
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (++nodes > limits.nodes) throw new Error("AST node limit");
    const node = value as Node;
    if (node.type === "Attribute" && node.name === "class") {
      const parts = Array.isArray(node.value) ? node.value : [node.value];
      if (parts.every((part) => (part as Node)?.type === "Text")) {
        add(parts.map((part) => String((part as Node).data)).join(""));
      } else {
        unknown.push("dynamic class");
      }
    } else if (node.type === "ClassDirective") {
      add(String(node.name));
    } else if (node.type === "SpreadAttribute") {
      unknown.push("spread attribute");
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  };
  walk(parse(source, { modern: true }).fragment, 0);
  return { tokens, unknown };
};

const localViolations = (source: string, limits = defaults) => {
  const { tokens, unknown } = classUses(source, limits);
  return [...[...tokens].filter((token) => !localClasses.has(token)), ...unknown];
};

describe("Kit utility source boundary", () => {
  it("scans components instead of server-helper prose", () => {
    expect(css).toMatch(/@import "tailwindcss\/utilities\.css" layer\(utilities\) source\(none\);/);
    expect(css).toContain('@source "./**/*.svelte";');
    expect(css).toContain('@source not "./lib/SiteMetadata.svelte";');
    expect(css).toContain('@source not "./routes/admin/join-attempts";');
  });

  it("excludes only prose candidates, not literal component classes", () => {
    const excluded = ["visible", "relative", "static", "block", "hidden", "table"];
    expect(css).toContain(`@source not inline("${excluded.join(" ")}");`);
    for (const path of globSync("web/src/**/*.svelte")) {
      const source = readFileSync(path, "utf8");
      const attributes = [...source.matchAll(/\bclass\s*=\s*(["'`])([^]*?)\1/g)];
      const { tokens } = classUses(source);
      for (const name of excluded) {
        expect(source, `${path}: class directive ${name}`).not.toContain(`class:${name}`);
        for (const [, , value] of attributes) {
          expect((value ?? "").split(/\s+/), `${path}: class ${name}`).not.toContain(name);
        }
        expect(tokens.has(name), `${path}: AST class ${name}`).toBe(false);
      }
    }
  });

  it("allows only known local classes in whole-file-excluded components", () => {
    const files = [
      "web/src/lib/SiteMetadata.svelte",
      ...globSync("web/src/routes/admin/join-attempts/**/*.svelte"),
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const path of files) expect(localViolations(readFileSync(path, "utf8")), path).toEqual([]);
  });

  it("recognizes literal classes and rejects local unknowns", () => {
    expect([...classUses('<p class="hidden hint" class:relative={ok}>x</p>').tokens]).toEqual([
      "hidden",
      "hint",
      "relative",
    ]);
    expect(localViolations('<p class="hint filters">x</p>')).toEqual([]);
    for (const markup of [
      '<p class="flex">x</p>',
      "<p class:flex={ok}>x</p>",
      "<p class={classes}>x</p>",
      '<p class="hint {value}">x</p>',
      "<p {...rest}>x</p>",
    ])
      expect(localViolations(markup), markup).not.toEqual([]);
    expect(
      localViolations(
        '<script>const text = "class=flex";</script><!-- class=flex --><p title="flex">x</p>',
      ),
    ).toEqual([]);
  });

  it("fails closed on parse or traversal limits", () => {
    expect(() => classUses('<p class="hint"')).toThrow();
    const source = '<p class="hint">x</p>';
    expect(() => classUses(source, { ...defaults, bytes: 1 })).toThrow("source byte limit");
    expect(() => localViolations(source, { ...defaults, nodes: 1 })).toThrow("AST node limit");
    expect(() => localViolations(source, { ...defaults, depth: 1 })).toThrow("AST depth limit");
  });

  it("keeps the metadata exclusion limited to class-free head content", () => {
    const metadata = readFileSync("web/src/lib/SiteMetadata.svelte", "utf8");
    const head = metadata.slice(metadata.indexOf("<svelte:head>"));
    expect(head).toMatch(/^<svelte:head>[\s\S]*<\/svelte:head>\s*$/);
    expect(head).not.toMatch(/\bclass\s*[:=]/);
    expect(head).not.toMatch(/<(?:div|span|main|section|a|button)\b/);
  });
});
