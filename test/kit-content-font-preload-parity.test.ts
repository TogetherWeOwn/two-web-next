// Kit content font-preload parity (TOG-23692, PR #843 follow-up).
// The Hono content shell skips the Display webfont preload while every other
// theme keeps it; every Display text rule in public/theme.css is scoped away
// from .content-theme. The Kit SiteMetadata must match: theme="content" emits
// no font preload, every other supported theme keeps the crossorigin preload.
// The Kit parity harness strips preloads before comparing (ci/kit-preview-e2e),
// so only this SSR assertion catches the divergence.
// SSR behavior, not source text: the real SiteMetadata plus the real rules leaf
// (through Shell) are compiled with the web workspace's svelte/compiler and
// bundled by esbuild, the same harness as test/kit-rules-parity.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rulesPageData } from "../src/rules-content";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type Theme = "home" | "event" | "content" | "join" | "profile" | "schedule";

type MetadataBundle = {
  renderSiteMetadata: (props: { title: string; theme: Theme }) => string;
  renderRulesPage: (data: ReturnType<typeof rulesPageData>) => string;
  applicationModules: string[];
};

let renderSiteMetadata: MetadataBundle["renderSiteMetadata"];
let renderRulesPage: MetadataBundle["renderRulesPage"];

const FONT_FILE = "/fonts/display-latin-700.woff2";
// Attribute-order independent: Svelte SSR owns void-element serialization.
const FONT_PRELOAD = new RegExp(
  `<link(?=[^>]*rel="preload")(?=[^>]*${FONT_FILE.replace(/[./]/g, (c) => `\\${c}`)})[^>]*>`,
);
const FONT_PRELOAD_CROSSORIGIN = new RegExp(
  `<link(?=[^>]*${FONT_FILE.replace(/[./]/g, (c) => `\\${c}`)})(?=[^>]*crossorigin)[^>]*>`,
);
const FONT_PRELOAD_AS_FONT = new RegExp(
  `<link(?=[^>]*${FONT_FILE.replace(/[./]/g, (c) => `\\${c}`)})(?=[^>]*as="font")[^>]*>`,
);

let scratch = "";

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-content-preload-"));
  const entry = join(scratch, "kit-content-preload-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import SiteMetadata from ${JSON.stringify(join(root, "web/src/lib/SiteMetadata.svelte"))};
import RulesPage from ${JSON.stringify(join(root, "web/src/routes/rules/+page.svelte"))};
export function renderSiteMetadata(props) {
  const { head } = render(SiteMetadata, { props });
  return head;
}
export function renderRulesPage(data) {
  const { head, body } = render(RulesPage, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-content-preload-bundle.mjs");
  const result = await build({
    metafile: true,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-content-preload-svelte-ssr",
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
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as MetadataBundle;
  renderSiteMetadata = mod.renderSiteMetadata;
  renderRulesPage = mod.renderRulesPage;
  void result.metafile;
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Kit SiteMetadata font-preload parity with the Hono content shell", () => {
  it("emits no font preload for theme=content", () => {
    const head = renderSiteMetadata({ title: "House rules", theme: "content" });
    expect(head).not.toMatch(FONT_PRELOAD);
    expect(head).not.toContain(FONT_FILE);
  });

  it.each(["home", "event", "join", "profile", "schedule"] as const)(
    "keeps the crossorigin font preload for theme=%s",
    (theme) => {
      const head = renderSiteMetadata({ title: "Probe", theme });
      expect(head).toMatch(FONT_PRELOAD);
      expect(head).toMatch(FONT_PRELOAD_CROSSORIGIN);
      expect(head).toMatch(FONT_PRELOAD_AS_FONT);
    },
  );

  it("emits no font preload on the real content leaf (rules through Shell)", () => {
    const html = renderRulesPage(rulesPageData("https://next.example.test", "2026-09-01"));
    expect(html).not.toMatch(FONT_PRELOAD);
    expect(html).not.toContain(FONT_FILE);
  });
});
