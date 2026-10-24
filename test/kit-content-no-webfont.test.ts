// Kit content leaves must not preload the display webfont.
// Staging mobile LCP on /about, /faq, /rules and /privacy measured 2197–2255
// ms against the 2000 ms budget while FCP sat at 1687–1750 ms: the Display
// webfont arrives after first paint and its swap re-lays-out the leaf, so the
// largest text block repaints late and becomes LCP. The Hono shell
// (src/page-shell.tsx) already skips the display-face preload for theme "content";
// the SvelteKit twin (web/src/lib/SiteMetadata.svelte) must agree, or enabling
// the Kit routes reintroduces the same unused high-priority fetch on the same
// mobile-LCP pages.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";

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
  renderMeta: (props: {
    title: string;
    theme: Theme;
    canonical?: string;
    leafCss?: string;
  }) => string;
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
      renderMeta: (props: {
        title: string;
        theme: Theme;
        canonical?: string;
        leafCss?: string;
      }) => string;
    };
    return { renderMeta };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("Kit content shell preloads no display webfont", () => {
  let renderMeta: (props: {
    title: string;
    theme: Theme;
    canonical?: string;
    leafCss?: string;
  }) => string;

  beforeAll(async () => {
    ({ renderMeta } = await buildSiteMetadataBundle());
  }, 120_000);

  it("emits zero font preloads for the content theme", () => {
    const html = renderMeta({ title: "Fixture", theme: "content" });
    expect(html).not.toContain('.woff2" as="font"');
  });

  it("keeps the display-face preload on every other theme", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = renderMeta({ title: "Fixture", theme });
      expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2" as="font"');
      expect(html).toContain('crossorigin="anonymous"');
    }
  });

  it("inlines the leaf CSS for the content theme instead of stylesheet links", () => {
    const html = renderMeta({ title: "Fixture", theme: "content", leafCss: LEAF_CRITICAL_CSS });
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("leaves every other theme on external stylesheets", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = renderMeta({ title: "Fixture", theme });
      expect(html).toContain('rel="stylesheet" href="/styles.css"');
      expect(html).toContain('rel="stylesheet" href="/theme.css"');
      expect(html).not.toContain("<style>");
    }
  });
});

// The Hono head contract pins the rendered share image (absolute og:image and
// twitter:image derived from the page canonical) in six suites; the Kit twin
// must pin its rendered output the same way. Crawlers reject relative
// summary_large_image URLs, so a source-only grep is not enough: a one-line
// revert to the relative /og-1200x630.png must fail here.
describe("Kit share image is absolute and pinned", () => {
  let renderMeta: (props: {
    title: string;
    theme: Theme;
    canonical?: string;
    leafCss?: string;
  }) => string;

  beforeAll(async () => {
    ({ renderMeta } = await buildSiteMetadataBundle());
  }, 120_000);

  it("emits one absolute og:image and twitter:image on canonical pages", () => {
    for (const theme of ["home", "event"] as const) {
      const canonical = "https://example.com/events";
      const image = new URL("/og-1200x630.png", canonical).href;
      const html = renderMeta({ title: "Events", theme, canonical });
      expect(html, theme).toContain(`<meta property="og:image" content="${image}"`);
      expect(html, theme).toContain(`<meta name="twitter:image" content="${image}"`);
      expect(html.match(/<meta property="og:image"/g) ?? []).toHaveLength(1);
      expect(html.match(/<meta name="twitter:image"/g) ?? []).toHaveLength(1);
    }
  });

  it("emits no share image without a canonical", () => {
    const html = renderMeta({ title: "Events", theme: "home" });
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
  });
});
