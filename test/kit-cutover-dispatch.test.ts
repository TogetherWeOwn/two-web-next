import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  ROUTE_MANIFEST,
  dispatchHookRequest,
  isSameOriginAllowed,
  productionManifestFor,
} from "../src/route-ownership";
import app from "./app";

const APP_URL = "https://togetherweown.com";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const manifest = [
  { method: "GET", path: "/about", enabled: true, reads: "public" as const },
  { method: "GET", path: "/events/past", enabled: true, reads: "public" as const },
];

function dispatchDeps() {
  return {
    appUrl: APP_URL,
    manifest,
    honoFetch: vi.fn(async (request: Request) => app.request(request, undefined, env)),
    resolve: vi.fn(async () => new Response("kit")),
  };
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("production Kit cutover dispatch", () => {
  it.each([
    ["GET", "/members/"],
    ["GET", "/up/"],
    ["POST", "/api/x/"],
    ["GET", "/about/"],
    ["GET", "/events/past/"],
    ["OPTIONS", "/about"],
    ["PUT", "/about"],
    ["PATCH", "/about"],
    ["DELETE", "/about"],
  ])("keeps %s %s on the real Hono branded 404 path", async (method, path) => {
    const request = new Request(new URL(path, APP_URL), {
      method,
      headers: { origin: APP_URL },
    });
    const deps = dispatchDeps();
    const response = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/about" } },
      deps,
    );
    expect(deps.honoFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-two-renderer")).toBeNull();
    expect(await response.text()).toContain("<!doctype html>");
  });

  it("decides ownership from Kit's event URL, not the original data request URL", async () => {
    const request = new Request(`${APP_URL}/about`);
    const deps = dispatchDeps();
    await dispatchHookRequest(
      { request, url: new URL(`${APP_URL}/admin/__data.json`), route: { id: "/admin" } },
      deps,
    );
    expect(deps.honoFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("uses the event URL for exact same-origin exemptions too", () => {
    const request = new Request(`${APP_URL}/api/agent-events`, { method: "POST" });
    expect(isSameOriginAllowed(request, APP_URL)).toBe(true);
    expect(isSameOriginAllowed(request, APP_URL, new URL(`${APP_URL}/about`))).toBe(false);
  });

  it.each(["/admin/__data.json", "/members/person/__data.json"])(
    "keeps unowned data twins on Hono (%s)",
    async (path) => {
      const request = new Request(`${APP_URL}/about`);
      const deps = dispatchDeps();
      // Do not invoke authenticated Hono routes: this test pins ownership only.
      deps.honoFetch = vi.fn(async () => new Response("hono"));
      await dispatchHookRequest(
        { request, url: new URL(path, APP_URL), route: { id: path } },
        deps,
      );
      expect(deps.honoFetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(deps.resolve).not.toHaveBeenCalled();
    },
  );

  it("keeps the canonical data page in Kit when event.url has been stripped by Kit", async () => {
    const request = new Request(`${APP_URL}/about/__data.json`);
    const deps = dispatchDeps();
    await dispatchHookRequest(
      { request, url: new URL(`${APP_URL}/about`), route: { id: "/about" } },
      deps,
    );
    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.honoFetch).not.toHaveBeenCalled();
  });

  it("defaults every production manifest entry to Hono even without rollout vars", async () => {
    for (const entry of ROUTE_MANIFEST) {
      const path = entry.path.replaceAll(/:user|:id|:key/g, "fixture");
      const request = new Request(new URL(path, APP_URL));
      const deps = {
        appUrl: APP_URL,
        honoFetch: vi.fn(async () => new Response("hono")),
        resolve: vi.fn(async () => new Response("kit")),
      };
      await dispatchHookRequest({ request, url: new URL(request.url), route: { id: path } }, deps);
      expect(deps.honoFetch, path).toHaveBeenCalledOnce();
      expect(deps.resolve, path).not.toHaveBeenCalled();
    }
  });

  it.each(["", "/", "/nested", ":8443", "?invalid=true", "#fragment"])(
    "keeps absent or malformed production flags off (%s)",
    (suffix) => {
      const selected = productionManifestFor({ APP_URL: `${APP_URL}${suffix}` });
      expect(selected).toBeDefined();
      expect(selected?.some((entry) => entry.enabled)).toBe(false);
    },
  );

  it("enables only the reviewed cumulative families at the exact production URL", () => {
    const enabledPaths = (appUrl: string, archive: string, staticFlag: string) =>
      productionManifestFor({
        APP_URL: appUrl,
        KIT_ROUTE_ARCHIVE: archive,
        KIT_ROUTE_STATIC: staticFlag,
      })
        ?.filter((entry) => entry.enabled)
        .map((entry) => entry.path);
    expect(enabledPaths(APP_URL, "true", "false")).toEqual(["/events/past"]);
    expect(enabledPaths(APP_URL, "true", "true")).toEqual(["/events/past", "/about", "/faq"]);
    expect(enabledPaths(APP_URL, "false", "true")).toEqual([]);
    expect(enabledPaths(APP_URL, "TRUE", "true")).toEqual([]);
    expect(enabledPaths(`${APP_URL}/`, "true", "true")).toEqual([]);
    expect(productionManifestFor({ APP_URL: "https://preview.example.test" })).toBeUndefined();
  });
});

describe("Kit conditional-response header preservation", () => {
  const headers = {
    etag: '"fixture-etag"',
    "content-security-policy": "default-src 'self'",
    "x-request-id": "fixture-request-id",
    "x-two-origin": "hono",
    "cache-control": "public, max-age=60",
    vary: "Accept",
    "content-type": "text/html; charset=UTF-8",
    "x-custom-contract": "retained",
  };

  it.each([
    ["hono", '"fixture-etag"'],
    ["hono", 'W/"fixture-etag"'],
    ["kit", '"fixture-etag"'],
    ["kit", 'W/"fixture-etag"'],
    ["fallback", 'W/"fixture-etag"'],
    ["untrusted", 'W/"fixture-etag"'],
  ])("keeps every header on the %s branch for %s", async (branch, validator) => {
    const request = new Request(`${APP_URL}/${branch === "hono" ? "unowned" : "about"}`, {
      headers: { "if-none-match": validator, "cf-ray": "0123456789abcdef" },
    });
    const upstream = new Response("body", { headers });
    upstream.headers.append("set-cookie", "first=1; Secure; HttpOnly; Path=/");
    upstream.headers.append("set-cookie", "second=2; Secure; SameSite=Lax; Path=/");
    const deps = {
      ...dispatchDeps(),
      honoFetch: vi.fn(async () => upstream),
      resolve: vi.fn(async () => upstream),
    };
    const url = new URL(request.url);
    if (branch === "untrusted") url.host = "untrusted.example";
    const response = await dispatchHookRequest(
      { request, url, route: { id: branch === "fallback" ? "/[...path]" : "/about" } },
      deps,
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect([...response.headers]).toEqual([...upstream.headers]);
    expect(response.headers.getSetCookie()).toEqual(upstream.headers.getSetCookie());
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-two-origin")).toBe("hono");
    expect(deps.honoFetch.mock.calls.length + deps.resolve.mock.calls.length).toBe(1);
  });

  it.each([
    [200, null, '"fixture-etag"'],
    [200, '"other"', '"fixture-etag"'],
    [200, "*", '"fixture-etag"'],
    [200, '"other", "fixture-etag"', '"fixture-etag"'],
    [200, '"fixture-etag"', null],
    [304, '"fixture-etag"', '"fixture-etag"'],
    [404, '"fixture-etag"', '"fixture-etag"'],
    [201, '"fixture-etag"', '"fixture-etag"'],
  ])("does not rewrite status %s / validator %s / ETag %s", async (status, validator, etag) => {
    const requestHeaders = new Headers();
    if (validator !== null) requestHeaders.set("if-none-match", validator);
    const request = new Request(`${APP_URL}/unowned`, { headers: requestHeaders });
    const responseHeaders = new Headers(headers);
    if (etag === null) responseHeaders.delete("etag");
    const upstream = new Response(status === 304 ? null : "body", {
      status,
      headers: responseHeaders,
    });
    const response = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/[...path]" } },
      { ...dispatchDeps(), honoFetch: async () => upstream },
    );
    expect(response).toBe(upstream);
  });
});

describe("Kit pre-hook configuration", () => {
  it("pins ignore on every endpoint and the root page layout", () => {
    const endpoints = filesUnder("web/src/routes").filter((path) => path.endsWith("/+server.ts"));
    expect(endpoints.length).toBeGreaterThan(0);
    for (const path of [...endpoints, "web/src/routes/+layout.server.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toMatch(/export const trailingSlash = ["']ignore["'];/);
    }
  });

  it("pins remote functions off and the hook-owned CSRF origin check", () => {
    const config = readFileSync("web/vite.config.ts", "utf8");
    expect(config).toContain("experimental: { remoteFunctions: false }");
    expect(config).toContain('csrf: { trustedOrigins: ["*"] }');
    expect(filesUnder("web/src").filter((path) => /\.remote\.[jt]s$/.test(path))).toEqual([]);
  });
});
