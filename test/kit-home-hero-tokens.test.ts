import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

describe("Kit home hero theme adapter", () => {
  it("composes scoped hero rules with pinned fallback aliases", () => {
    const { css, roles }: { css: string; roles: string[][] } = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {readFileSync} from "node:fs"; import {generate, parseKit, roleDeclarations} from "./ci/build-ember-tokens.mjs"; console.log(JSON.stringify({css:generate().get("public/styles.css"),roles:roleDeclarations(parseKit(readFileSync("vendor/design-kit/tokens.css","utf8")))}));',
        ],
        { encoding: "utf8" },
      ),
    );
    const mappings = [
      ["space-5", "space-5"],
      ["space-8", "space-8"],
      ["space-10", "space-10"],
      ["space-11", "space-11"],
      ["space-inset-room", "space-inset-room"],
      ["space-inset-card-lg", "space-inset-card-lg"],
      ["radius-pill", "radius-pill"],
      ["text-hero", "font-size-hero"],
      ["text-ui", "font-size-ui"],
      ["tracking-display", "tracking-display"],
      ["font-weight-display", "font-weight-display"],
      ["font-width-display", "font-width-display"],
      ["leading-display", "line-height-display"],
      ["leading-body", "line-height-body"],
    ];
    expect(css).not.toContain("@layer theme{:root,:host{");
    for (const [alias, role] of mappings) {
      const value = roles.find(([name]: string[]) => name === role)?.[2];
      expect(value, role).toBeDefined();
      const expected = transformSync(`.probe{padding:var(--${alias},${value})}`, {
        loader: "css",
        minify: true,
      }).code.match(/padding:([^}]*)/)?.[1];
      expect(css).toContain(expected);
    }
    expect(css).toContain(".base-theme:not(.content-theme) .hero.kit-home h1");
    expect(css).toContain(".base-theme .hero.kit-home");
    expect(css).toContain(".kit-home .hero-action");
    const page = readFileSync("web/src/routes/+page.svelte", "utf8");
    expect(page).toContain('class="hero kit-home"');
    expect(page).not.toContain("<style>");
    expect(readFileSync("public/styles.css", "utf8")).toBe(css);
    expect(readFileSync("public/theme.css", "utf8")).not.toContain(".hero.kit-home");
  });
});
