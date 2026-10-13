// Kit content leaves must not preload the Display webfont.
// Staging mobile LCP on /about, /faq, /rules and /privacy measured 2197–2255
// ms against the 2000 ms budget while FCP sat at 1687–1750 ms: the Display
// webfont arrives after first paint and its swap re-lays-out the leaf, so the
// largest text block repaints late and becomes LCP. The Hono shell
// (src/page-shell.tsx) already skips the Display preload for theme "content";
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
  renderMeta: (props: { title: string; theme: Theme }) => string;
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
      renderMeta: (props: { title: string; theme: Theme }) => string;
    };
    return { renderMeta };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("Kit content shell preloads no Display webfont", () => {
  let renderMeta: (props: { title: string; theme: Theme }) => string;

  beforeAll(async () => {
    ({ renderMeta } = await buildSiteMetadataBundle());
  }, 120_000);

  it("emits zero font preloads for the content theme", () => {
    const html = renderMeta({ title: "Fixture", theme: "content" });
    expect(html).not.toContain('.woff2" as="font"');
  });

  it("keeps the Display preload on every other theme", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = renderMeta({ title: "Fixture", theme });
      expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
      expect(html).toContain('crossorigin="anonymous"');
    }
  });
});
