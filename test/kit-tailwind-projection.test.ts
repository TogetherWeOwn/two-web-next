import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSvelte, regenerateProjection } from "../web/scripts/tailwind-projection.mjs";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { Scanner } = webRequire("@tailwindcss/oxide") as {
  Scanner: new (options: {
    sources: never[];
  }) => {
    scanFiles: (files: { content: string; extension: string }[]) => string[];
  };
};
const variables = (content: string) =>
  new Scanner({ sources: [] })
    .scanFiles([{ content, extension: "svelte" }])
    .filter((name) => name.startsWith("--"))
    .sort();

const source = `<script lang="ts">
  let { forwarded } = $props();
  const choices = ["flex", "outline"];
</script>
<Widget {...forwarded} class={choices[0]} />
<div class:outline={true} style="--inline-alias: var(--inline-value)">content</div>
<style>
  .box { outline: 1px solid; color: var(--theme-only, var(--fallback)); }
  .alias { --local-alias: var(--nested); }
</style>`;

describe("Kit Tailwind scanner projection", () => {
  it("preserves native variable uses and every non-style source character", () => {
    const projection = projectSvelte(source) as string;
    const before = source.slice(0, source.indexOf("<style>"));
    expect(projection.startsWith(before)).toBe(true);
    expect(projection).not.toContain("outline: 1px solid");
    expect(variables(projection)).toEqual(variables(source));
    expect(variables(source)).toEqual(
      expect.arrayContaining([
        "--theme-only",
        "--fallback",
        "--inline-alias",
        "--inline-value",
        "--local-alias",
        "--nested",
      ]),
    );
    expect(() => projectSvelte("<div><style>broken")).toThrow();
  });

  it("keeps complete candidates from directives, scripts and forwarded props", () => {
    const projection = projectSvelte(source) as string;
    const candidates = new Scanner({ sources: [] }).scanFiles([
      { content: projection, extension: "svelte" },
    ]);
    expect(candidates).toEqual(expect.arrayContaining(["outline", "flex"]));
    const styleOnly = projectSvelte(
      "<span>label</span><style>.tag { outline: 1px solid; color: var(--theme-only) }</style>",
    ) as string;
    const negative = new Scanner({ sources: [] }).scanFiles([
      { content: styleOnly, extension: "svelte" },
    ]);
    expect(negative).not.toContain("outline");
    expect(negative).toContain("--theme-only");
  });

  it("applies changed exclusions, removes obsolete files and refuses malformed rules", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-projection-"));
    try {
      const sourceDir = join(root, "source");
      const outputDir = join(root, "output");
      const css = join(sourceDir, "app.css");
      const glob = '@source "../.svelte-kit/tailwind-projection/**/*.svelte";';
      mkdirSync(join(sourceDir, "excluded"), { recursive: true });
      writeFileSync(css, `${glob}\n/* @source not "../outside"; */`);
      writeFileSync(join(sourceDir, "excluded", "Card.svelte"), source);
      expect(regenerateProjection({ sourceDir, outputDir }).changed).toHaveLength(1);
      expect(regenerateProjection({ sourceDir, outputDir }).changed).toHaveLength(0);
      writeFileSync(
        css,
        `${glob}\n.message { content: '@source not "../.svelte-kit/tailwind-projection/excluded";'; }`,
      );
      regenerateProjection({ sourceDir, outputDir });
      expect(existsSync(join(outputDir, "excluded", "Card.svelte"))).toBe(true);
      writeFileSync(css, `.message { content: '${glob}'; }`);
      expect(() => regenerateProjection({ sourceDir, outputDir })).toThrow();
      writeFileSync(css, `/* ${glob} */`);
      expect(() => regenerateProjection({ sourceDir, outputDir })).toThrow();
      writeFileSync(css, `${glob}\n@source not "../.svelte-kit/tailwind-projection/excluded";`);
      regenerateProjection({ sourceDir, outputDir });
      expect(existsSync(join(outputDir, "excluded", "Card.svelte"))).toBe(false);
      writeFileSync(css, `${glob}\n@source not "../outside";`);
      expect(() => regenerateProjection({ sourceDir, outputDir })).toThrow();
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses overlapping paths and symlinks without modifying source or link targets", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-projection-"));
    try {
      const sourceDir = join(root, "source");
      const outputDir = join(root, "output");
      const outside = join(root, "outside");
      mkdirSync(sourceDir);
      mkdirSync(outputDir);
      mkdirSync(outside);
      writeFileSync(
        join(sourceDir, "app.css"),
        '@source "../.svelte-kit/tailwind-projection/**/*.svelte";',
      );
      writeFileSync(join(sourceDir, "Card.svelte"), source);
      writeFileSync(join(outside, "Card.svelte"), "untouched");
      expect(() => regenerateProjection({ sourceDir, outputDir: sourceDir })).toThrow();
      const alias = join(root, "alias");
      symlinkSync(root, alias);
      expect(() => regenerateProjection({ sourceDir, outputDir: join(alias, "source") })).toThrow();
      expect(() =>
        regenerateProjection({ sourceDir, outputDir: join(alias, "source", "new") }),
      ).toThrow();
      expect(readFileSync(join(sourceDir, "Card.svelte"), "utf8")).toBe(source);
      symlinkSync(join(outside, "Card.svelte"), join(outputDir, "Card.svelte"));
      expect(() => regenerateProjection({ sourceDir, outputDir })).toThrow();
      expect(readFileSync(join(outside, "Card.svelte"), "utf8")).toBe("untouched");
      expect(readFileSync(join(sourceDir, "Card.svelte"), "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite source through a hard-linked mirror file", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-projection-"));
    try {
      const sourceDir = join(root, "source");
      const outputDir = join(root, "output");
      mkdirSync(sourceDir);
      mkdirSync(outputDir);
      writeFileSync(
        join(sourceDir, "app.css"),
        '@source "../.svelte-kit/tailwind-projection/**/*.svelte";',
      );
      const original = join(sourceDir, "Card.svelte");
      const mirror = join(outputDir, "Card.svelte");
      writeFileSync(original, source);
      linkSync(original, mirror);
      regenerateProjection({ sourceDir, outputDir });
      expect(readFileSync(original, "utf8")).toBe(source);
      expect(readFileSync(mirror, "utf8")).toBe(projectSvelte(source));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes deleted files and stale variables on regeneration", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-projection-"));
    try {
      const sourceDir = join(root, "source");
      const outputDir = join(root, "output");
      const { mkdirSync, unlinkSync } = await import("node:fs");
      mkdirSync(sourceDir);
      writeFileSync(
        join(sourceDir, "app.css"),
        '@source "../.svelte-kit/tailwind-projection/**/*.svelte";',
      );
      writeFileSync(join(sourceDir, "Card.svelte"), source);
      await regenerateProjection({ sourceDir, outputDir });
      expect(variables(readFileSync(join(outputDir, "Card.svelte"), "utf8"))).toEqual(
        variables(source),
      );
      writeFileSync(join(sourceDir, "Card.svelte"), "<div><style>broken");
      expect(() => regenerateProjection({ sourceDir, outputDir })).toThrow();
      expect(() => readFileSync(join(outputDir, "Card.svelte"), "utf8")).toThrow();
      unlinkSync(join(sourceDir, "Card.svelte"));
      await regenerateProjection({ sourceDir, outputDir });
      expect(() => readFileSync(join(outputDir, "Card.svelte"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
