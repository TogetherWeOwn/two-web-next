import { describe, expect, it, vi } from "vitest";
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
