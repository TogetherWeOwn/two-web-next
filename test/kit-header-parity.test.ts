// Kit CSP + full request-header parity.
//
// Security lane: hostile Host/Origin, Sec-Fetch-Site fallback, HEAD,
// CSP shape (no unsafe-inline, /join frame exception only), static + /_app
// admission, staging noindex vs apex indexing. The Hono app stays the source
// of truth: every Kit assertion here mirrors a Hono behavior pinned elsewhere
// (same-origin.test.ts, csp-policy.test.ts, trust-hosts.test.ts,
// security-headers-builder.test.ts).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  dispatchHookRequest,
  resolveRouteOwner,
} from "../src/route-ownership";

const APP_URL = "https://example.com";
const APEX_URL = "https://togetherweown.com";
// Kit-owned view for tests: shipped manifest keeps /events/past on Hono.
const KIT_MANIFEST = [
  { method: "GET", path: "/events/past", enabled: true },
  { method: "POST", path: "/events/past", enabled: true },
];
const KIT_GET_ONLY = [{ method: "GET", path: "/events/past", enabled: true }];

function eventFor(
  appUrl: string,
  path: string,
  host: string,
  init?: RequestInit,
): { request: Request; url: URL; route: { id: string } } {
  const request = new Request(new URL(path, appUrl).href, {
    headers: { host },
    ...init,
  });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
}

function deps(overrides = {}) {
  return {
    appUrl: APP_URL,
    featuredImageHosts: "",
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    ...overrides,
  };
}

function kitHtml() {
  return new Response("<html>kit</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function cspOf(res: Response): Record<string, string> {
  const csp = res.headers.get("content-security-policy");
  expect(csp).not.toBeNull();
  return Object.fromEntries(
    csp!.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

describe("Kit same-origin parity (unsafe methods, exact exemptions only)", () => {
  it("refuses a Kit-owned POST with a foreign Origin before resolve, body unread", async () => {
    const body = JSON.stringify({ title: "x" });
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: {
        host: "example.com",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body,
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    let usedAtRefusal: boolean | null = null;
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => {
        usedAtRefusal = request.bodyUsed;
        return new Response("must not resolve");
      }),
      honoFetch: vi.fn(async () => new Response("must not hono")),
    });
    expect(request.bodyUsed).toBe(false);

    const res = await dispatchHookRequest(event, d);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    // Refusal leaves hardened like Hono's: marker + full security set.
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(usedAtRefusal).toBeNull();
  });

  it("allows a Kit-owned POST with the exact APP_URL Origin", async () => {
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", origin: APP_URL },
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("kit-post", { status: 200 })),
    });
    const res = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(await res.text()).toBe("kit-post");
  });

  it("falls back to Sec-Fetch-Site only when Origin is absent", async () => {
    const sameSite = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", "sec-fetch-site": "same-origin" },
    });
    const sameEvent = {
      request: sameSite,
      url: new URL(sameSite.url),
      route: { id: "/events/past" },
    };
    const dSame = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    });
    await dispatchHookRequest(sameEvent, dSame);
    expect(dSame.resolve).toHaveBeenCalledOnce();

    const crossSite = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", "sec-fetch-site": "cross-site" },
    });
    const crossEvent = {
      request: crossSite,
      url: new URL(crossSite.url),
      route: { id: "/events/past" },
    };
    const dCross = deps({ manifest: KIT_MANIFEST });
    const refused = await dispatchHookRequest(crossEvent, dCross);
    expect(refused.status).toBe(403);
    expect(dCross.resolve).not.toHaveBeenCalled();

    // Explicit Origin always wins, even over a same-origin fetch-metadata hint.
    const spoofed = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: {
        host: "example.com",
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
      },
    });
    const spoofedEvent = {
      request: spoofed,
      url: new URL(spoofed.url),
      route: { id: "/events/past" },
    };
    const dSpoofed = deps({ manifest: KIT_MANIFEST });
    const spoofedRes = await dispatchHookRequest(spoofedEvent, dSpoofed);
    expect(spoofedRes.status).toBe(403);
    expect(dSpoofed.resolve).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin form POST with the hardened envelope, not Kit's bare 403", async () => {
    // Kit's built-in form check is disabled in web/vite.config.ts, so a form
    // POST reaches this gate and leaves hardened like every other refusal.
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: {
        host: "example.com",
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "title=x",
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("must not resolve")),
      honoFetch: vi.fn(async () => new Response("must not hono")),
    });
    expect(request.bodyUsed).toBe(false);

    const res = await dispatchHookRequest(event, d);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("lets a same-origin fetch-metadata form POST through once Kit's pre-check is off", async () => {
    // Under Kit's built-in check this form POST never reached the hook even
    // with a same-origin hint; with the check disabled the hook fallback owns it.
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: {
        host: "example.com",
        "sec-fetch-site": "same-origin",
        "content-type": "multipart/form-data; boundary=abc",
      },
      body: '--abc\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--abc--',
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("kit-form", { status: 200 })),
    });
    const res = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(await res.text()).toBe("kit-form");
  });

  it("fails closed on an invalid APP_URL: trust routes to Hono, same-origin refuses", async () => {
    const { isSameOriginAllowed } = await import("../src/route-ownership");
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", origin: APP_URL },
    });
    // Pure gate fails closed without a parseable expected origin.
    expect(isSameOriginAllowed(request, "not a url")).toBe(false);
    // Dispatch layering: invalid config fails the trust guard first, so the
    // request answers via Hono (production: branded 404, never Kit resolve).
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({ appUrl: "not a url", manifest: KIT_MANIFEST });
    const res = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await res.text()).toBe("hono");
  });

  it("keeps the exact unsafe-method exemptions on the Hono path, independent of Origin", async () => {
    for (const path of ["/api/agent-events", "/csp-reports", "/mcp"]) {
      for (const headers of [{}, { origin: "https://evil.example" }] as HeadersInit[]) {
        const request = new Request(new URL(path, APP_URL).href, {
          method: "POST",
          headers: { host: "example.com", ...headers },
        });
        const event = { request, url: new URL(request.url), route: { id: "/[...path]" } };
        const d = deps({
          honoFetch: vi.fn(async () => new Response("hono-exempt", { status: 200 })),
        });
        const res = await dispatchHookRequest(event, d);
        expect(d.honoFetch).toHaveBeenCalledOnce();
        expect(d.resolve).not.toHaveBeenCalled();
        expect(await res.text()).toBe("hono-exempt");
      }
    }
  });

  it("never lets a manifest entry shadow the CSP sink into Kit", async () => {
    const manifest = [{ method: "POST", path: "/csp-reports", enabled: true }];
    expect(resolveRouteOwner({ method: "POST", path: "/csp-reports" }, manifest)).toBe("hono");
    const request = new Request(new URL("/csp-reports", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", origin: "https://evil.example" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/[...path]" } };
    const d = deps({ manifest });
    await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
  });
});

