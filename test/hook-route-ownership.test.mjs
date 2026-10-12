import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The hook wiring test targets the framework-free dispatch core in
// src/route-ownership.ts, not web/src/hooks.server.ts: the root Vitest suite
// cannot transform that file (web/tsconfig.json extends the
// SvelteKit-generated $app/tsconfig, so the vite:oxc transform fails under
// coverage). web/src/hooks.server.ts is a pure env binding that delegates to
// dispatchHookRequest, so these cases pin the shipped ordering plus the
// production Kit decoration exactly, and the wiring case pins the delegation.
vi.mock("cloudflare:workers", () => ({
  env: { APP_URL: "https://example.com", FEATURED_IMAGE_HOSTS: "" },
  waitUntil: vi.fn(),
}));

import {
  HONO_FALLBACK_ROUTE_ID,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  decideOwner,
  dispatchHookRequest,
} from "../src/route-ownership";
import { isTrustedHost } from "../src/trust-hosts";

const APP_URL = "https://example.com";

function eventFor(appUrl, path, host) {
  const request = new Request(new URL(path, appUrl).href, {
    headers: { host },
  });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
}

function trustedEvent(path, host = "example.com") {
  return eventFor(APP_URL, path, host);
}

function deps(overrides = {}) {
  return {
    appUrl: APP_URL,
    featuredImageHosts: "",
    isTrustedHost,
    decideOwner,
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    ...overrides,
  };
}

function kitHtmlResponse() {
  return new Response("<html>kit page</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("hooks.server route ownership wiring", () => {
  it("returns honoFetch before resolve for a Hono-owned path, undecorated", async () => {
    const event = trustedEvent("/events/past");
    const d = deps();

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch).toHaveBeenCalledWith(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("decorates a Kit-owned HTML page: marker, security headers, charset, robots tag", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    // Kit sends a bare text/html; the core names the charset like Hono.
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    // example.com is not the production apex, so staging noindex applies.
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("flows featured image hosts into the Kit CSP", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      decideOwner: () => "kit",
      featuredImageHosts: "images.example.com",
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("Content-Security-Policy")).toContain("https://images.example.com");
  });

  it("marks a Kit-owned non-HTML response without charset or robots fixes", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("omits the robots tag for the production apex serving itself", async () => {
    const apex = "https://togetherweown.com";
    const event = eventFor(apex, "/events/past", "togetherweown.com");
    const d = deps({
      appUrl: apex,
      decideOwner: () => "kit",
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("propagates a resolve failure without replaying through Hono", async () => {
    const event = trustedEvent("/events/past");
    const failure = new Error("kit resolve blew up");
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(dispatchHookRequest(event, d)).rejects.toThrow(failure);
    expect(d.honoFetch).not.toHaveBeenCalled();
  });

  it("answers untrusted hosts via Hono before the ownership decision", async () => {
    const event = trustedEvent("/events/past", "evil.example");
    const decide = vi.fn(() => "kit");
    const d = deps({ decideOwner: decide });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });

  it("returns the catch-all fallback without marker, headers, or charset fix", async () => {
    const event = trustedEvent("/api/ping");
    event.route = { id: HONO_FALLBACK_ROUTE_ID };
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("X-Content-Type-Options")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(await response.text()).toBe("<html>kit page</html>");
  });

  it("wires hooks.server.ts as a pure env binding to the canonical deps", async () => {
    const source = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
    // Delegates to the core with the canonical owner, trust check and fetch.
    expect(source).toContain("dispatchHookRequest");
    expect(source).toContain("decideOwner,");
    expect(source).toContain("isTrustedHost,");
    expect(source).toContain("honoFetch,");
    expect(source).toContain("featuredImageHosts: env.FEATURED_IMAGE_HOSTS");
    expect(source).toContain("appUrl: env.APP_URL");
    // Production decoration lives in the core: the hook must not duplicate it
    // and must not hard-code an owner. Each of these mutants stays green
    // without this pin (delete the marker, drop the decoration, force kit).
    expect(source).not.toContain("decorateKitResponse");
    expect(source).not.toContain("KIT_RENDERER");
    expect(source).not.toContain("securityHeadersFor");
    expect(source).not.toContain("robotsTagFor");
    expect(source).not.toContain('() => "kit"');
    expect(source).not.toContain("() => 'kit'");
  });
});

// Reference the module export so unused-import drift fails loudly rather
// than silently dropping the contract pin.
void decideOwner;
