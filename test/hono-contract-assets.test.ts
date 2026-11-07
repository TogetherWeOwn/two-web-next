import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { PINNED_ASSET_CACHE_CONTROL } from "../src/pinned-assets";

const baseEnv = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_CLIENT_SECRET: "test-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "test-bot",
  DISCORD_INVITE_URL: "https://discord.gg/test",
  SESSION_SECRET: "test-session-signing-key-at-least-32-bytes",
};
const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x80, 0xff, 0x0a]);
const etag = '"synthetic-font-v1"';
const assetCache = "public, max-age=120";
const fontHeaders = {
  "content-type": "font/woff2",
  "content-length": String(bytes.byteLength),
  "cache-control": assetCache,
  etag,
};

// These doubles supply asset outcomes, not a filesystem or ETag implementation.
// The real CSS binding is exercised by trust-hosts-worker.test.ts. Here the
// registered Hono fallback must delegate raw requests and preserve the result.
const fixture = (response: Response) => {
  const fetch = vi.fn(async (_request: Request) => response);
  return { fetch, env: { ...baseEnv, ASSETS: { fetch } } };
};

const requestFor = (path: string, method = "GET", headers?: HeadersInit) =>
  new Request(`${baseEnv.APP_URL}${path}`, { method, headers });

describe("Hono static asset passthrough contracts", () => {
  it.each(["GET", "HEAD"])(
    "%s preserves registered font metadata and binary bytes (HEAD has no body)",
    async (method) => {
      const { fetch, env } = fixture(new Response(bytes, { headers: fontHeaders }));
      const request = requestFor("/fonts/fixture.woff2", method);
      const res = await app.fetch(request, env);

      expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(fetch.mock.calls[0]![0].method).toBe(method);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe(PINNED_ASSET_CACHE_CONTROL);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        method === "HEAD" ? new Uint8Array() : bytes,
      );
    },
  );

  it.each(["GET", "HEAD"])("%s preserves a pinned font 304 and its ETag", async (method) => {
    const { fetch, env } = fixture(
      new Response(null, { status: 304, headers: { etag, "cache-control": assetCache } }),
    );
    const request = requestFor("/fonts/fixture.woff2?revision=1", method, {
      "if-none-match": etag,
    });
    const res = await app.fetch(request, env);

    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(fetch.mock.calls[0]![0].headers.get("if-none-match")).toBe(etag);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe(PINNED_ASSET_CACHE_CONTROL);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toBe("");
  });

  describe.each(["/missing.css", "/fonts/missing.woff2", "/styles.css/"])(
    "asset miss at %s",
    (path) => {
      it.each(["GET", "HEAD"])(
        "%s replaces the binding 404 with the branded no-store response",
        async (method) => {
          const { fetch, env } = fixture(
            new Response("synthetic asset miss", {
              status: 404,
              headers: { ...fontHeaders, "x-asset-only": "miss" },
            }),
          );
          const request = requestFor(path, method);
          const res = await app.fetch(request, env);

          expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
          expect(res.status).toBe(404);
          expect(res.headers.get("content-type")).toContain("text/html");
          expect(res.headers.get("cache-control")).toBe("no-store, private");
          expect(res.headers.get("etag")).toBeNull();
          expect(res.headers.get("x-asset-only")).toBeNull();
          expect(res.headers.get("location")).toBeNull();
          const body = await res.text();
          if (method === "HEAD") expect(body).toBe("");
          else expect(body).toContain("We cannot find that page");
          expect(body).not.toContain("synthetic asset miss");
        },
      );
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%s on a known static path never calls ASSETS",
    async (method) => {
      const { fetch, env } = fixture(new Response(bytes, { headers: fontHeaders }));
      // Admit unsafe verbs through sameOrigin so this proves the fallback's
      // method gate rather than stopping at an unrelated 403.
      const request = requestFor("/fonts/fixture.woff2", method, { origin: baseEnv.APP_URL });
      const res = await app.fetch(request, env);

      expect(res.status).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("We cannot find that page");
    },
  );

  it.each([
    ["/fonts/fixture.woff2?revision=1", true],
    ["/fonts/fixture%20name.woff2", true],
    ["/fonts%2Ffixture.woff2", false],
    ["/fonts/nested/fixture.woff2", false],
    ["/fonts/fixture.woff2/", false],
    ["/islands/nested/fixture.js?revision=1", false],
  ] as const)("delegates %s without a Hono redirect or path rewrite", async (path, pinned) => {
    const { fetch, env } = fixture(new Response(bytes, { headers: fontHeaders }));
    const request = requestFor(path);
    const res = await app.fetch(request, env);

    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(fetch.mock.calls[0]![0].url).toBe(`${baseEnv.APP_URL}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe(pinned ? PINNED_ASSET_CACHE_CONTROL : assetCache);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