describe("Kit CSP parity (SSR-only, no unsafe-inline, /join exception only)", () => {
  it("emits script-src 'self' with no unsafe-inline on Kit HTML", async () => {
    const event = eventFor(APP_URL, "/events/past", "example.com");
    const d = deps({
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(async () => kitHtml()),
    });
    const res = await dispatchHookRequest(event, d);
    const csp = cspOf(res);
    expect(csp["script-src"]).toBe("'self'");
    expect(csp["style-src"]).toBe("'self'");
    expect(csp["default-src"]).toBe("'self'");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(csp["frame-src"]).toBe("'none'");
    expect(csp["frame-ancestors"]).toBe("'none'");
    expect(csp["report-to"]).toBe("csp-endpoint");
    expect(res.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="/csp-reports"');
    expect(res.headers.get("Report-To")).toBeNull();
    expect(csp["report-uri"]).toBeUndefined();
  });

  it("pins the /join frame exception to GET/HEAD only (POST stays 'none')", async () => {
    const { securityHeadersFor } = await import("../src/headers");
    const getJoin = new Map(securityHeadersFor({ path: "/join", method: "GET" })).get(
      "Content-Security-Policy",
    )!;
    const headJoin = new Map(securityHeadersFor({ path: "/join", method: "HEAD" })).get(
      "Content-Security-Policy",
    )!;
    const postJoin = new Map(securityHeadersFor({ path: "/join", method: "POST" })).get(
      "Content-Security-Policy",
    )!;
    expect(getJoin).toContain("frame-src https://discord.com/widget");
    expect(headJoin).toContain("frame-src https://discord.com/widget");
    expect(postJoin).toContain("frame-src 'none'");
  });

  it("carries the CSP on Kit redirects and error pages, with marker", async () => {
    const redirectEvent = eventFor(APP_URL, "/events/past", "example.com");
    const dRedirect = deps({
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(
        async () => new Response(null, { status: 303, headers: { location: "/events" } }),
      ),
    });
    const redirect = await dispatchHookRequest(redirectEvent, dRedirect);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(redirect.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);

    const errorEvent = eventFor(APP_URL, "/events/past", "example.com");
    const dError = deps({
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(
        async () =>
          new Response("<html>oops</html>", {
            status: 500,
            headers: { "content-type": "text/html" },
          }),
      ),
    });
    const errorRes = await dispatchHookRequest(errorEvent, dError);
    expect(errorRes.status).toBe(500);
    expect(errorRes.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(errorRes.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    expect(errorRes.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("keeps HEAD header-identical to GET on the Kit branch", async () => {
    const getEvent = eventFor(APP_URL, "/events/past", "example.com");
    const dGet = deps({ manifest: KIT_GET_ONLY, resolve: vi.fn(async () => kitHtml()) });
    const getRes = await dispatchHookRequest(getEvent, dGet);

    const headRequest = new Request(new URL("/events/past", APP_URL).href, {
      method: "HEAD",
      headers: { host: "example.com" },
    });
    const headEvent = {
      request: headRequest,
      url: new URL(headRequest.url),
      route: { id: "/events/past" },
    };
    const dHead = deps({
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const headRes = await dispatchHookRequest(headEvent, dHead);
    expect(dHead.resolve).toHaveBeenCalledOnce();
    for (const name of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      KIT_RENDERER_HEADER,
    ]) {
      expect(headRes.headers.get(name), name).toBe(getRes.headers.get(name));
    }
  });
});

describe("Kit robots + asset admission parity", () => {
  it("noindexes staging HTML but omits the tag for the apex serving itself", async () => {
    const staging = eventFor(APP_URL, "/events/past", "example.com");
    const dStaging = deps({
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(async () => kitHtml()),
    });
    expect((await dispatchHookRequest(staging, dStaging)).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow",
    );

    const apexEvent = eventFor(APEX_URL, "/events/past", "togetherweown.com");
    const dApex = deps({
      appUrl: APEX_URL,
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(async () => kitHtml()),
    });
    expect((await dispatchHookRequest(apexEvent, dApex)).headers.get("X-Robots-Tag")).toBeNull();
  });

  it("noindexes an apex-configured build served from a preview host", async () => {
    const previewRequest = new Request("https://preview.workers.dev/events/past", {
      headers: { host: "togetherweown.com" },
    });
    // URL host is the serving host: preview alias serving apex config stays noindex.
    const event = {
      request: previewRequest,
      url: new URL(previewRequest.url),
      route: { id: "/events/past" },
    };
    const d = deps({
      appUrl: APEX_URL,
      manifest: KIT_GET_ONLY,
      resolve: vi.fn(async () => kitHtml()),
    });
    // Trusted Host header but untrusted URL host routes to Hono first.
    const res = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await res.text()).toBe("hono");
  });

  it("reserves /_app/* to Hono so adapter assets never gain a Kit marker", () => {
    for (const path of ["/_app/immutable/chunks/abc.js", "/_app/version.json"]) {
      expect(resolveRouteOwner({ method: "GET", path }, KIT_GET_ONLY)).toBe("hono");
      expect(resolveRouteOwner({ method: "GET", path }, KIT_MANIFEST)).toBe("hono");
    }
    // The reservation beats the manifest: even entries that explicitly claim
    // an /_app route (exact plus :param patterns) still resolve to Hono.
    const claiming = [
      { method: "GET", path: "/_app/immutable/chunks/abc.js", enabled: true },
      { method: "GET", path: "/_app/:file", enabled: true },
      { method: "GET", path: "/:a/:b/:c/:d", enabled: true },
    ];
    for (const path of ["/_app/immutable/chunks/abc.js", "/_app/version.json", "/_app/"]) {
      expect(resolveRouteOwner({ method: "GET", path }, claiming)).toBe("hono");
    }
  });

  it("pins web/_headers /_app/* to securityHeadersFor so the adapter boundary cannot drift", async () => {
    const { securityHeadersFor } = await import("../src/headers");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const raw = readFileSync(resolve(root, "web/_headers"), "utf8");
    const lines = raw.split("\n");
    const start = lines.findIndex((line) => line.trim() === "/_app/*");
    expect(start).toBeGreaterThan(-1);
    const fileHeaders = new Map<string, string>();
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s{2}(\S[^:]*):\s*(.*\S)\s*$/);
      expect(match, `parseable header line: ${line}`).not.toBeNull();
      fileHeaders.set(match![1]!, match![2]!);
    }
    const expected = new Map(securityHeadersFor({ path: "/_app/x.js", method: "GET" }, ""));
    for (const [name, value] of expected) {
      expect(fileHeaders.get(name), name).toBe(value);
    }
    // X-Robots-Tag is static-only (robotsTagFor covers HTML); the file pins it
    // while the builder does not emit it. Nothing else may sneak in.
    expect(fileHeaders.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(fileHeaders.size).toBe(expected.size + 1);
  });

  it("disables Kit's pre-hook form check so the hardened gate owns every refusal", () => {
    // Pinned as text: the root suite cannot import the Vite config through the
    // Kit plugin. If this option is removed, Kit answers cross-origin form
    // POSTs with its bare 403 before the hook runs (see the form refusal test
    // above, which would still pass while production regresses).
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const config = readFileSync(resolve(root, "web/vite.config.ts"), "utf8");
    expect(config).toMatch(/trustedOrigins:\s*\[\s*['"]\*['"]\s*\]/);
  });

  it("starts SSR-only: the archive page disables CSR and uses an external island", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const server = readFileSync(
      resolve(root, "web/src/routes/events/past/+page.server.ts"),
      "utf8",
    );
    expect(server).toContain("csr = false");
    const page = readFileSync(resolve(root, "web/src/routes/events/past/+page.svelte"), "utf8");
    // External island script, never an inline bootstrap.
    expect(page).toContain('src="/islands/past-events.js"');
    expect(page).not.toContain("unsafe-inline");
  });
});
