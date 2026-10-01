import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Exercise the real asset binding: constructed Response mocks have mutable
// headers and miss the secureHeaders failure on ASSETS.fetch responses.
// Local workerd only; no remote bindings, credentials, database or deployment.
describe.each(["wrangler.jsonc", "wrangler.local.jsonc"])("TrustHosts with real Worker assets (%s)", (configPath) => {
  const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  let mf: Miniflare;
  const unexpected: string[] = [];
  const host = new URL(config.vars.APP_URL).host;
  const css = readFileSync("public/styles.css", "utf8");

  // The RPC fetch bridge rewrites Host. Local HTTP preserves the authority
  // seen by the Worker, including untrusted hosts on requests for real assets.
  const request = async (path: string, method = "GET", headers: Record<string, string> = {}) => {
    const url = new URL(path, await mf.ready);
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(url.toString(), { method, headers: { host, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            responseHeaders.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
          }
          resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: res.statusCode!, headers: responseHeaders,
          }));
        });
      });
      req.on("error", reject);
      req.end();
    });
  };

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["src/worker.ts"], bundle: true, write: false, format: "esm",
      platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      name: "trust-hosts-assets", modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: "2026-09-29", compatibilityFlags: ["nodejs_compat"],
      assets: {
        ...config.assets, directory: resolve(config.assets.directory),
        routerConfig: { has_user_worker: true },
      },
      bindings: {
        APP_URL: config.vars.APP_URL, DISCORD_CLIENT_ID: "test-client",
        DISCORD_CLIENT_SECRET: "test-secret", DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_BOT_TOKEN: "test-bot", DISCORD_INVITE_URL: "https://discord.gg/test",
        SESSION_SECRET: "test-session-signing-key-at-least-32-bytes",
      },
      outboundService: async (req) => {
        unexpected.push(req.url);
        throw new Error("External network forbidden by asset fixture");
      },
    }));
    await mf.ready;
  }, 30_000);
  afterEach(() => expect(unexpected).toEqual([]));
  afterAll(async () => { await mf?.dispose(); });

  const securityHeaders = (res: Response) => {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  };

  it.each(["GET", "HEAD"])("serves trusted CSS %s with asset metadata and security headers", async (method) => {
    const res = await request("/styles.css", method);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-control")).not.toContain("no-store");
    securityHeaders(res);
    expect(await res.text()).toBe(method === "HEAD" ? "" : css);
  });

  it("preserves the asset 304 response and ETag while applying security headers", async () => {
    const first = await request("/styles.css");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const cached = await request("/styles.css", "GET", { "if-none-match": etag! });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    securityHeaders(cached);
    expect(await cached.text()).toBe("");
  });

  it.each([
    ["GET", "evil.example.test"], ["HEAD", "evil.example.test"],
    ["GET", host.startsWith("localhost") ? "127.0.0.1" : "localhost"],
    ["HEAD", host.startsWith("localhost") ? "127.0.0.1" : "localhost"],
  ])("refuses asset %s for untrusted Host %s before serving CSS", async (method, untrusted) => {
    const res = await request("/styles.css", method, { host: untrusted });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    securityHeaders(res);
    const body = await res.text();
    if (method === "GET") expect(body).toContain("We cannot find that page");
    else expect(body).toBe("");
    expect(body).not.toContain(untrusted);
    expect(body).not.toBe(css);
  });

  it("retains the branded no-store 404 for a trusted missing asset", async () => {
    const res = await request("/missing.css");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    securityHeaders(res);
    expect(await res.text()).toContain("We cannot find that page");
  });
});
