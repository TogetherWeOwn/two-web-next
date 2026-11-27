import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { parseRenderedPage, renderedElements } from "../ci/rendered-page.mjs";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES, JOIN_INTRO } from "../src/home-copy";
import { attr, elements } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

const HOME_PAGE = "web/src/routes/+page.svelte";

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
    expect(css).toMatch(
      /\.base-theme:not\(\.content-theme\) \.hero\.kit-home h1\{[^}]*text-transform:none(?:;|})/,
    );
    expect(css).toContain(".base-theme .hero.kit-home");
    expect(css).toContain(".kit-home .hero-action");
    expect(readFileSync("public/styles.css", "utf8")).toBe(css);
    expect(readFileSync("public/theme.css", "utf8")).not.toContain(".hero.kit-home");
  });

  it("renders the hero with the shared CSS scope and no inline stylesheet", async () => {
    const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
    const { parse } = webRequire("svelte/compiler") as {
      parse: (source: string, options: { modern: true }) => { css: object | null };
    };
    expect(parse(readFileSync(HOME_PAGE, "utf8"), { modern: true }).css).toBeNull();

    const { renderPage, cleanup } = await createKitSsrRenderer(HOME_PAGE);
    try {
      const page = parseRenderedPage(
        renderPage({
          nowMs: Date.UTC(2030, 6, 4, 18),
          session: null,
          appUrl: "https://example.test",
          inviteUrl: "https://discord.gg/invite",
          counts: { memberCount: 42, onlineCount: 7, ranks: [] },
          upcomingEvents: [],
          featured: [],
          homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO },
        }),
      );
      const heroes = [...renderedElements(page, { tag: "section" })].filter(
        (node) => attr(node, "aria-labelledby") === "home-heading",
      );
      expect(heroes.map((hero) => attr(hero, "class")?.split(/\s+/).sort())).toEqual([
        ["hero", "kit-home"],
      ]);
      expect(elements(page).filter((node) => node.tagName === "style")).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 60000);
});
