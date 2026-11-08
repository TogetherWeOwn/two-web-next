// Boundary contract for protectKitWorkerResponse: the last-resort envelope for
// responses leaving the production Kit worker. A response that already carries
// every securityHeadersFor() header name passes through as the same object;
// anything else (fatal Kit HTML, JSON errors, post-hook rebuilt redirects) gets
// the shared envelope without any change to status, location, body or cookies.
// Synthetic fixtures only; no database, no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KIT_FALLBACK_INLINE_STYLE,
  KIT_FALLBACK_STYLE_SHA256,
  robotsTagFor,
  securityHeadersFor,
  withKitFallbackStyleCsp,
} from "../src/headers";
import { protectKitWorkerResponse } from "../src/kit-worker-response";
import { LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { safeRequestId } from "../src/request-log";

const PROD_URL = "https://togetherweown.com";
const STAGING_URL = "https://next.example.test";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const FALLBACK_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8">' +
  `<style>${KIT_FALLBACK_INLINE_STYLE}</style>` +
  "<main><h1>500: Page unavailable</h1></main></html>";

afterEach(() => {
  vi.restoreAllMocks();
});

const req = (url: string, init: RequestInit = {}): Request => new Request(url, init);

const envelope = (path: string, method = "GET", hosts?: string): Array<[string, string]> =>
  securityHeadersFor({ path, method }, hosts);

const cspOf = (response: Response): string => response.headers.get("content-security-policy")!;

const baseCsp = (path: string, method = "GET", hosts?: string): string =>
  envelope(path, method, hosts).find(([name]) => name === "Content-Security-Policy")![1];

// Every envelope header must match; with `fallback` the CSP must be exactly the
// base policy widened by the fallback style hash instead of the base policy.
const expectEnvelope = (
  response: Response,
  path: string,
  options: { method?: string; hosts?: string; fallback?: boolean } = {},
): void => {
  const { method = "GET", hosts, fallback = false } = options;
  for (const [name, value] of envelope(path, method, hosts)) {
    const expected =
      fallback && name === "Content-Security-Policy" ? withKitFallbackStyleCsp(value) : value;
    expect(response.headers.get(name), name).toBe(expected);
  }
};

const fullEnvelopeResponse = (
  path: string,
  body: BodyInit | null,
  init: ResponseInit = {},
  overrides: Record<string, string> = {},
): Response => {
  const headers = new Headers(init.headers);
  for (const [name, value] of envelope(path)) headers.set(name, value);
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  return new Response(body, { ...init, headers });
};

const plain500 = (): Response =>
  new Response("x", { status: 500, headers: { "content-type": "text/plain" } });

describe("protectKitWorkerResponse passthrough", () => {
  it.each([200, 304, 404, 500])("returns the same object for a complete %i", async (status) => {
    const body = status === 304 ? null : "<p>hello</p>";
    const response = fullEnvelopeResponse(
      "/events",
      body,
      {
        status,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "public, max-age=60",
        },
      },
      { "x-two-renderer": "kit" },
    );
    response.headers.append("set-cookie", "a=1; Path=/; HttpOnly");
    response.headers.append("set-cookie", "b=2; Path=/");
    const before = [...response.headers];

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/events`), response, {
      APP_URL: PROD_URL,
    });

    expect(out).toBe(response);
    expect([...out.headers]).toEqual(before);
    expect(out.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
    expect(out.headers.get("cache-control")).toBe("public, max-age=60");
    expect(out.headers.get("x-request-id")).toBeNull();
    if (status !== 304) expect(await out.text()).toBe("<p>hello</p>");
  });

  it("keeps a custom CSP value untouched on a full envelope", async () => {
    const custom = "default-src 'none'; style-src 'self' 'sha256-custom'";
    const response = fullEnvelopeResponse(
      "/about",
      FALLBACK_HTML,
      { status: 500, headers: { "content-type": "text/html; charset=UTF-8" } },
      { "Content-Security-Policy": custom },
    );

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/about`), response, {
      APP_URL: PROD_URL,
    });

    expect(out).toBe(response);
    expect(cspOf(out)).toBe(custom);
    expect(cspOf(out)).not.toContain(KIT_FALLBACK_STYLE_SHA256);
  });

  it("returns a complete mutable redirect as the same object", async () => {
    const complete = fullEnvelopeResponse("/events", null, {
      status: 302,
      headers: { location: "/events" },
    });

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/x`), complete, {
      APP_URL: PROD_URL,
    });

    expect(out).toBe(complete);
  });

  it("treats an empty security header value as incomplete", async () => {
    const response = fullEnvelopeResponse("/events", "x", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    response.headers.set("X-Frame-Options", "");

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/events`), response, {
      APP_URL: PROD_URL,
    });

    expect(out).not.toBe(response);
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expectEnvelope(out, "/events");
    expect(out.headers.get("x-two-renderer")).toBe("kit");
  });
});

