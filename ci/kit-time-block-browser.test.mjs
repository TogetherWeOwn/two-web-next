import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = process.cwd();
const fixture = resolve(root, "test/fixtures/TimeBlockBrowserFixture.svelte");
const { compile } = createRequire(join(root, "web/package.json"))("svelte/compiler");

async function bundle(generate) {
  const result = await build({
    stdin: {
      contents:
        generate === "server"
          ? `import {render} from 'svelte/server'; import Fixture from ${JSON.stringify(fixture)}; export const renderFixture = data => render(Fixture, {props:{data}}).body;`
          : `import {hydrate} from 'svelte'; import Fixture from ${JSON.stringify(fixture)}; hydrate(Fixture, {target:document.querySelector('#fixture'), props:{data:window.fixtureData}});`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: generate === "server" ? "esm" : "iife",
    platform: generate === "server" ? "node" : "browser",
    conditions: generate === "server" ? [] : ["browser"],
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    plugins: [
      {
        name: `time-block-${generate}`,
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate,
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

test("time block hydrates and withdraws expired snapshot claims", {
  timeout: 120_000,
}, async () => {
  const server = await bundle("server");
  const { renderFixture } = await import(
    `data:text/javascript;base64,${Buffer.from(server).toString("base64")}`
  );
  const client = await bundle("client");
  const data = { asOf: "2026-11-07T19:20:00Z", start: "2026-11-07T19:30:00Z" };
  const html = renderFixture(data);
  assert.doesNotMatch(html, /starts in|Live since/);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date(data.asOf) });
    await page.setContent(`<div id="fixture">${html}</div>`);
    await page.evaluate((value) => {
      window.fixtureData = value;
    }, data);
    await page.addScriptTag({ content: client });
    await page.getByText("starts in 10 m").waitFor();
    assert.match(await page.locator(".time-block").innerText(), /America\/New_York/);
    await page.clock.fastForward(60_000);
    await page.getByRole("link", { name: /Refresh/ }).waitFor();
    assert.doesNotMatch(await page.locator(".time-block").innerText(), /starts in/);
    await page.clock.fastForward(9 * 60_000);
    await page.getByRole("button", { name: "Replace snapshot" }).click();
    await page.getByText(/Live since/).waitFor();
    assert.match(await page.locator(".time-block").innerText(), /8 in the room/);
    await page.clock.fastForward(60_000);
    await page.getByText(/live as of/).waitFor();
    assert.doesNotMatch(await page.locator(".time-block").innerText(), /Live since|8 in the room/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
