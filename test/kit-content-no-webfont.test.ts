// Kit content leaves render the display face through the optional content face
// and must not preload the Mona Sans webfont.
// Staging mobile LCP measured 2197–2255 ms against the 2000 ms budget while
// FCP sat at 1687–1750 ms: the swap face arrives after first paint and its
// swap re-lays-out the leaf (see the Hono twin's pin test). The SvelteKit twin
// (web/src/lib/SiteMetadata.svelte) must agree with the Hono shell
// (src/page-shell.tsx continues to skip the preload for theme "content").
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { DefaultTreeAdapterTypes } from "parse5";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRenderedPage } from "../ci/rendered-page.mjs";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

type Theme = "home" | "event" | "content" | "join" | "profile" | "schedule";

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally (same shape as
// test/kit-rules-parity.test.ts).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// The real SiteMetadata component, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild.
async function buildSiteMetadataBundle(): Promise<{
  renderMeta: (props: { title: string; theme: Theme; leafCss?: string }) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-sitemetadata-"));
  try {
    const entry = join(scratch, "kit-sitemetadata-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Meta from ${JSON.stringify(join(worktree, "web/src/lib/SiteMetadata.svelte"))};
export function renderMeta(props) {
  const { head, body } = render(Meta, { props });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-sitemetadata.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      plugins: [
        {
          name: "kit-sitemetadata-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    const { renderMeta } = (await import(pathToFileURL(outfile).href)) as {
      renderMeta: (props: { title: string; theme: Theme; leafCss?: string }) => string;
    };
    return { renderMeta };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function linksWithRel(page: DefaultTreeAdapterTypes.Document, rel: string) {
  return elements(page).filter(
    (el) =>
      el.tagName === "link" &&
      attr(el, "rel")
        ?.toLowerCase()
        .split(/[\t\n\f\r ]+/)
        .includes(rel),
  );
}

function fontPreloads(page: DefaultTreeAdapterTypes.Document) {
  return linksWithRel(page, "preload").filter((el) => attr(el, "as")?.toLowerCase() === "font");
}

describe("Kit content shell preloads no Mona Sans webfont", () => {
  let renderMeta: (props: { title: string; theme: Theme; leafCss?: string }) => string;

  beforeAll(async () => {
    ({ renderMeta } = await buildSiteMetadataBundle());
  }, 120_000);

  it("emits zero font preloads for the content theme", () => {
    const page = parseRenderedPage(renderMeta({ title: "Fixture", theme: "content" }));
    expect(fontPreloads(page)).toEqual([]);
  });

  it("keeps the Mona Sans preload on every other theme", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const page = parseRenderedPage(renderMeta({ title: "Fixture", theme }));
      const preload = fontPreloads(page).find(
        (el) => attr(el, "href") === "/fonts/mona-sans-latin-wght.woff2",
      );
      expect(preload && attr(preload, "crossorigin"), theme).toBe("anonymous");
    }
  });

  it("inlines the leaf CSS for the content theme instead of stylesheet links", () => {
    const html = renderMeta({ title: "Fixture", theme: "content", leafCss: LEAF_CRITICAL_CSS });
    const page = parseRenderedPage(html);
    expect(
      elements(page)
        .filter((el) => el.tagName === "style")
        .map(textOf),
    ).toEqual([LEAF_CRITICAL_CSS]);
    expect(linksWithRel(page, "stylesheet")).toEqual([]);
    // HTML parsing normalizes CSS line endings and drops duplicate link attributes.
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("leaves every other theme on external stylesheets", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const page = parseRenderedPage(renderMeta({ title: "Fixture", theme }));
      expect(
        linksWithRel(page, "stylesheet").map((el) => attr(el, "href")),
        theme,
      ).toEqual(expect.arrayContaining(["/styles.css", "/theme.css"]));
      expect(
        elements(page).filter((el) => el.tagName === "style"),
        theme,
      ).toEqual([]);
    }
  });

  // The inlined constant's display rules and token are pinned in content-leaf-no-webfont.test.ts.

  it("ships the content face with font-display: optional over the same file as the main face", () => {
    const faces = [...stripComments(LEAF_CRITICAL_CSS).matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? "",
    );
    const faceOf = (family: string) =>
      faces.find((body) => new RegExp(`font-family\\s*:\\s*["']?${family}["']?\\s*;`).test(body));
    const main = faceOf("Mona Sans");
    const content = faceOf("Mona Sans Content");
    expect(main).toBeDefined();
    expect(content).toBeDefined();
    const optional = /(?:^|;)\s*font-display\s*:\s*optional\s*(?:;|$)/;
    expect(content).toMatch(optional);
    expect("font-display:optionalfoo;").not.toMatch(optional);
    const srcOf = (body: string) => /src\s*:\s*url\(["']?([^)'" ]+)["']?\)/.exec(body)?.[1];
    expect(srcOf(content!)).toBe(srcOf(main!));
    expect(srcOf(content!)).toBe("/fonts/mona-sans-latin-wght.woff2");
  });
});