describe("protectKitWorkerResponse missing envelope", () => {
  it("adds the envelope, markers and no-store to an HTML fatal error (GET)", async () => {
    const response = new Response(FALLBACK_HTML, {
      status: 500,
      headers: { "content-type": "text/html" },
    });

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/events`), response, {
      APP_URL: PROD_URL,
    });

    expect(out.status).toBe(500);
    expect(await out.text()).toBe(FALLBACK_HTML);
    expectEnvelope(out, "/events", { fallback: true });
    expect(cspOf(out)).toContain(`'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
    expect(out.headers.get("x-two-renderer")).toBe("kit");
    expect(out.headers.get("x-two-origin")).toBe("two-web-next");
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(out.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(out.headers.get("x-request-id")).toMatch(ULID);
    // Production apex serving the apex: indexable, so no robots tag.
    expect(out.headers.get("x-robots-tag")).toBeNull();
  });

  it("sets noindex for HTML on a non-apex serving host with an apex APP_URL", async () => {
    const response = new Response(FALLBACK_HTML, {
      status: 500,
      headers: { "content-type": "text/html" },
    });

    const out = await protectKitWorkerResponse(
      req("https://preview.workers.dev/events"),
      response,
      { APP_URL: PROD_URL },
    );

    expect(out.headers.get("x-robots-tag")).toBe(robotsTagFor(PROD_URL, "preview.workers.dev"));
    expect(out.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("sets noindex for HTML when APP_URL is a non-apex host", async () => {
    const response = new Response(FALLBACK_HTML, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const out = await protectKitWorkerResponse(req(`${STAGING_URL}/`), response, {
      APP_URL: STAGING_URL,
    });

    expect(out.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(out.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  });

  it("returns a null body for HEAD without inventing one or the fallback hash", async () => {
    const response = new Response(null, { status: 500, headers: { "content-type": "text/html" } });

    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`, { method: "HEAD" }),
      response,
      { APP_URL: PROD_URL },
    );

    expect(out.status).toBe(500);
    expect(out.body).toBeNull();
    expectEnvelope(out, "/events", { method: "HEAD" });
    expect(out.headers.get("x-two-renderer")).toBe("kit");
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(cspOf(out)).not.toContain(KIT_FALLBACK_STYLE_SHA256);
  });

  it("composes the fallback hash with the leaf hash on an inline-critical path", async () => {
    const response = new Response(FALLBACK_HTML, {
      status: 500,
      headers: { "content-type": "text/html" },
    });

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/about`), response, {
      APP_URL: PROD_URL,
    });

    expect(cspOf(out)).toContain(`'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(cspOf(out)).toContain(`'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
    expect(cspOf(out)).toBe(withKitFallbackStyleCsp(baseCsp("/about")));
    expectEnvelope(out, "/about", { fallback: true });
  });

  it("does not widen CSP for arbitrary inline style or a non-error HTML body", async () => {
    const arbitrary = "<!doctype html><style>body{color:red}</style><p>x</p>";
    const err = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response(arbitrary, { status: 500, headers: { "content-type": "text/html" } }),
      { APP_URL: PROD_URL },
    );
    expect(cspOf(err)).toBe(baseCsp("/events"));

    // Status below 400 never earns the allowlist, even with the exact style bytes.
    const ok = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response(FALLBACK_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      { APP_URL: PROD_URL },
    );
    expect(cspOf(ok)).toBe(baseCsp("/events"));

    // The style text outside a <style> element is not the fallback document.
    const textOnly = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response(`<p>${KIT_FALLBACK_INLINE_STYLE}</p>`, {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
      { APP_URL: PROD_URL },
    );
    expect(cspOf(textOnly)).toBe(baseCsp("/events"));
  });

  it("fails closed with a warning when the error body probe is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response(FALLBACK_HTML, {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw new TypeError("body unreadable");
    });

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/events`), response, {
      APP_URL: PROD_URL,
    });

    expect(out.status).toBe(500);
    expect(cspOf(out)).toBe(baseCsp("/events"));
    expectEnvelope(out, "/events");
    expect(await out.text()).toBe(FALLBACK_HTML);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ exception: "TypeError" });
  });

  it("emits configured featured image hosts in img-src", async () => {
    const hosts = "images.example.com, cdn.example.org, rejected.example.test";
    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
      { APP_URL: PROD_URL, FEATURED_IMAGE_HOSTS: hosts },
    );
    expectEnvelope(out, "/events", { hosts });
    expect(cspOf(out)).toContain("https://images.example.com");
    expect(cspOf(out)).toContain("https://cdn.example.org");
    expect(cspOf(out)).not.toContain("https://rejected.example.test");
  });

  it("uses the framed CSP only for GET /join", async () => {
    const get = await protectKitWorkerResponse(req(`${PROD_URL}/join`), plain500(), {
      APP_URL: PROD_URL,
    });
    expectEnvelope(get, "/join");
    expect(cspOf(get)).toContain("frame-src https://discord.com/widget");

    const post = await protectKitWorkerResponse(
      req(`${PROD_URL}/join`, { method: "POST" }),
      plain500(),
      { APP_URL: PROD_URL },
    );
    expectEnvelope(post, "/join", { method: "POST" });
    expect(cspOf(post)).toContain("frame-src 'none'");
  });

  it("completes a partial envelope", async () => {
    const response = new Response("{}", {
      status: 500,
      headers: { "content-type": "application/json", "X-Frame-Options": "DENY" },
    });

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/api/x`), response, {
      APP_URL: PROD_URL,
    });

    expectEnvelope(out, "/api/x");
    expect(out.headers.get("x-two-renderer")).toBe("kit");
  });
});

describe("protectKitWorkerResponse JSON errors", () => {
  it("does not widen CSP, add robots or change the JSON body, status or type", async () => {
    const body = JSON.stringify({ error: "boom", style: KIT_FALLBACK_INLINE_STYLE });

    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
      { APP_URL: STAGING_URL },
    );

    expect(out.status).toBe(500);
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(await out.text()).toBe(body);
    expect(cspOf(out)).toBe(baseCsp("/events"));
    expect(out.headers.get("x-robots-tag")).toBeNull();
    expect(out.headers.get("cache-control")).toBe("no-store");
    expectEnvelope(out, "/events");
  });
});

