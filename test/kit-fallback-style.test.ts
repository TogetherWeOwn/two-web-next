// Catastrophic Kit fallback CSP allowlist: the standalone error.html shell
// inlines one <style> block, and the decorated dispatch path must widen
// style-src with exactly that block's hash — for any failing path, without
// changing the documented policy of any other response.
//
// Builder-owned proof for the review finding that the inline style is
// CSP-blocked on decorated catastrophic paths. Independent of the Test
// Author's acceptance suites (test/kit-error-fallback.test.ts,
// e2e/kit-catastrophic-fallback.spec.ts), which this file never imports.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  isKitFallbackDocument,
  KIT_FALLBACK_INLINE_STYLE,
  KIT_FALLBACK_STYLE_SHA256,
  securityHeadersFor,
  withKitFallbackStyleCsp,
} from "../src/headers";
import { LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { dispatchHookRequest, ROUTE_MANIFEST, type HookEventLike } from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const template = readFileSync(new URL("../web/src/error.html", import.meta.url), "utf8");

// SvelteKit's static_error_page substitutes the status token and an
// HTML-escaped message; the style block passes through byte-identical.
const substituteFallback = (status: number, message: string): string => {
  const escaped = message.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
  return template
    .replace(/%sveltekit\.status%/g, () => String(status))
    .replace(/%sveltekit\.error\.message%/g, () => escaped);
};

const cspOf = (headers: Array<[string, string]>): string => {
  const found = headers.find(([name]) => name === "Content-Security-Policy");
  if (!found) throw new Error("CSP header missing");
  return found[1];
};

const eventFor = (path: string, routeId: string): HookEventLike => {
  const request = new Request(`${APP_URL}${path}`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: routeId } };
};

// The override tracks the shipped declaration; only the manifest slice differs.
const manifestFor = (path: string) => {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === path);
  if (!shipped) throw new Error(`shipped GET ${path} manifest entry missing`);
  expect(shipped.enabled).toBe(true);
  expect(shipped.reads).toBe("public");
  return [{ ...shipped }];
};

const HOSTILE_MESSAGE =
  "</h1><script>globalThis.fallbackInjected = true</script>TEST_ONLY_PRIVATE_DETAIL <>&\"'";

describe("catastrophic fallback style allowlist", () => {
  it("pins the constant to the template's single style block and its sha256", () => {
    const blocks = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe(KIT_FALLBACK_INLINE_STYLE);
    expect(createHash("sha256").update(KIT_FALLBACK_INLINE_STYLE, "utf8").digest("base64")).toBe(
      KIT_FALLBACK_STYLE_SHA256,
    );
  });

  it("cannot break out of its style element", () => {
    expect(KIT_FALLBACK_INLINE_STYLE).not.toMatch(/<\/style/i);
  });

  it("detects the substituted fallback even with hostile error text", () => {
    expect(isKitFallbackDocument(substituteFallback(500, HOSTILE_MESSAGE))).toBe(true);
    expect(isKitFallbackDocument(substituteFallback(404, "missing"))).toBe(true);
    expect(isKitFallbackDocument("<main><h1>Normal error shell</h1></main>")).toBe(false);
    expect(isKitFallbackDocument("")).toBe(false);
  });

  it("widens style-src with the hash and stays idempotent", () => {
    const base = cspOf(securityHeadersFor({ path: "/events", method: "GET" }));
    expect(base).toContain("style-src 'self'");
    expect(base).not.toContain(KIT_FALLBACK_STYLE_SHA256);
    const widened = withKitFallbackStyleCsp(base);
    expect(widened).toContain(`style-src 'self' 'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
    expect(withKitFallbackStyleCsp(widened)).toBe(widened);
    expect(withKitFallbackStyleCsp("default-src 'self'")).toBe("default-src 'self'");
  });

  it("composes with the leaf hash on content-leaf paths", () => {
    const base = cspOf(securityHeadersFor({ path: "/about", method: "GET" }));
    expect(base).toContain(`'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    const widened = withKitFallbackStyleCsp(base);
    expect(widened).toContain(`'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(widened).toContain(`'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
  });

  it("widens the decorated fallback response and leaves its body intact", async () => {
    const body = substituteFallback(500, "TEST_ONLY_PRIVATE_DETAIL");
    const res = await dispatchHookRequest(eventFor("/events", "/events"), {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(
        async () =>
          new Response(body, {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
      manifest: manifestFor("/events"),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      `'sha256-${KIT_FALLBACK_STYLE_SHA256}'`,
    );
    expect(await res.text()).toBe(body);
  });

  it("widens a leaf-path fallback with both hashes", async () => {
    const body = substituteFallback(500, "TEST_ONLY_PRIVATE_DETAIL");
    const res = await dispatchHookRequest(eventFor("/about", "/about"), {
      appUrl: APP_URL,
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(
        async () =>
          new Response(body, {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
      manifest: manifestFor("/about"),
    });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(`'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
    expect(csp).toContain(`'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(await res.text()).toBe(body);
  });

  it("leaves every non-fallback response byte-identical", async () => {
    const cases = [
      {
        status: 500,
        contentType: "text/html; charset=utf-8",
        body: "<main><h1>Normal error shell</h1></main>",
      },
      { status: 404, contentType: "text/html", body: "<main>Not found</main>" },
      { status: 200, contentType: "text/html; charset=UTF-8", body: "<main>Events</main>" },
      {
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "x" }),
      },
    ];
    const expected = cspOf(securityHeadersFor({ path: "/events", method: "GET" }));
    for (const { status, contentType, body } of cases) {
      const res = await dispatchHookRequest(eventFor("/events", "/events"), {
        appUrl: APP_URL,
        honoFetch: vi.fn(async () => new Response("hono")),
        resolve: vi.fn(
          async () => new Response(body, { status, headers: { "content-type": contentType } }),
        ),
        manifest: manifestFor("/events"),
      });
      expect(res.headers.get("Content-Security-Policy")).toBe(expected);
      expect(await res.text()).toBe(body);
    }
  });

  it("fails closed to the unwidened policy when the body is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await dispatchHookRequest(eventFor("/events", "/events"), {
        appUrl: APP_URL,
        honoFetch: vi.fn(async () => new Response("hono")),
        resolve: vi.fn(async () => {
          const consumed = new Response(substituteFallback(500, "gone"), {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
          await consumed.text();
          return consumed;
        }),
        manifest: manifestFor("/events"),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("Content-Security-Policy")).not.toContain(KIT_FALLBACK_STYLE_SHA256);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
