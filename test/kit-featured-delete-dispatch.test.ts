import { expect, it, vi } from "vitest";
import { STAGING_APP_URL } from "../src/qa";
import { dispatchHookRequest } from "../src/route-ownership";
import { env as baseEnv, MODERATOR } from "./helpers/member-data";

const loopback = "http://127.0.0.1:8787";
const path = "/admin/featured/42/delete";
const actionRoute = "/admin/[...action]";

it.each([
  { name: "unset delete flag" },
  { name: "nonliteral delete flag", flag: "True" },
  { name: "delete flag with Admin off", flag: "true", adminFlag: "false" },
  { name: "exact loopback opt-in", flag: "true", owned: true },
  { name: "staging with both flags on", flag: "true", appUrl: STAGING_APP_URL },
  { name: "production during Admin cutover", flag: "true", appUrl: "https://togetherweown.com" },
  { name: "mismatched Host", flag: "true", host: "foreign.invalid" },
  { name: "wrong HTTP method", flag: "true", method: "DELETE" },
  { name: "wrong Kit route id", flag: "true", routeId: "/[...path]" },
  { name: "encoded action segment", flag: "true", routePath: "/admin/featured/42/%64elete" },
  {
    name: "sibling update with delete off",
    routePath: "/admin/featured/42",
    routeId: "/admin/featured/[id]",
    owned: true,
  },
])("routes featured forms with $name", async (test) => {
  const appUrl = test.appUrl ?? loopback;
  const url = new URL(test.routePath ?? path, appUrl);
  const request = new Request(url, {
    method: test.method ?? "POST",
    headers: { host: test.host ?? url.host, origin: appUrl },
    body: new URLSearchParams(),
  });
  const hono = new Response(null, { status: 418 });
  const honoFetch = vi.fn(async () => hono);
  const sessionFor = vi.fn(async () => ({
    status: "authenticated" as const,
    session: { ...MODERATOR, avatar: null, moderator: false },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  }));
  const resolve = vi.fn(async () => new Response());
  const response = await dispatchHookRequest(
    { request, url, route: { id: test.routeId ?? actionRoute } },
    {
      appUrl,
      kitRouteEmberPages: "true",
      admin: {
        env: {
          ...baseEnv,
          APP_URL: appUrl,
          KIT_ROUTE_ADMIN: test.adminFlag ?? "true",
          KIT_PARITY_FIXTURE_ADMIN_FEATURED_DELETE: test.flag,
        },
        completeForm: () => {
          throw new Error("a non-moderator reached the form");
        },
      },
      honoFetch,
      sessionFor,
      resolve,
    },
  );
  expect(resolve).not.toHaveBeenCalled();
  if (test.owned) {
    expect(response.status).toBe(403);
    expect(response.headers.get("x-two-renderer")).toBe("kit");
    expect(sessionFor).toHaveBeenCalledOnce();
    expect(honoFetch).not.toHaveBeenCalled();
  } else {
    expect(response).toBe(hono);
    expect(honoFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(sessionFor).not.toHaveBeenCalled();
  }
});
