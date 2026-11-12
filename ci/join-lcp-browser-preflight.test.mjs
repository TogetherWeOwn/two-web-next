import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "playwright";
import { validateInlineInBrowser } from "./join-lcp-browser-preflight.mjs";

const sheets = ["body{color:rgb(1,2,3)}", "#join-heading{font-size:24px}", "body{margin-top:8px}"];

async function exercise(scenario) {
  let mode = "control";
  let browser;
  const contexts = [];
  const events = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/sheet")) {
      const index = Number(request.url.slice(6));
      response.writeHead(200, { "content-type": "text/css" }).end(sheets[index]);
      return;
    }
    if (scenario === "navigation" && mode === "control") {
      response.writeHead(503).end();
      return;
    }
    let css = sheets.join("\n");
    if (mode === "inline-stylesheets" && scenario === "empty") css = "";
    if (mode === "inline-stylesheets" && scenario === "rules") css += "\nh1{border:0}";
    if (mode === "inline-stylesheets" && scenario === "computed") css = css.replace("24px", "30px");
    const hash = createHash("sha256").update(css).digest("base64");
    const csp =
      scenario === "canary"
        ? "style-src 'self' 'unsafe-inline'"
        : `style-src 'self' 'sha256-${hash}'`;
    let styles =
      mode === "control"
        ? sheets.map((_, index) => `<link rel="stylesheet" href="/sheet${index}">`).join("")
        : `<style>${css}</style>`;
    if (mode === "inline-stylesheets" && scenario === "sheets")
      styles += '<link rel="stylesheet" href="/sheet0">';
    if (mode === "inline-stylesheets" && scenario === "violation")
      styles += "<style>h1{color:red}</style>";
    const heading = scenario === "heading" ? "<h1>Join</h1>" : '<h1 id="join-heading">Join</h1>';
    response.writeHead(200, { "content-type": "text/html", "content-security-policy": csp });
    response.end(`<!doctype html><html><head>${styles}</head><body>${heading}</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const trackedChromium = {
    async launch(options) {
      browser = await chromium.launch(options);
      return {
        async newContext(options) {
          const context = await browser.newContext(options);
          const contextMode = mode;
          events.push(`open:${contextMode}`);
          contexts.push(context);
          return {
            addInitScript: (...args) => context.addInitScript(...args),
            newPage: (...args) => context.newPage(...args),
            async close() {
              events.push(`close-start:${contextMode}`);
              if (scenario === "context-close") throw new Error("context close failed");
              await context.close();
              events.push(`close-done:${contextMode}`);
            },
          };
        },
        async close() {
          events.push("browser-close");
          await browser.close();
          if (scenario === "browser-close") throw new Error("browser close failed");
        },
      };
    },
  };
  try {
    const result = await validateInlineInBrowser(
      server.address().port,
      (next) => {
        events.push(`mode:${next}`);
        mode = next;
      },
      trackedChromium,
    );
    return result;
  } finally {
    server.close();
    await once(server, "close");
    assert.equal(mode, "control");
    assert.equal(browser?.isConnected(), false);
    for (const context of contexts) assert.equal(context.pages().length, 0);
    const controlClosed = events.indexOf("close-done:control");
    const browserClosed = events.indexOf("browser-close");
    if (scenario === "context-close") {
      assert.equal(controlClosed, -1);
      assert.ok(
        events.indexOf("close-start:control") !== -1 &&
          browserClosed > events.indexOf("close-start:control"),
      );
    } else {
      assert.ok(controlClosed !== -1 && browserClosed > controlClosed);
    }
    const inlineStart = events.indexOf("mode:inline-stylesheets");
    if (inlineStart !== -1) {
      const inlineClosed = events.indexOf("close-done:inline-stylesheets");
      assert.ok(controlClosed < inlineStart);
      assert.ok(inlineClosed > inlineStart && inlineClosed < browserClosed);
    }
    assert.equal(events.at(-1), "mode:control");
    if (scenario === "context-close") assert.equal(inlineStart, -1);
  }
}

test("browser preflight accepts matching applied styles and enforced CSP", async () => {
  const result = await exercise("valid");
  assert.equal(result.control.sheets, 3);
  assert.equal(result["inline-stylesheets"].sheets, 1);
  assert.equal(result.control.rules, 3);
});

for (const [scenario, expected] of [
  ["navigation", /document did not load/],
  ["heading", /missing join heading/],
  ["sheets", /missing styles or unexpected CSP violation/],
  ["empty", /missing styles or unexpected CSP violation/],
  ["rules", /CSS rules or sampled computed styles differ/],
  ["computed", /CSS rules or sampled computed styles differ/],
  ["violation", /missing styles or unexpected CSP violation/],
  ["canary", /Timeout/],
  ["context-close", /context close failed/],
  ["browser-close", /browser close failed/],
]) {
  test(`browser preflight rejects ${scenario}`, async () => {
    await assert.rejects(exercise(scenario), expected);
  });
}
