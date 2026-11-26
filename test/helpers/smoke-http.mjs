import { once } from "node:events";
import { createServer } from "node:http";
import { build } from "esbuild";
import { smokeFixtures } from "../fixtures/smoke-routes.mjs";

// Producer-derived security.txt body: buildSecurityTxt bundled once from
// src/security-txt.ts, so the passing fixture is the exact producer output for the loopback
// origin and cannot drift from it. The loopback stub has no TLS, so like the
// real Worker on an http origin the body carries no Canonical line; the https
// Canonical path is covered by the securityTxtAssertions unit tests.
let securityTxtBuilderPromise = null;
function securityTxtBuilder() {
  securityTxtBuilderPromise ??= build({
    entryPoints: ["src/security-txt.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  }).then(
    async (bundle) =>
      (
        await import(
          `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
        )
      ).buildSecurityTxt,
  );
  return securityTxtBuilderPromise;
}

export async function startSmokeFixture(t, change = () => {}, extraFixtures = {}) {
  const requests = [];
  const buildSecurityTxt = await securityTxtBuilder();
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      host: request.headers.host,
      override: request.headers["cloudflare-workers-version-overrides"],
      fetchMetadata: ["mode", "dest", "site"].map((name) => request.headers[`sec-fetch-${name}`]),
    });
    const fixture = extraFixtures[request.url] ?? smokeFixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    // Origin-aware SEO fixtures: the stub advertises its own
    // origin the way the Worker advertises APP_URL, so the probe's
    // same-origin robots/sitemap assertions exercise a true positive. The
    // security.txt body is rendered from the real producer for that origin.
    const origin = `http://${request.headers.host}`;
    const resolved =
      request.url === "/.well-known/security.txt"
        ? buildSecurityTxt(origin)
        : typeof body === "function"
          ? body(origin)
          : body;
    const result = {
      status,
      body: resolved,
      headers: {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
        ...(type ? { "content-type": `${type}; charset=UTF-8` } : {}),
        ...(type === "text/html" ? { "x-robots-tag": "noindex, nofollow" } : {}),
        // Cutover identity: the live /up answers as two-web-next
        // with no-store, so the stub advertises the same pair.
        ...(request.url === "/up"
          ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
          : {}),
        ...(location ? { location } : {}),
        "set-cookie": "fixture=not-a-session; Path=/",
      },
    };
    change(request.url, result, request.headers);
    response.writeHead(result.status, result.headers);
    if (result.body === null) response.flushHeaders();
    else response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
