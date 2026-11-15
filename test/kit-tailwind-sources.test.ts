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
const metadataStyle = '{@html leafCss ? `<style>${leafCss}</style>` : ""}';
const classUses = (source: string, limits = defaults, allowMetadataStyle = false) => {
  if (Buffer.byteLength(source, "utf8") > limits.bytes) throw new Error("source byte limit");
  const tokens = new Set<string>();
  const unknown: string[] = [];
  let nodes = 0;
  const add = (text: string) => {
    for (const token of text.split(/\s+/)) if (token) tokens.add(token);
  };
  const walk = (value: unknown, depth: number, nativeAttribute = false): void => {
    if (depth > limits.depth) throw new Error("AST depth limit");
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1, nativeAttribute);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (++nodes > limits.nodes) throw new Error("AST node limit");
    const node = value as Node;
    if (
      node.type === "Attribute" &&
      (node.name === "class" ||
        (nativeAttribute && typeof node.name === "string" && node.name.toLowerCase() === "class"))
    ) {
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
    } else if (node.type === "RenderTag") {
      unknown.push("rendered snippet");
    } else if (node.type === "HtmlTag") {
      if (
        !allowMetadataStyle ||
        source.slice(Number(node.start), Number(node.end)) !== metadataStyle
      ) {
        unknown.push("raw HTML");
      }
    }
    const native = node.type === "RegularElement" || node.type === "SvelteElement";
    for (const [key, child] of Object.entries(node)) {
      walk(child, depth + 1, native && key === "attributes");
    }
  };
  walk(parse(source, { modern: true }).fragment, 0);
  return { tokens, unknown };
};

const localViolations = (source: string, limits = defaults, allowMetadataStyle = false) => {
  const { tokens, unknown } = classUses(source, limits, allowMetadataStyle);
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
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const metadata = path === "web/src/lib/SiteMetadata.svelte";
      if (metadata) {
        expect(source.split(metadataStyle)).toHaveLength(2);
        expect(source.indexOf(metadataStyle)).toBeGreaterThan(source.indexOf("<svelte:head>"));
      }
      expect(localViolations(source, defaults, metadata), path).toEqual([]);
    }
  });

  it("recognizes literal classes and rejects local unknowns", () => {
    expect([...classUses('<p class="hidden hint" class:relative={ok}>x</p>').tokens]).toEqual([
      "hidden",
      "hint",
      "relative",
    ]);
    expect(localViolations('<p class="hint filters">x</p>')).toEqual([]);
    expect([...classUses('<p CLASS="flex">x</p><p ClAsS="hidden">x</p>').tokens]).toEqual([
      "flex",
      "hidden",
    ]);
    expect(localViolations('<p CLASS="flex">x</p>')).toContain("flex");
    expect(localViolations("<p ClAsS={classes}>x</p>")).toContain("dynamic class");
    expect([...classUses('<Widget CLASS="hidden" />').tokens]).toEqual([]);
    for (const markup of [
      '<svg><g CLASS="flex" /></svg>',
      '<math><mi ClAsS="flex">x</mi></math>',
      '<svelte:element this={"p"} CLASS="flex" />',
      '<svelte:element this={tag} ClAsS="flex" />',
    ]) {
      expect(localViolations(markup), markup).toContain("flex");
    }
    for (const markup of [
      "<svg><g CLASS={classes} /></svg>",
      "<math><mi ClAsS={classes}>x</mi></math>",
      '<svelte:element this={"p"} CLASS={classes} />',
      "<svelte:element this={tag} ClAsS={classes} />",
    ]) {
      expect(localViolations(markup), markup).toContain("dynamic class");
    }
    expect([
      ...classUses('<svg><foreignObject><p CLASS="hidden" /></foreignObject></svg>').tokens,
    ]).toEqual(["hidden"]);
    expect(
      localViolations("<script>let { content } = $props();</script>{@render content()}"),
    ).toContain("rendered snippet");
    for (const markup of [
      '<p class="flex">x</p>',
      "<p class:flex={ok}>x</p>",
      "<p class={classes}>x</p>",
      '<p class="hint {value}">x</p>',
      "<p {...rest}>x</p>",
      "{@html content}",
      metadataStyle,
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
    expect(classUses("", { ...defaults, bytes: 0 }).tokens.size).toBe(0);
    const unicode = "<p>é</p>";
    const bytes = Buffer.byteLength(unicode, "utf8");
    expect(() => classUses(unicode, { ...defaults, bytes })).not.toThrow();
    expect(() => classUses(unicode, { ...defaults, bytes: bytes - 1 })).toThrow(
      "source byte limit",
    );
    for (const limit of ["nodes", "depth"] as const) {
      let boundary = 0;
      while (boundary < 100) {
        try {
          classUses(source, { ...defaults, [limit]: boundary });
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes(`AST ${limit === "nodes" ? "node" : "depth"} limit`)
          )
            throw error;
          boundary++;
        }
      }
      expect(boundary).toBeLessThan(100);
      expect(() => classUses(source, { ...defaults, [limit]: boundary })).not.toThrow();
      expect(() => classUses(source, { ...defaults, [limit]: boundary - 1 })).toThrow();
    }
    expect(localViolations(metadataStyle, defaults, true)).toEqual([]);
    expect(localViolations("{@html content}", defaults, true)).toContain("raw HTML");
  });

  it("keeps the metadata exclusion limited to class-free head content", () => {
    const metadata = readFileSync("web/src/lib/SiteMetadata.svelte", "utf8");
    const head = metadata.slice(metadata.indexOf("<svelte:head>"));
    expect(head).toMatch(/^<svelte:head>[\s\S]*<\/svelte:head>\s*$/);
    expect(head).not.toMatch(/\bclass\s*[:=]/);
    expect(head).not.toMatch(/<(?:div|span|main|section|a|button)\b/);
  });
});
