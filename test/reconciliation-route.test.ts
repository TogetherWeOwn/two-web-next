import { afterEach, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { readKitReconciliation } from "../src/admin/kit-reconciliation";
import { fixtureManifestFor, ROUTE_MANIFEST } from "../src/route-ownership";

it("adds only two GETs to the explicit loopback fixture, never to the shipped manifest", () => {
  const flag = { includeReconciliation: true };
  const fixture = fixtureManifestFor({ ...flag, APP_URL: "http://127.0.0.1:8788" });
  expect(fixture?.slice(ROUTE_MANIFEST.length).map(({ method, path }) => [method, path])).toEqual([
    ["GET", "/admin/reconciliation"],
    ["GET", "/admin/reconciliation/:key"],
  ]);
  expect(ROUTE_MANIFEST.some(({ path }) => path.startsWith("/admin/reconciliation"))).toBe(false);
  expect(fixtureManifestFor({ ...flag, APP_URL: "https://example.com" })).toBeUndefined();
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
