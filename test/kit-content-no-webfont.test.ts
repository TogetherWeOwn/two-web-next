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
const rulesOf = (css: string): Array<{ selector: string; body: string }> =>
  (stripComments(css).match(/[^{}]+{[^{}]*}/g) ?? []).map((rule) => ({
    selector: rule.slice(0, rule.indexOf("{")).trim(),
    body: rule.slice(rule.indexOf("{") + 1, -1),
  }));
const isDisplayBody = (body: string): boolean =>
  body
    .split(";")
    .some((declaration) => /font(?:-family)?\s*:[^;{}]*var\(--font-display\)/.test(declaration));

describe("Kit content shell preloads no Mona Sans webfont", () => {
  let renderMeta: (props: { title: string; theme: Theme; leafCss?: string }) => string;

  beforeAll(async () => {
    ({ renderMeta } = await buildSiteMetadataBundle());
  }, 120_000);

  it("emits zero font preloads for the content theme", () => {
    const html = renderMeta({ title: "Fixture", theme: "content" });
    expect(html).not.toContain('.woff2" as="font"');
  });

  it("keeps the Mona Sans preload on every other theme", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = renderMeta({ title: "Fixture", theme });
      expect(html).toContain('href="/fonts/mona-sans-latin-var.woff2" as="font"');
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

  it("leaves no :not(.content-theme) guard on any display rule in the inlined leaf block", () => {
    const displayRules = rulesOf(LEAF_CRITICAL_CSS).filter(
      (rule) => !/^@font-face/.test(rule.selector) && isDisplayBody(rule.body),
    );
    // Counted per target (selector): the minifier merges rules sharing a
    // declaration once the guards are gone.
    const targets = displayRules.flatMap((rule) =>
      rule.selector.split(/,(?![^(]*\))/).map((part) => part.trim()),
    );
    expect(targets.length).toBeGreaterThanOrEqual(7);
    const guards = displayRules.filter((rule) => rule.selector.includes(":not(.content-theme)"));
    expect(guards).toEqual([]);
  });

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
    expect(content).toContain("font-display:optional");
    const srcOf = (body: string) => /src\s*:\s*url\(["']?([^)'" ]+)["']?\)/.exec(body)?.[1];
    expect(srcOf(content!)).toBe(srcOf(main!));
    expect(srcOf(content!)).toBe("/fonts/mona-sans-latin-var.woff2");
  });

  it("points the content theme at the content face with the fallback second", () => {
    const rule = rulesOf(LEAF_CRITICAL_CSS).find((entry) =>
      /\.base-theme\.content-theme/.test(entry.selector),
    );
    expect(rule).toBeDefined();
    const value = /--font-display\s*:\s*([^;{}]+)/.exec(rule?.body ?? "")?.[1] ?? "";
    const families = value.split(",").map((family) =>
      family
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\s+/g, " "),
    );
    expect(families.slice(0, 2)).toEqual(["Mona Sans Content", "Mona Sans Fallback"]);
  });
});
