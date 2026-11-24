import { describe, expect, it, vi } from "vitest";
import { KIT_PROFILE_WRITE_ROUTES } from "../src/profiles/kit-write-route";
import { dispatchHookRequest, type HookEventLike } from "../src/route-ownership";

const APP_URL = "https://fixture.example.test";
const REQUEST_ID = "0123456789abcdef";
const PATH = "/members/111111111111111111";

describe("default-off Kit profile ownership", () => {
  it.each([
    [undefined, "PATCH", PATH, "hono", 200],
    ["false", "POST", PATH, "hono", 200],
    ["TRUE", "PATCH", PATH, "hono", 200],
    ["true", "PATCH", PATH, "kit", 200],
    ["true", "PATCH", "/mem%62ers/111111111111111111", "hono", 200],
    ["true", "POST", PATH, "kit", 200],
    ["true", "PATCH", "/members", "hono", 200],
    ["true", "POST", "/members/", "hono", 200],
    ["true", "PATCH", `${PATH}/`, "hono", 200],
    ["true", "PATCH", "/members/a%2Fb", "hono", 200],
    ["true", "POST", `${PATH}/__data.json`, "hono", 200],
    ["true", "GET", PATH, "hono", 200],
    ["true", "HEAD", "/members/", "hono", 200],
    ["true", "OPTIONS", PATH, "hono", 200],
    ["true", "POST", PATH, "kit", 403, "https://cross-origin.example.test"],
    ["true", "PATCH", PATH, "kit", 403, "https://cross-origin.example.test"],
    ["true", "POST", PATH, "kit", 200, null, "same-origin"],
    ["true", "POST", PATH, "kit", 403, null, "cross-site"],
    ["true", "POST", PATH, "hono", 200, APP_URL, undefined, "/[...path]"],
  ] as const)(
    "%s %s %s routes to %s",
    async (flag, method, path, renderer, status, origin?:
      | string
      | null, site?: string, routeId?: string) => {
      const headers = new Headers({ "cf-ray": REQUEST_ID });
      if (origin !== null) headers.set("origin", origin ?? APP_URL);
      if (site) headers.set("sec-fetch-site", site);
      const request = new Request(APP_URL + path, {
        method,
        headers,
        body: method === "POST" || method === "PATCH" ? "unread" : undefined,
      });
      const event: HookEventLike = {
        request,
        url: new URL(request.url),
        route: { id: routeId ?? "/members/[user]" },
        isDataRequest: path.endsWith("/__data.json"),
        locals: {},
      };
      const honoFetch = vi.fn(async () => new Response());
      const resolve = vi.fn(async () => new Response());
      const sessionFor = vi.fn();
      const result = await dispatchHookRequest(event, {
        appUrl: APP_URL,
        apiFamilies: [{ flag, routes: KIT_PROFILE_WRITE_ROUTES }],
        honoFetch,
        resolve,
        sessionFor,
      });
      expect(result.status).toBe(status);
      expect(result.headers.get("x-two-renderer")).toBe(renderer === "kit" ? "kit" : null);
      expect(honoFetch.mock.calls).toHaveLength(renderer === "hono" ? 1 : 0);
      expect(resolve.mock.calls).toHaveLength(renderer === "kit" && status === 200 ? 1 : 0);
      expect(sessionFor).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
    },
  );
});
