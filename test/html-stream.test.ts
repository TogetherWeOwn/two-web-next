import { describe, expect, it, vi } from "vitest";
import app from "./app";
import worker from "../src/worker";
import { withStreamedBody } from "../src/html-stream";
import {
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  ROUTE_MANIFEST,
  type HookEventLike,
} from "../src/route-ownership";
import type { Env, JobsEnv } from "../src/env";

// TWO-7591/TWO-8089: the deployed remote-placement lane marks text/html
// `cache-control: no-transform` for every body shape, so the platform's own
// edge encoding never runs on HTML. The Worker encodes the document itself:
// a gzip Content-Encoding stream when the client accepts gzip, the plain
// unknown-length stream otherwise — both at manual encodeBody so the edge
// never re-encodes the payload.
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const requestWith = (acceptEncoding?: string): Request =>
  new Request("https://next.example.test/about", {
    headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
  });

const GZIP_REQUEST = requestWith("gzip");

const htmlResponse = (body: string, init?: ResponseInit): Response =>
  new Response(body, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "content-length": String(body.length),
      "cache-control": "public, max-age=3600",
      "x-test-marker": "kept",
      ...init?.headers,
    },
  });

const gunzip = async (res: Response): Promise<string> =>
  new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();

describe("withStreamedBody", () => {
  it("gzip-encodes an HTML body when the client accepts gzip", async () => {
    const res = htmlResponse("<!doctype html><p>hi</p>");
    const out = withStreamedBody(res, GZIP_REQUEST);
    expect(out).not.toBe(res);
    expect(out.status).toBe(200);
    expect(out.headers.get("x-test-marker")).toBe("kept");
    expect(out.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(out.headers.get("vary")).toBe("accept-encoding");
    expect(await gunzip(out)).toBe("<!doctype html><p>hi</p>");
  });

  it("merges accept-encoding into an existing Vary list", () => {
    const res = htmlResponse("<p>hi</p>", { headers: { vary: "Cookie, X-Two-Island" } });
    const out = withStreamedBody(res, GZIP_REQUEST);
    expect(out.headers.get("vary")).toBe("Cookie, X-Two-Island, accept-encoding");
  });

  it("does not duplicate accept-encoding on Vary", () => {
    const res = htmlResponse("<p>hi</p>", { headers: { vary: "Accept-Encoding, Cookie" } });
    const out = withStreamedBody(res, GZIP_REQUEST);
    expect(out.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it.each([["gzip, br"], ["GZIP"], ["*"], ["gzip;q=0.5"], ["br, gzip;q=1"]])(
    "encodes for Accept-Encoding %s",
    async (acceptEncoding) => {
      const out = withStreamedBody(htmlResponse("<p>ok</p>"), requestWith(acceptEncoding));
      expect(out.headers.get("content-encoding")).toBe("gzip");
      expect(await gunzip(out)).toBe("<p>ok</p>");
    },
  );

  it.each([["br"], ["identity"], ["gzip;q=0"], ["gzip;q=0.0, br"], ["xgzip"], ["*;q=0"]])(
    "streams plain when the client does not accept gzip: %s",
    async (acceptEncoding) => {
      const out = withStreamedBody(htmlResponse("<p>ok</p>"), requestWith(acceptEncoding));
      expect(out.headers.get("content-encoding")).toBeNull();
      expect(out.headers.get("content-length")).toBeNull();
      expect(out.headers.get("vary")).toBe("accept-encoding");
      expect(await out.text()).toBe("<p>ok</p>");
    },
  );

  it("streams plain when Accept-Encoding is absent", async () => {
    const out = withStreamedBody(htmlResponse("<p>hi</p>"), requestWith());
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(await out.text()).toBe("<p>hi</p>");
  });

  it("returns non-HTML responses unchanged", () => {
    const json = new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    expect(withStreamedBody(json, GZIP_REQUEST)).toBe(json);
  });

  it("returns already-encoded HTML unchanged (never double-compressed)", () => {
    const encoded = new Response("<p>hi</p>", {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
    });
    expect(withStreamedBody(encoded, GZIP_REQUEST)).toBe(encoded);
  });

  it("returns bodyless responses unchanged", () => {
    const empty = new Response(null, {
      status: 204,
      headers: { "content-type": "text/html" },
    });
    expect(withStreamedBody(empty, GZIP_REQUEST)).toBe(empty);
  });

  it("returns an already-consumed HTML response unchanged (locked stream)", async () => {
    const consumed = new Response("<p>read already</p>", {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    await consumed.text();
    expect(withStreamedBody(consumed, GZIP_REQUEST)).toBe(consumed);
  });

  it("returns an unread-but-reader-locked HTML body unchanged", () => {
    // Separate predicate from bodyUsed: a body locked by a live reader cannot
    // pipe either, and removing the body.locked check throws instead of
    // returning the response untouched.
    const held = new Response("<p>held</p>", {
      headers: { "content-type": "text/html" },
    });
    const reader = held.body!.getReader();
    expect(held.bodyUsed).toBe(false);
    expect(held.body!.locked).toBe(true);
    expect(withStreamedBody(held, GZIP_REQUEST)).toBe(held);
    reader.releaseLock();
  });
});

describe("HTML wire shape through the served worker", () => {
  const context = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  const serve = (path: string, acceptEncoding?: string) =>
    worker.fetch(
      new Request(`https://next.example.test${path}`, {
        headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
      }),
      env as unknown as JobsEnv,
      context,
    );

  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s answers gzip-encoded HTML for a gzip client",
    async (path) => {
      const res = await serve(path, "gzip");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-length")).toBeNull();
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(res.headers.get("vary") ?? "").toContain("accept-encoding");
      expect((await gunzip(res)).length).toBeGreaterThan(1000);
    },
  );

  it("branded 404s also encode without a declared Content-Length", async () => {
    const res = await serve("/__missing__", "gzip");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect((await gunzip(res)).length).toBeGreaterThan(100);
  });

  it("a client without gzip support gets the plain stream", async () => {
    const res = await serve("/about", "br");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it("JSON routes keep their existing shape", async () => {
    const res = await serve("/version");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

// Kit dispatch path (TWO-7591 review/TWO-8089): withStreamedBody runs inside
// decorateKitResponse, so a Kit-rendered HTML response must leave the
// dispatch encoded exactly like the Hono path and a Hono-owned response must
// pass through untouched — deleting the seam must fail this file.
const KIT_APP_URL = "https://next.example.test";

const kitEventFor = (path: string, routeId: string, acceptEncoding?: string): HookEventLike => {
  const request = new Request(`${KIT_APP_URL}${path}`, {
    method: "GET",
    headers: {
      host: "next.example.test",
      ...(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }),
    },
  });
  return { request, url: new URL(request.url), route: { id: routeId } };
};

const kitManifestFor = (path: string) => {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === path);
  if (!shipped) throw new Error(`shipped GET ${path} manifest entry missing`);
  expect(shipped.enabled).toBe(true);
  return [{ ...shipped }];
};

const kitHtmlResponse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "content-length": String(body.length),
    },
  });

describe("Kit dispatch HTML wire shape", () => {
  it("gzip-encodes a decorated Kit HTML response for a gzip client", async () => {
    const body = "<main><h1>Events</h1></main>";
    const res = await dispatchHookRequest(kitEventFor("/events", "/events", "gzip"), {
      appUrl: KIT_APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(async () => kitHtmlResponse(body)),
      manifest: kitManifestFor("/events"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe("kit");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzip(res)).toBe(body);
  });

  it("streams a decorated Kit HTML response plain without client gzip", async () => {
    const body = "<main><h1>Events</h1></main>";
    const res = await dispatchHookRequest(kitEventFor("/events", "/events"), {
      appUrl: KIT_APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(async () => kitHtmlResponse(body)),
      manifest: kitManifestFor("/events"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe(body);
  });

  it("encodes a Hono-owned fallback response at the dispatch return", async () => {
    // GET / is enabled:false in the shipped manifest, so dispatch answers
    // through honoFetch; the wrap sits on its return so Hono HTML on this
    // worker carries the same wire encoding as decorated pages.
    const res = await dispatchHookRequest(kitEventFor("/", "/[...path]", "gzip"), {
      appUrl: KIT_APP_URL,
      honoFetch: vi.fn(
        async () =>
          new Response("hono", {
            status: 200,
            headers: { "content-type": "text/html", "content-length": "4" },
          }),
      ),
      resolve: vi.fn(async () => new Response("kit")),
    });
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(await gunzip(res)).toBe("hono");
  });
});
