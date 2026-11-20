import { afterEach, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { readKitReconciliation } from "../src/admin/kit-reconciliation";
import { dispatchHookRequest, fixtureManifestFor, ROUTE_MANIFEST } from "../src/route-ownership";

it("admits only the two reads and the detail POST in the explicit loopback fixture", () => {
  const flag = { includeReconciliation: true };
  const fixture = fixtureManifestFor({ ...flag, APP_URL: "http://127.0.0.1:8788" });
  expect(fixture?.slice(ROUTE_MANIFEST.length).map(({ method, path }) => [method, path])).toEqual([
    ["GET", "/admin/reconciliation"],
    ["GET", "/admin/reconciliation/:key"],
    ["POST", "/admin/reconciliation/:key"],
  ]);
  expect(ROUTE_MANIFEST.some(({ path }) => path.startsWith("/admin/reconciliation"))).toBe(false);
  expect(fixtureManifestFor({ ...flag, APP_URL: "https://example.com" })).toBeUndefined();
});

it("checks origin before bridging the session or invoking the fixture submit", async () => {
  const appUrl = "http://127.0.0.1:8788";
  const route = { id: "/admin/reconciliation/[key]" };
  const url = new URL("/admin/reconciliation/30000000-0000-0000-0000-000000000001", appUrl);
  const sessionFor = vi.fn();
  const resolve = vi.fn(async () => new Response(null, { status: 303 }));
  const honoFetch = vi.fn(async () => new Response(null, { status: 404 }));
  const deps = { appUrl, fixtureAdminDashboard: true, sessionFor, resolve, honoFetch };
  const request = new Request(url, {
    method: "POST",
    headers: { origin: "https://elsewhere.example" },
    body: "resolution=confirmed",
  });
  expect((await dispatchHookRequest({ request, url, route }, deps)).status).toBe(403);
  expect(request.bodyUsed).toBe(false);
  expect(honoFetch).not.toHaveBeenCalled();
  expect(sessionFor).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();

  const sameOrigin = new Request(url, { method: "POST", headers: { origin: appUrl } });
  expect((await dispatchHookRequest({ request: sameOrigin, url, route }, deps)).status).toBe(303);
  expect(resolve).toHaveBeenCalledOnce();
});

afterEach(() => vi.restoreAllMocks());

it.each(["/admin/reconciliation", "/admin/reconciliation/:key"] as const)(
  "withholds data and emits a sanitized alert after a rejected receipt on %s",
  async (route) => {
    __resetAlertRateLimitForTests();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const receipt = vi.fn().mockRejectedValue(new Error("private fixture subject and query"));
    const result = await readKitReconciliation(receipt, route, undefined);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toMatchObject({ event: "error.alert", method: "GET", route });
    expect(line).not.toMatch(/private fixture|query/);
  },
);
