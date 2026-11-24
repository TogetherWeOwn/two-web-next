import { expect, it, vi } from "vitest";
import { fetchOpsOverrides } from "../src/admin/ops-overrides-fetch";
import { STAGING_APP_URL } from "../src/qa";
import { dispatchHookRequest, type HookEventLike } from "../src/route-ownership";
import { env as baseEnv } from "./helpers/member-data";

const loopback = "http://127.0.0.1:8787";
const operator = "/admin/ops-overrides";
const formPath = "/admin/events";

function dispatch(
  request: Request,
  {
    appUrl = loopback,
    flag = "true",
    url = new URL(request.url),
    id = url.pathname,
    isDataRequest = false,
    status = "guest",
  }: {
    appUrl?: string;
    flag?: string;
    url?: URL;
    id?: string;
    isDataRequest?: boolean;
    status?: "guest" | "unknown";
  } = {},
) {
  const honoFetch = vi.fn(async () => new Response("Hono"));
  const env = { ...baseEnv, APP_URL: appUrl, KIT_ROUTE_ADMIN: flag };
  const resolve = vi.fn(
    async (event: HookEventLike) =>
      (await fetchOpsOverrides(event.request, env)) ?? new Response("Kit page"),
  );
  const sessionFor = vi.fn(async () => ({
    status,
    session: null,
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  }));
  const response = dispatchHookRequest(
    { request, url, route: { id }, isDataRequest },
    {
      appUrl,
      adminEnv: env,
      honoFetch,
      resolve,
      sessionFor,
    },
  );
  return { response, honoFetch, resolve, sessionFor };
}

it.each([
  ["https://togetherweown.com", "true", operator, false],
  ["https://other.example", "true", operator, false],
  [loopback, "false", operator, false],
  [loopback, "True", operator, false],
  [loopback, "true", "/admin/ops-overrides/", false],
  [loopback, "true", "/admin/%6fps-overrides", false],
  [loopback, "true", "/admin/ops-overrides/__data.json", true],
  [loopback, "true", "/admin/queue/source-evidence/1", false],
  [loopback, "true", "/admin/no-such-page", false],
])(
  "leaves rejected admin admissions with Hono for %s %s %s",
  async (appUrl, flag, path, isDataRequest) => {
    const request = new Request(new URL(path, appUrl));
    const result = dispatch(request, { appUrl, flag, isDataRequest });
    expect(await (await result.response).text()).toBe("Hono");
    expect(result.honoFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(result.sessionFor).not.toHaveBeenCalled();
    expect(result.resolve).not.toHaveBeenCalled();
  },
);

it("handles the exact operator method without reading or renewing a cookie session", async () => {
  const request = new Request(new URL(operator, STAGING_APP_URL), { method: "OPTIONS" });
  const result = dispatch(request, { appUrl: STAGING_APP_URL });
  const response = await result.response;
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, HEAD");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(result.sessionFor).not.toHaveBeenCalled();
  expect(result.honoFetch).not.toHaveBeenCalled();
  expect(result.resolve).toHaveBeenCalledTimes(1);
});

it("runs the origin check then the moderator gate before resolving native form actions", async () => {
  for (const [origin, status, expected, sessionReads] of [
    ["https://other.example", "guest", 403, 0],
    [loopback, "guest", 303, 1],
    [loopback, "unknown", 503, 1],
  ] as const) {
    const request = new Request(new URL(formPath, loopback), {
      method: "POST",
      headers: { origin, accept: "text/html" },
      body: new URLSearchParams({ title: "Fixture draft" }),
    });
    const result = dispatch(request, { status });
    const response = await result.response;
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
    expect(result.sessionFor).toHaveBeenCalledTimes(sessionReads);
    expect(result.resolve).not.toHaveBeenCalled();
    expect(result.honoFetch).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  }
});
