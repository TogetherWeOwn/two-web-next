// Removing either page's accountChrome override must restore the wrong guest
// action and fail its rendered-header cases. No loaders, DB or Discord calls.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { HotzoneSignalPage, HotzonesIndexPage, renderHotzoneGrid } from "../src/hotzones/pages";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
let renderKit;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Index from "./web/src/routes/hotzones/+page.svelte";
        import Signal from "./web/src/routes/hotzones/[signal]/+page.svelte";
        export function renderKit(signal, data) {
          return render(signal ? Signal : Index, { props: { data } }).body;
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "kit-hotzones-header-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  ({ renderKit } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  ));
});

const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
const cases = ["all", "2026-10"].flatMap((season) =>
  [null, "joins", "voice", "games"].map((signal) => ({
    signal,
    season,
    path: `/hotzones${signal ? `/${signal}` : ""}${season === "all" ? "" : `?season=${season}`}`,
  })),
);

function fixture(signal, season) {
  const gridHtml = renderHotzoneGrid(cells, `Activity for season ${season}`);
  return {
    appUrl: "https://example.test",
    season,
    signal,
    joins: cells,
    voice: cells,
    games: cells,
    cells,
    total: 0,
    joinsTotal: 0,
    eventCount: 0,
    retentionNote: null,
    estimated: signal !== "joins",
    gridHtml,
    joinsHtml: gridHtml,
    voiceHtml: gridHtml,
    gamesHtml: gridHtml,
  };
}

for (const renderer of ["Hono", "Kit"]) {
  describe(`${renderer} hotzone header action`, () => {
    it.each(cases)("opens Discord directly on $path", async ({ signal, season }) => {
      const data = fixture(signal, season);
      const html =
        renderer === "Kit"
          ? renderKit(signal, data)
          : await (signal ? HotzoneSignalPage(data) : HotzonesIndexPage(data)).toString();
      const header = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
      expect(header).toBeDefined();
      expect(header).toContain('aria-label="Account"');
      expect(
        header?.match(/<a\b[^>]*href="\/discord"[^>]*>\s*Open Discord\s*<\/a>/g) ?? [],
      ).toHaveLength(1);
      expect(header).not.toContain("Sign in with Discord");
      expect(header).not.toContain("/join/discord");
    });
  });
}
