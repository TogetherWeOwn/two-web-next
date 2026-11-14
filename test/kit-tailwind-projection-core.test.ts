import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  assertProjection,
  MAX_SOURCE_BYTES,
  projectSvelte,
  styleRanges,
} from "../web/scripts/tailwind-projection-core.mjs";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { Scanner } = webRequire("@tailwindcss/oxide") as {
  Scanner: new (options: {
    sources: never[];
  }) => {
    scanFiles: (files: { content: string; extension: string }[]) => string[];
  };
};
const scan = (content: string) =>
  new Scanner({ sources: [] }).scanFiles([{ content, extension: "svelte" }]);
const variables = (content: string) =>
  scan(content)
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

describe("Kit Tailwind scanner projection core", () => {
  it("enforces the source limit in UTF-8 bytes", () => {
    expect(styleRanges("")).toEqual([]);
    expect(styleRanges(" ".repeat(MAX_SOURCE_BYTES))).toEqual([]);
    expect(() => styleRanges(" ".repeat(MAX_SOURCE_BYTES + 1))).toThrow(
      "tailwind-projection: source byte limit",
    );
    expect(() => styleRanges("é".repeat(MAX_SOURCE_BYTES / 2 + 1))).toThrow(
      "tailwind-projection: source byte limit",
    );
  });

  it("preserves scanner variables and non-style source characters", () => {
    const projected = projectSvelte(source);
    expect(projected.startsWith(source.slice(0, source.indexOf("<style>")))).toBe(true);
    expect(projected).not.toContain("outline: 1px solid");
    expect(variables(projected)).toEqual(variables(source));
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
    expect(() => assertProjection(source, projected)).not.toThrow();
    expect(() => projectSvelte("<div><style>broken")).toThrow();
  });

  it("masks only compiler style ranges after non-BMP text and preserves line endings", () => {
    const input =
      '<div>🎮</div>\r\n<style>\r\n.tag { color: var(--tag-color) }\r\n</style>\r\n<p class="flex">after</p>';
    const ranges = styleRanges(input);
    expect(ranges).toHaveLength(1);
    const start = ranges[0]?.[0] ?? -1;
    const end = ranges[0]?.[1] ?? -1;
    const projected = projectSvelte(input);
    expect(input.slice(start, end).startsWith("<style>")).toBe(true);
    expect(input.slice(start, end).endsWith("</style>")).toBe(true);
    expect(projected.slice(0, start)).toBe(input.slice(0, start));
    expect(projected.slice(start, end)).toBe(input.slice(start, end).replace(/[^\r\n]/g, " "));
    expect(projected.slice(end).startsWith(input.slice(end))).toBe(true);
    expect(() => assertProjection(input, projected)).not.toThrow();
  });

  it("maps style offsets back to BOM-prefixed source", () => {
    const input =
      String.fromCharCode(0xfeff) +
      '<div class="flex">before</div><style>.tag { color: red }</style><p>after</p>';
    const start = input.indexOf("<style>");
    const end = input.indexOf("</style>") + "</style>".length;
    const projected = projectSvelte(input);
    expect(styleRanges(input)).toEqual([[start, end]]);
    expect(projected.slice(0, start)).toBe(input.slice(0, start));
    expect(projected.slice(start, end)).toBe(" ".repeat(end - start));
    expect(projected.slice(end).startsWith(input.slice(end))).toBe(true);
    expect(scan(projected)).toContain("flex");
    expect(() => assertProjection(input, projected)).not.toThrow();
  });

  it("preserves real utilities without emitting style-only candidates", () => {
    expect(scan(projectSvelte(source))).toEqual(expect.arrayContaining(["outline", "flex"]));
    const negative = scan(
      projectSvelte(
        "<span>label</span><style>.tag { outline: 1px solid; color: var(--theme-only) }</style>",
      ),
    );
    expect(negative).not.toContain("outline");
    expect(negative).toContain("--theme-only");
    expect(() => assertProjection("<div />", '<div class="outline" />')).toThrow();
    expect(() => assertProjection(source, "<div />")).toThrow();
  });
});
