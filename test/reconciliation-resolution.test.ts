import { describe, expect, it, vi } from "vitest";
import {
  resolveReconciliation,
  submitReconciliationResolution,
} from "../src/admin/reconciliation-resolution";
import type { TxClient } from "../src/jobs/types";

const key = "94e5ec13-81e8-4d24-8841-19489bda1b15";

describe("reconciliation resolution submission", () => {
  it("rejects invalid input before touching the store", async () => {
    const resolve = vi.fn();
    await expect(
      submitReconciliationResolution({ resolve }, "123", key, "free text"),
    ).resolves.toBe("invalid");
    await expect(
      submitReconciliationResolution({ resolve }, "123", ` ${key}`, "confirmed"),
    ).resolves.toBe("invalid");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("preserves the key and distinguishes an unchanged row from a resolution", async () => {
    const originalKey = key.toUpperCase();
    const resolve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      submitReconciliationResolution({ resolve }, "123", originalKey, "confirmed"),
    ).resolves.toBe("resolved");
    expect(resolve).toHaveBeenCalledWith(originalKey, "123", "confirmed", expect.any(Function));
    await expect(
      submitReconciliationResolution({ resolve }, "123", originalKey, "confirmed"),
    ).resolves.toBe("unchanged");
  });

  it("propagates store failures rather than reporting success", async () => {
    const failure = new Error("receipt unavailable");
    const resolve = vi.fn().mockRejectedValue(failure);
    await expect(submitReconciliationResolution({ resolve }, "123", key, "confirmed")).rejects.toBe(
      failure,
    );
  });
});

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
