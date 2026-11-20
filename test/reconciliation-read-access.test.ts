import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  auditedReconciliationReads,
  reconciliationReadReceipt,
} from "../src/admin/reconciliation-read-access";
import type { pgReconciliationReads } from "../src/admin/reconciliation-reads";

const key = "94e5ec13-81e8-4d24-8841-19489bda1b15";

function fixture() {
  const row = { idempotencyKey: key };
  const reads = {
    listOpen: vi.fn().mockResolvedValue([row]),
    listResolved: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(row),
  };
  const receipt = vi.fn().mockResolvedValue(undefined);
  return {
    row,
    reads,
    receipt,
    audited: auditedReconciliationReads(
      reads as ReturnType<typeof pgReconciliationReads>,
      receipt,
      "123",
    ),
  };
}

describe("reconciliation read receipt", () => {
  it("writes a bounded operational receipt without row data", async () => {
    const tx = vi.fn().mockResolvedValue([]);
    const sql = { begin: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)) };
    const record = reconciliationReadReceipt(sql as unknown as ReturnType<typeof postgres>);
    await record("123", "view", key);
    expect(tx).toHaveBeenCalledTimes(2);
    expect(tx.mock.calls[0]?.[0].join(" ")).toContain("statement_timeout");
    expect(tx.mock.calls[1]?.[0].join(" ")).toContain("insert into activity_log");
    expect(tx.mock.calls[1]?.slice(1)).toEqual([key, "123", "view"]);
  });

  it("propagates a failed receipt", async () => {
    const failure = new Error("audit unavailable");
    const sql = { begin: vi.fn().mockRejectedValue(failure) };
    const record = reconciliationReadReceipt(sql as unknown as ReturnType<typeof postgres>);
    await expect(record("123", "list_open", null)).rejects.toBe(failure);
  });
});

describe("reconciliation read access", () => {
  it("records each list and view before returning results", async () => {
    const { row, receipt, audited } = fixture();
    await expect(audited.listOpen()).resolves.toEqual([row]);
    await expect(audited.listResolved()).resolves.toEqual([]);
    await expect(audited.get(key)).resolves.toEqual(row);
    expect(receipt.mock.calls).toEqual([
      ["123", "list_open", null],
      ["123", "list_resolved", null],
      ["123", "view", key],
    ]);
  });

  it("keeps data pending until the receipt commits", async () => {
    const { receipt, audited } = fixture();
    let commit!: () => void;
    receipt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    let released = false;
    const result = audited.listOpen().then((rows) => {
      released = true;
      return rows;
    });
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce());
    expect(released).toBe(false);
    commit();
    await expect(result).resolves.toHaveLength(1);
    expect(released).toBe(true);
  });

  it("does not release a read when its receipt fails", async () => {
    const { receipt, audited } = fixture();
    const failure = new Error("audit unavailable");
    receipt.mockRejectedValue(failure);
    await expect(audited.listOpen()).rejects.toBe(failure);
    await expect(audited.listResolved()).rejects.toBe(failure);
    await expect(audited.get(key)).rejects.toBe(failure);
  });

  it("records the returned original key rather than the requested spelling", async () => {
    const { receipt, audited } = fixture();
    await audited.get(key.toUpperCase());
    expect(receipt).toHaveBeenCalledWith("123", "view", key);
  });

  it("does not put an untrusted missing key in the receipt", async () => {
    const { reads, receipt, audited } = fixture();
    reads.get.mockResolvedValue(null);
    await expect(audited.get("untrusted input")).resolves.toBeNull();
    expect(receipt).toHaveBeenCalledWith("123", "view", null);
  });

  it("propagates read failure without writing a successful receipt", async () => {
    const { reads, receipt, audited } = fixture();
    const failure = new Error("read unavailable");
    reads.listOpen.mockRejectedValue(failure);
    await expect(audited.listOpen()).rejects.toBe(failure);
    expect(receipt).not.toHaveBeenCalled();
  });
});
