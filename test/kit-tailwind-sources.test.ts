import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("web/src/app.css", "utf8");

describe("Kit utility source boundary", () => {
  it("scans components instead of server-helper prose", () => {
    expect(css).toMatch(/@import "tailwindcss\/utilities\.css" layer\(utilities\) source\(none\);/);
    expect(css).toContain('@source "./**/*.svelte";');
    expect(css).toContain('@source not "./lib/SiteMetadata.svelte";');
    expect(css).toContain('@source not "./routes/admin/join-attempts";');
  });

  it("excludes only prose candidates, not literal component classes", () => {
    const excluded =
      "visible relative static block hidden table flex inline-flex font-ui font-data text-small".split(
        " ",
      );
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
    }
  });

  it("keeps the metadata exclusion limited to class-free head content", () => {
    const metadata = readFileSync("web/src/lib/SiteMetadata.svelte", "utf8");
    const head = metadata.slice(metadata.indexOf("<svelte:head>"));
    expect(head).toMatch(/^<svelte:head>[\s\S]*<\/svelte:head>\s*$/);
    expect(head).not.toMatch(/\bclass\s*[:=]/);
    expect(head).not.toMatch(/<(?:div|span|main|section|a|button)\b/);
  });
});
