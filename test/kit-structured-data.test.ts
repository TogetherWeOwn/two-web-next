// Kit JSON-LD seam: the real web/src/lib/JsonLd.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the harness shape of
// kit-home-render), so each assertion runs on the bytes the page emits.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSiteGraph, escapeJsonLdText, eventJsonLd, safeJsonLd } from "../src/seo-json-ld";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

const APP_URL = "https://next.example.test";
const BLOCK = /<script type="application\/ld\+json" data-testid="([^"]+)">([\s\S]*?)<\/script>/g;

type Block = { testid: string; payload: string };
type RenderJsonLd = (props: { testid: string; json: string }) => string;

let renderJsonLd: RenderJsonLd;
let scratch = "";

function blocksIn(html: string): Block[] {
  return [...html.matchAll(BLOCK)].map((m) => ({ testid: m[1]!, payload: m[2]! }));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-structured-data-"));
  const entry = join(scratch, "kit-json-ld-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import JsonLd from ${JSON.stringify(join(root, "web/src/lib/JsonLd.svelte"))};
export function renderJsonLd(props) {
  return render(JsonLd, { props }).body;
}
`,
  );
  const outfile = join(scratch, "kit-json-ld-bundle.mjs");
  await build({
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
        name: "kit-json-ld-svelte-ssr",
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
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    renderJsonLd: RenderJsonLd;
  };
  renderJsonLd = mod.renderJsonLd;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const hostileTitle = "</script><script>alert(1)</script><!--   & </SCRIPT>";

const hostileEvent = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: hostileTitle,
  description: "<img src=x onerror=alert(1)>",
  purpose: null,
  startsAt: new Date("2026-11-01T19:00:00Z"),
  endsAt: new Date("2026-11-01T21:00:00Z"),
  location: null,
  status: "published",
};

describe("JsonLd component: one escaped block per entity", () => {
  it("emits exactly one block carrying the shared site graph", () => {
    const html = renderJsonLd({ testid: "site-jsonld", json: safeJsonLd(buildSiteGraph(APP_URL)) });
    const blocks = blocksIn(html);
    expect(blocks.map((b) => b.testid)).toEqual(["site-jsonld"]);
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(JSON.parse(blocks[0]!.payload)).toEqual(buildSiteGraph(APP_URL));
  });

  it("keeps a closing-script title from closing the block", () => {
    const html = renderJsonLd({ testid: "event-jsonld", json: eventJsonLd(hostileEvent, APP_URL) });
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    const [block] = blocksIn(html);
    expect(JSON.parse(block!.payload).name).toBe(hostileTitle);
  });

  it("re-escapes an already escaped payload without changing it", () => {
    const once = safeJsonLd({ name: hostileTitle });
    expect(escapeJsonLdText(once)).toBe(once);
    const html = renderJsonLd({ testid: "event-jsonld", json: once });
    expect(blocksIn(html)[0]!.payload).toBe(once);
  });

  it("escapes angle brackets, ampersands and the line separators", () => {
    const value = "<b>&\u2028\u2029";
    const payload = escapeJsonLdText(JSON.stringify({ a: value }));
    expect(payload).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(payload).a).toBe(value);
  });
});

describe("Kit private surfaces carry no structured data", () => {
  const PRIVATE_SURFACES = [
    "web/src/lib/ProfileView.svelte",
    "web/src/routes/profile",
    "web/src/routes/members",
    "web/src/routes/admin",
  ];

  it.each(PRIVATE_SURFACES)("%s emits no JSON-LD and imports no JsonLd seam", (surface) => {
    const target = join(root, surface);
    const files = target.endsWith(".svelte")
      ? [target]
      : readdirSync(target, { recursive: true })
          .map(String)
          .filter((name) => name.endsWith(".svelte"))
          .map((name) => join(target, name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("ld+json");
      expect(source, file).not.toContain("JsonLd");
    }
  });
});
