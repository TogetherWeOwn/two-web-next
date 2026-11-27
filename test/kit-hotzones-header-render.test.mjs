// Removing either page's accountChrome override must restore the wrong guest
// action and fail its rendered-header cases. No loaders, DB or Discord calls.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { HotzoneSignalPage, HotzonesIndexPage, renderHotzoneGrid } from "../src/hotzones/pages";
import {
  childText,
  documentElements,
  element,
  elements,
  parseRenderedPage,
  renderedAttribute,
  text,
} from "./helpers/rendered-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
let renderKit;
let kitCss = "";

beforeAll(async () => {
  const styles = [];
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import "./web/src/lib/site-header.css";
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
          plugin.onLoad({ filter: /\.css$/ }, ({ path }) => {
            styles.push(readFileSync(path, "utf8"));
            return { contents: "", loader: "js" };
          });
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
  kitCss = styles.join("\n");
  expect(kitCss).toContain(readFileSync(join(root, "web/src/lib/site-header.css"), "utf8"));
  const kit = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
  renderKit = (signal, data) =>
    `<style data-kit-imported-css>${kitCss}</style>${kit.renderKit(signal, data)}`;
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
      const page = parseRenderedPage(html);
      if (renderer === "Kit") {
        const styles = documentElements(page, "style").filter(
          (node) => renderedAttribute(node, "data-kit-imported-css") !== undefined,
        );
        expect(styles.map(childText)).toEqual([kitCss]);
      }
      const header = element(page, "header");
      const account = element(header, "nav", { "aria-label": "Account" });
      const discord = element(account, "a", { href: "/discord" });
      expect(text(discord)).toBe("Open Discord");
      expect(elements(header, "a", { href: "/discord" })).toHaveLength(1);
      expect(text(header)).not.toContain("Sign in with Discord");
      expect(
        elements(header, "a").map((link) => renderedAttribute(link, "href")),
      ).not.toContainEqual(expect.stringContaining("/join/discord"));
    });
  });
}

it("queries visible header actions across hydration comments", () => {
  const page = parseRenderedPage(`
    <header>
      <div hidden><a href="/discord">Hidden action</a></div>
      <template><a href="/discord">Template action</a></template>
      <!-- <a href="/discord">Comment action</a> -->
      <a href='/discord' class='action'><!--[-->Open Dis<!---->cord<!--]--></a>
    </header>
  `);
  const header = element(page, "header");
  expect(text(element(header, "a", { href: "/discord" }))).toBe("Open Discord");
  expect(text(header)).toBe("Open Discord");
});
