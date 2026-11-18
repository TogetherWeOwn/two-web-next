import { afterEach, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { readKitReconciliation } from "../src/admin/kit-reconciliation";

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
