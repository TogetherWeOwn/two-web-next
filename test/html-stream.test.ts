import { describe, expect, it, vi } from "vitest";
import app from "./app";
import { withStreamedBody } from "../src/html-stream";
import {
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  ROUTE_MANIFEST,
  type HookEventLike,
} from "../src/route-ownership";
import type { Env } from "../src/env";

// TWO-7591: HTML responses must leave the Worker as unknown-length streams so
// the edge negotiates br/gzip like it already does for CSS/JSON. A declared
// Content-Length marks the body untransformable (`cache-control:
// no-transform` on the wire), which is exactly the staging Lighthouse defect.
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("withStreamedBody", () => {
  it("streams an HTML body and drops a declared Content-Length", async () => {
    const res = new Response("<!doctype html><p>hi</p>", {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "content-length": "28",
        "cache-control": "public, max-age=3600",
        "x-test-marker": "kept",
      },
    });
    const out = withStreamedBody(res);
    expect(out).not.toBe(res);
    expect(out.status).toBe(200);
    expect(out.headers.get("x-test-marker")).toBe("kept");
    expect(out.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(out.headers.get("content-length")).toBeNull();
    expect(await out.text()).toBe("<!doctype html><p>hi</p>");
  });

  it("returns non-HTML responses unchanged", () => {
    const json = new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    expect(withStreamedBody(json)).toBe(json);
  });

  it("returns already-encoded HTML unchanged (never double-compressed)", () => {
    const encoded = new Response("<p>hi</p>", {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
    });
    expect(withStreamedBody(encoded)).toBe(encoded);
  });

  it("returns bodyless responses unchanged", () => {
    const empty = new Response(null, {
      status: 204,
      headers: { "content-type": "text/html" },
    });
    expect(withStreamedBody(empty)).toBe(empty);
  });

  it("returns an already-consumed HTML response unchanged (locked stream)", async () => {
    const consumed = new Response("<p>read already</p>", {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    await consumed.text();
    expect(withStreamedBody(consumed)).toBe(consumed);
  });
});

describe("HTML wire shape through the app", () => {
  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s answers text/html without a declared Content-Length",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-length")).toBeNull();
      expect((await res.text()).length).toBeGreaterThan(1000);
    },
  );

  it("branded 404s also stream without a declared Content-Length", async () => {
    const res = await app.request("/__missing__", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("JSON routes keep their existing shape", async () => {
    const res = await app.request("/version", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// Kit dispatch path (TWO-7591 review): withStreamedBody runs inside
// decorateKitResponse, so a Kit-rendered HTML response must leave the
// dispatch without a declared Content-Length and a Hono-owned response must
// pass through untouched — deleting the seam must fail this file.
const KIT_APP_URL = "https://next.example.test";

const kitEventFor = (path: string, routeId: string): HookEventLike => {
  const request = new Request(`${KIT_APP_URL}${path}`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: routeId } };
};

const kitManifestFor = (path: string) => {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === path);
  if (!shipped) throw new Error(`shipped GET ${path} manifest entry missing`);
  expect(shipped.enabled).toBe(true);
  return [{ ...shipped }];
};

describe("Kit dispatch HTML wire shape", () => {
  it("streams a decorated Kit HTML response with no declared Content-Length", async () => {
    const body = "<main><h1>Events</h1></main>";
    const res = await dispatchHookRequest(kitEventFor("/events", "/events"), {
      appUrl: KIT_APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=UTF-8",
              "content-length": String(body.length),
            },
          }),
      ),
      manifest: kitManifestFor("/events"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe("kit");
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe(body);
  });

  it("leaves a Hono-owned response's declared Content-Length untouched", async () => {
    // GET / is enabled:false in the shipped manifest, so dispatch answers
    // through honoFetch and never reaches the stream wrap.
    const res = await dispatchHookRequest(kitEventFor("/", "/[...path]"), {
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
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("hono");
  });
});