describe("protectKitWorkerResponse request id", () => {
  it.each(["8a1b2c3d4e5f6071", "8a1b2c3d4e5f6071-SJC"])("admits cf-ray %s", async (ray) => {
    expect(safeRequestId(ray)).toBe(ray);

    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`, { headers: { "cf-ray": ray } }),
      plain500(),
      { APP_URL: PROD_URL },
    );

    expect(out.headers.get("x-request-id")).toBe(ray);
  });

  it("cannot even carry a CRLF cf-ray into a Headers object", () => {
    expect(() => new Headers({ "cf-ray": "8a1b2c3d4e5f6071\r\nx-evil: 1" })).toThrow();
  });

  it.each(["<script>", "abc", "8a1b2c3d4e5f6071-sjc", "8a1b2c3d4e5f6071-SJCX", "x".repeat(300)])(
    "replaces hostile cf-ray %j with a generated id",
    async (ray) => {
      expect(safeRequestId(ray)).toBeUndefined();

      const out = await protectKitWorkerResponse(
        req(`${PROD_URL}/events`, { headers: { "cf-ray": ray } }),
        plain500(),
        { APP_URL: PROD_URL },
      );

      const id = out.headers.get("x-request-id")!;
      expect(id).toMatch(ULID);
      expect(id).not.toBe(ray);
    },
  );

  it("retains a safe x-request-id on the response and replaces an unsafe one", async () => {
    const ray = "8a1b2c3d4e5f6071";
    const kept = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`, { headers: { "cf-ray": ray } }),
      new Response("x", {
        status: 500,
        headers: { "content-type": "text/plain", "x-request-id": "01HZZZZZZZZZZZZZZZZZZZZZZZ" },
      }),
      { APP_URL: PROD_URL },
    );
    expect(kept.headers.get("x-request-id")).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");

    const replaced = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`, { headers: { "cf-ray": ray } }),
      new Response("x", {
        status: 500,
        headers: { "content-type": "text/plain", "x-request-id": "bad id" },
      }),
      { APP_URL: PROD_URL },
    );
    expect(replaced.headers.get("x-request-id")).toBe(ray);
  });

  it("never echoes a client x-request-id, even a valid-looking one", async () => {
    const client = "8a1b2c3d4e5f6071";

    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`, { headers: { "x-request-id": client } }),
      plain500(),
      { APP_URL: PROD_URL },
    );

    const id = out.headers.get("x-request-id")!;
    expect(id).not.toBe(client);
    expect(id).toMatch(ULID);
  });

  it("generates distinct ids per response", async () => {
    const make = () =>
      protectKitWorkerResponse(req(`${PROD_URL}/events`), plain500(), { APP_URL: PROD_URL });

    const [a, b] = await Promise.all([make(), make()]);

    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });
});

