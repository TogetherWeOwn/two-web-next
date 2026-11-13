import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const { compile } = createRequire(new URL("../web/package.json", import.meta.url))(
  "svelte/compiler",
);

// The caller owns the returned server and must close it, including on assertion failures.
export async function serveKitFixture({ fixture, styles = "", bodyClass = "", routes = {} }) {
  let css = "";
  async function bundle(generate, contents) {
    const result = await build({
      stdin: { contents, resolveDir: root, loader: "js" },
      bundle: true,
      write: false,
      format: generate === "server" ? "esm" : "iife",
      platform: generate === "server" ? "node" : "browser",
      conditions: generate === "client" ? ["browser"] : [],
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: `fixture-${generate}`,
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const result = compile(readFileSync(path, "utf8"), { generate, filename: path });
              if (generate === "client") css += `${result.css?.code ?? ""}\n`;
              return { contents: result.js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    return result.outputFiles[0].text;
  }
  const modulePath = JSON.stringify(fixture);
  const ssr = await bundle(
    "server",
    `import { render } from 'svelte/server'; import Fixture from ${modulePath}; export const html = render(Fixture).body;`,
  );
  const { html } = await import(
    `data:text/javascript;base64,${Buffer.from(ssr).toString("base64")}`
  );
  const js = await bundle(
    "client",
    `import { hydrate } from 'svelte'; import Fixture from ${modulePath}; hydrate(Fixture, { target: document.getElementById('fixture'), recover: false }); document.documentElement.dataset.hydrated = 'true';`,
  );
  const server = createServer((request, response) => {
    if (request.url === "/style.css") {
      response.writeHead(200, { "content-type": "text/css" }).end(styles + css);
    } else if (request.url === "/fixture.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(js);
    } else if (Object.hasOwn(routes, request.url)) {
      routes[request.url](request, response);
    } else if (request.url === "/") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body class="${bodyClass}"><div id="fixture">${html}</div><script src="/fixture.js"></script></body></html>`,
        );
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
