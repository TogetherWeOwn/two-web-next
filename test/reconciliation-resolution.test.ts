import { describe, expect, it, vi } from "vitest";
import { resolveReconciliation } from "../src/admin/reconciliation-resolution";
import type { TxClient } from "../src/jobs/types";

const key = "94e5ec13-81e8-4d24-8841-19489bda1b15";

describe("reconciliation resolution receipt", () => {
  it("passes the original key and actor to the atomic store and writes only the category", async () => {
    const tx = vi.fn().mockResolvedValue([]);
    const resolve = vi.fn(
      async (
        _key: string,
        _actor: string,
        _resolution: string,
        receipt: (tx: TxClient) => Promise<void>,
      ) => {
        await receipt(tx as unknown as TxClient);
        return true;
      },
    );

    await expect(resolveReconciliation({ resolve }, key, "123", "not_applied")).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(key, "123", "not_applied", expect.any(Function));
    const values = tx.mock.calls[0]?.slice(1);
    expect(values).toEqual([
      key,
      "123",
      JSON.stringify({ resolution: { before: null, after: "not_applied" } }),
    ]);
  });

  it("preserves an unchanged result and propagates audit failures", async () => {
    const unchanged = vi.fn().mockResolvedValue(false);
    await expect(
      resolveReconciliation({ resolve: unchanged }, key, "123", "confirmed"),
    ).resolves.toBe(false);

    const failure = new Error("audit unavailable");
    const tx = vi.fn().mockRejectedValue(failure);
    const resolve = vi.fn(
      async (
        _key: string,
        _actor: string,
        _resolution: string,
        receipt: (tx: TxClient) => Promise<void>,
      ) => {
        await receipt(tx as unknown as TxClient);
        return true;
      },
    );
    await expect(resolveReconciliation({ resolve }, key, "123", "confirmed")).rejects.toBe(failure);
  });
});
