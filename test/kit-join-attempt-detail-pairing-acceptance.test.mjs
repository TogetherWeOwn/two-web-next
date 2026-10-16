// Render the real page and admin shell with distinct fixture values. Each
// definition term must own its immediately following value, not merely exist
// somewhere in the output. Uses the same SSR toolchain as kit-home-render.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
let renderPage;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Page from "./web/src/routes/admin/join-attempts/[id]/+page.svelte";
        export function renderPage(view) {
          return render(Page, { props: { data: { view } } }).body;
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
        name: "kit-join-attempt-detail-pairing-ssr",
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
  const bundled = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`;
  ({ renderPage } = await import(bundled));
});

const VIEW = {
  id: 7,
  outcome: "added",
  source: "join",
  requestId: "request-pairing-7",
  discordId: "100000000000000201",
  createdAt: "2026-10-01T12:34:56.789Z",
};

const expectedPairs = [
  ["Outcome", VIEW.outcome],
  ["Source", VIEW.source],
  ["Attempted at (UTC)", `<time datetime="${VIEW.createdAt}">${VIEW.createdAt}</time>`],
  ["Request ID", VIEW.requestId],
  ["Discord ID", VIEW.discordId],
];

// Extract [term, definition] pairs by walking the markup token by token.
// Svelte's hydration markers are HTML comments; a comment ends at the first
// `-->`, so skipping comment tokens ignores the markers without ever
// building a rewritten copy of the markup. Only whitespace and comments may
// sit between a </dt> and its <dd>: any intervening element or text breaks
// the pairing, exactly as the assertions require. Markup inside a <dd>
// (the <time> element) is kept verbatim.
function extractPairs(html) {
  const pairs = [];
  let index = 0;
  let term = null;
  let capturing = null;
  let buffer = "";
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<") {
      const close = html.indexOf(">", index);
      if (close === -1) break;
      const tag = html.slice(index, close + 1);
      if (tag === "<dt>") {
        capturing = "dt";
        buffer = "";
        term = null;
      } else if (tag === "</dt>") {
        term = capturing === "dt" ? buffer : null;
        capturing = null;
        buffer = "";
      } else if (tag === "<dd>") {
        if (term !== null) {
          capturing = "dd";
          buffer = "";
        }
      } else if (tag === "</dd>") {
        if (capturing === "dd" && term !== null) pairs.push([term, buffer]);
        capturing = null;
        term = null;
        buffer = "";
      } else if (capturing === "dd") {
        buffer += tag;
      } else if (capturing === null && term !== null) {
        term = null;
      }
      index = close + 1;
      continue;
    }
    const next = html.indexOf("<", index);
    const text = html.slice(index, next === -1 ? html.length : next);
    if (capturing !== null) buffer += text;
    else if (term !== null && text.trim() !== "") term = null;
    index = next === -1 ? html.length : next;
  }
  return pairs;
}

describe("acceptance: rendered join-attempt detail label/value pairing", () => {
  it.each(expectedPairs)("binds %s to its own immediately following value", (label, value) => {
    const pairs = extractPairs(renderPage(VIEW));
    const values = pairs
      .filter(([term]) => term === label)
      .map(([, definition]) => definition.replace(/\s+/g, " ").trim());
    expect(values).toEqual([value]);
  });
});
