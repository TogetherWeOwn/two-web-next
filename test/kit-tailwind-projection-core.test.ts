import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { assertProjection, projectSvelte } from "../web/scripts/tailwind-projection-core.mjs";

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
