import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  EVENT_MARKDOWN_PATH,
  KIT_EVENT_MARKDOWN_ROUTES,
  legacyEventMarkdownKey,
} from "../src/ai-friendly/kit-event-markdown-routes";
import { dispatchHookRequest, isSameOriginAllowed } from "../src/route-ownership";

const origin = "https://example.com";
const manifest = [{ method: "GET", path: "/events/past", enabled: true, reads: "public" as const }];

function event(raw: string, normalized: string, method = "GET", host = "example.com") {
  const request = new Request(`${origin}${raw}`, { method, headers: { host } });
  return { request, url: new URL(normalized, origin), route: { id: "/events/past" } };
}

async function dispatch(e: ReturnType<typeof event>) {
  const honoFetch = vi.fn(async () => new Response("hono"));
  const resolve = vi.fn(async () => new Response("kit"));
  const response = await dispatchHookRequest(e, { appUrl: origin, manifest, honoFetch, resolve });
  return { response, honoFetch, resolve };
}

describe("Kit event URL boundaries", () => {
  it("uses Kit's normalized data path while preserving the original request", async () => {
    for (const raw of ["/events/past/__data.json", "/events/%70ast/__data.json"]) {
      const e = event(raw, "/events/past");
      const result = await dispatch(e);
      expect(await result.response.text()).toBe("kit");
      expect(result.resolve).toHaveBeenCalledOnce();
      expect(e.request.url).toBe(`${origin}${raw}`);
    }
  });

  it("does not turn a disabled data page into a Kit route", async () => {
    const e = event("/events/past/__data.json", "/events/past");
    const honoFetch = vi.fn(async () => new Response("hono"));
    const resolve = vi.fn(async () => new Response("kit"));
    await dispatchHookRequest(e, {
      appUrl: origin,
      manifest: [{ method: "GET", path: "/events/past", enabled: false }],
      honoFetch,
      resolve,
    });
    expect(honoFetch).toHaveBeenCalledWith(e.request);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not mistake encoded suffixes or normalized trailing slashes for data pages", async () => {
    for (const path of ["/events/past/%5F%5Fdata.json", "/events/past/"]) {
      const e = event(path, path);
      const result = await dispatch(e);
      expect(result.honoFetch).toHaveBeenCalledWith(e.request);
      expect(result.resolve).not.toHaveBeenCalled();
    }
  });

  it("keeps method and host guards before Kit resolution", async () => {
    for (const e of [
      event("/events/past/__data.json", "/events/past", "POST"),
      event("/events/past", "/events/past", "GET", "other.example"),
    ]) {
      const result = await dispatch(e);
      expect(result.honoFetch).toHaveBeenCalledWith(e.request);
      expect(result.resolve).not.toHaveBeenCalled();
    }
  });

  it("lets only the admitted Markdown endpoint shadow the enabled event page", async () => {
    const markdownId = "/e/[key].md";
    for (const [path, id, flag, owner] of [
      ["/e/KEY.md", markdownId, undefined, "hono"],
      ["/e/KEY.md", markdownId, "false", "hono"],
      ["/e/KEY.md", markdownId, "true", "kit"],
      ["/e/KEY%2Emd", markdownId, "true", "hono"],
      ["/e/KEY/extra.md", "/[...path]", "true", "hono"],
      ["/e/.md", "/e/[key]", "true", "kit"],
      ["/e/KEY", "/e/[key]", "true", "kit"],
    ] as const) {
      const e = { ...event(path, path), route: { id } };
      const honoFetch = vi.fn(async () => new Response("hono"));
      const resolve = vi.fn(async () => new Response("kit"));
      const response = await dispatchHookRequest(e, {
        appUrl: origin,
        manifest: [{ method: "GET", path: "/e/:key", enabled: true, reads: "public" }],
        apiFamilies: [{ flag, routes: KIT_EVENT_MARKDOWN_ROUTES }],
        honoFetch,
        resolve,
      });
      expect(await response.text(), path).toBe(owner);
      expect(honoFetch, path).toHaveBeenCalledTimes(owner === "hono" ? 1 : 0);
      expect(resolve, path).toHaveBeenCalledTimes(owner === "kit" ? 1 : 0);
    }
  });

  it("matches Hono's remaining event Markdown spellings and preserves the mounted selector", async () => {
    const hono = new Hono();
    hono.get(EVENT_MARKDOWN_PATH, (c) => c.text(c.req.param("file").slice(0, -3)));
    hono.get("/e/:key", (c) => c.body(null, 404));
    for (const [path, mounted, key] of [
      ["/e/a/b.md", false, "a/b"],
      ["/e//.md", false, "/"],
      ["/e/a%2Fb.md", true, "a/b"],
      ["/e/a%2fb%2Emd", false, "a/b"],
      ["/e/a%252fb%2Emd", false, "a%2fb"],
      ["/%65/KEY.md", false, "KEY"],
      ["/e/KEY%2Emd", false, "KEY"],
      ["/e/%FF/b.md", false, "%FF/b"],
      ["/e/bad%ZZ.md", false, "bad%ZZ"],
      ["/e/a%0A/b.md", false, undefined],
      ["/e/a/b.md%0A", false, undefined],
      ["/e%2Fa/b.md", false, undefined],
      ["/e/a/b.md/", false, undefined],
      ["/e/a/b.md/__data.json", false, undefined],
      ["/e/.md", false, undefined],
      ["/e/KEY/rsvp", false, undefined],
      ["/api/e/a/b.md", false, undefined],
    ] as const) {
      const e = event(`${path}?crawler=%2F`, path);
      const direct = await hono.fetch(e.request);
      expect(direct.status, path).toBe(key === undefined ? 404 : 200);
      if (key !== undefined) expect(await direct.text(), path).toBe(key);

      let decoded: string | null;
      try {
        decoded = path.split("%25").map(decodeURI).join("%25");
      } catch {
        decoded = null;
      }
      expect(legacyEventMarkdownKey(e.request, path, decoded), path).toBe(
        mounted ? undefined : key,
      );
    }
  });

  it("dispatches legacy Markdown reads to the shared handler before catch-all resolution", async () => {
    const nested = "/e/a/b.md?crawler=%2F";
    const alias = "/e/a%2fb%2Emd";
    const cases = [
      [nested, "/[...path]", "GET", "true", "example.com", "legacy"],
      [alias, "/e/[key].md", "HEAD", "true", "example.com", "legacy"],
      ["/e/bad%ZZ.md", null, "GET", "true", "example.com", "legacy"],
      ["/e/a%2Fb.md", "/e/[key].md", "GET", "true", "example.com", "kit"],
      [nested, "/[...path]", "GET", undefined, "example.com", "hono"],
      [nested, "/[...path]", "HEAD", "false", "example.com", "hono"],
      [nested, "/[...path]", "POST", "true", "example.com", "hono"],
      [nested, "/[...path]", "GET", "true", "other.example", "hono"],
      ["/e/a/b.md/__data.json", "/[...path]", "GET", "true", "example.com", "hono"],
      ["/api/e/a/b.md", "/[...path]", "GET", "true", "example.com", "hono"],
    ] as const;
    for (const [path, id, method, flag, host, owner] of cases) {
      const requestEvent = { ...event(path, path, method, host), route: { id } };
      const honoFetch = vi.fn(async () => new Response("hono"));
      const resolve = vi.fn(async () => new Response("kit"));
      const read = vi.fn(async () => new Response("legacy"));
      const response = await dispatchHookRequest(requestEvent, {
        appUrl: origin,
        manifest: [{ method: "GET", path: "/e/:key", enabled: true, reads: "public" }],
        apiFamilies: [
          {
            flag,
            routes: KIT_EVENT_MARKDOWN_ROUTES,
            legacySuffix: { path: EVENT_MARKDOWN_PATH, keyFor: legacyEventMarkdownKey, read },
          },
        ],
        honoFetch,
        resolve,
      });
      expect(await response.text(), path).toBe(owner);
      expect(honoFetch, path).toHaveBeenCalledTimes(owner === "hono" ? 1 : 0);
      expect(resolve, path).toHaveBeenCalledTimes(owner === "kit" ? 1 : 0);
      expect(read, path).toHaveBeenCalledTimes(owner === "legacy" ? 1 : 0);
      if (owner === "legacy") {
        expect(read, path).toHaveBeenCalledWith(
          requestEvent.request,
          path === "/e/bad%ZZ.md" ? "bad%ZZ" : "a/b",
          response.headers.get("x-request-id"),
        );
      }
    }
  });

  it("requires the raw and normalized paths to agree on a machine exemption", () => {
    const request = (path: string, method = "POST") => new Request(`${origin}${path}`, { method });
    expect(
      isSameOriginAllowed(request("/csp-reports"), origin, new URL("/csp-reports", origin)),
    ).toBe(true);
    expect(
      isSameOriginAllowed(request("/%63sp-reports"), origin, new URL("/%63sp-reports", origin)),
    ).toBe(true);
    expect(
      isSameOriginAllowed(
        request("/csp-reports/__data.json"),
        origin,
        new URL("/csp-reports", origin),
      ),
    ).toBe(false);
    expect(isSameOriginAllowed(request("/write"), origin, new URL("/csp-reports", origin))).toBe(
      false,
    );
    expect(isSameOriginAllowed(request("/csp-reports"), origin, new URL("/write", origin))).toBe(
      false,
    );
    expect(
      isSameOriginAllowed(
        request("/csp-reports", "PATCH"),
        origin,
        new URL("/csp-reports", origin),
      ),
    ).toBe(false);
    const alternate = new Request("https://other.example/write", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(isSameOriginAllowed(alternate, origin, new URL("/write", origin))).toBe(false);
  });
});