describe("protectKitWorkerResponse preservation", () => {
  it("rebuilds an immutable-header redirect keeping status and location", async () => {
    const redirect = Response.redirect(`${PROD_URL}/profile`, 303);
    expect(() => redirect.headers.set("x-probe", "1")).toThrow();

    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/profile`, { method: "POST" }),
      redirect,
      { APP_URL: PROD_URL },
    );

    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`${PROD_URL}/profile`);
    expectEnvelope(out, "/profile", { method: "POST" });
    expect(out.headers.get("x-two-renderer")).toBe("kit");
    expect(out.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps status, location, body and every set-cookie on a rebuilt redirect", async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "/events?x=1#frag" },
    });
    response.headers.append("set-cookie", "sid=abc; Path=/; HttpOnly; Secure");
    response.headers.append("set-cookie", "flash=; Path=/; Max-Age=0");

    const out = await protectKitWorkerResponse(req(`${PROD_URL}/login`), response, {
      APP_URL: PROD_URL,
    });

    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/events?x=1#frag");
    expect(out.headers.getSetCookie()).toEqual([
      "sid=abc; Path=/; HttpOnly; Secure",
      "flash=; Path=/; Max-Age=0",
    ]);
    expect(out.body).toBeNull();
  });

  it("preserves statusText and unrelated headers", async () => {
    const out = await protectKitWorkerResponse(
      req(`${PROD_URL}/events`),
      new Response("x", {
        status: 418,
        statusText: "Teapot",
        headers: { "content-type": "text/plain", "x-custom": "keep", vary: "Cookie" },
      }),
      { APP_URL: PROD_URL },
    );

    expect(out.status).toBe(418);
    expect(out.statusText).toBe("Teapot");
    expect(out.headers.get("x-custom")).toBe("keep");
    expect(out.headers.get("vary")).toContain("Cookie");
    expect(out.headers.get("content-type")).toBe("text/plain");
  });
});
