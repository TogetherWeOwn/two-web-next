import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { FAQS, faqPageData } from "../../src/faq-content";

export const FAQ_ORIGIN = "https://next.example.test";
type FaqData = ReturnType<typeof faqPageData>;
export type FaqGroups = typeof FAQS;
export type FaqLoad = (event: Record<string, unknown>) => Promise<FaqData>;

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string }; css: { code: string } | null };
};

// Same real Svelte SSR/compiler harness as the FAQ parity suite. Only the
// Cloudflare binding is replaced: unknown bindings throw, rather than silently
// supplying a session/database. The entry exposes fixture data, not a matcher.
export async function buildKitFaqBundle() {
  const worktree = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "kit-faq-"));
  const styles: string[] = [];
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/faq/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
import { FAQS } from ${JSON.stringify(join(worktree, "src/faq-content.ts"))};
export { load, csr } from ${JSON.stringify(join(worktree, "web/src/routes/faq/+page.server.ts"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function replaceFaqs(groups) { FAQS.splice(0, FAQS.length, ...groups); }
`,
    );
    const outfile = join(scratch, "faq.mjs");
    const result = await build({
      metafile: true,
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      tsconfigRaw: {},
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": join(worktree, "web/src/lib") },
      plugins: [
        {
          name: "kit-faq-test-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "bindings",
              namespace: "faq-test",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "faq-test" }, () => ({
              contents: `export const env = new Proxy({ APP_URL: ${JSON.stringify(FAQ_ORIGIN)} }, {
                get(target, key) {
                  if (key === "APP_URL") return target.APP_URL;
                  throw new Error("FAQ accessed a non-public binding: " + String(key));
                }
              });`,
              loader: "js",
            }));
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const { js, css } = compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              if (css?.code) styles.push(css.code);
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    const module = (await import(pathToFileURL(outfile).href)) as {
      renderPage: (data: FaqData) => string;
      load: FaqLoad;
      csr: boolean;
      replaceFaqs: (groups: FaqGroups) => void;
    };
    return {
      ...module,
      css: styles.join("\n"),
      applicationModules: Object.keys(result.metafile.inputs).filter(
        (path) => !path.includes("node_modules/"),
      ),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function loadKitFaq(
  bundle: Awaited<ReturnType<typeof buildKitFaqBundle>>,
  path = "/faq",
) {
  const headers = new Headers();
  const event: Record<string, unknown> = {
    url: new URL(path, FAQ_ORIGIN),
    setHeaders: (values: Record<string, string>) => {
      for (const [key, value] of Object.entries(values)) headers.set(key, value);
    },
  };
  for (const key of ["cookies", "locals", "parent", "fetch", "request", "platform"]) {
    Object.defineProperty(event, key, {
      get() {
        throw new Error(`FAQ accessed forbidden load capability: ${key}`);
      },
    });
  }
  const data = await bundle.load(event);
  return { data, headers, html: bundle.renderPage(data) };
}
