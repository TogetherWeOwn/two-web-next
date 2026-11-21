import { describe, expect, it, vi } from "vitest";
import { pgReconciliationStore, reconciliationIntent } from "../src/jobs/reconciliation";

const intent = {
  idempotencyKey: "94e5ec13-81e8-4d24-8841-19489bda1b15",
  verb: "event.upsert",
  subject: "event-123",
  attempts: 1,
  lastCode: "needs_reconciliation",
  lastStatus: 409,
};

describe("dormant reconciliation persistence", () => {
  it("keeps only allowed diagnostic codes and scalar context", () => {
    expect(reconciliationIntent({ ...intent, lastCode: "provider secret" })).toEqual({
      ...intent,
      lastCode: "unknown",
    });
    expect(reconciliationIntent(intent)).toEqual(intent);
    for (const valid of [{ subject: "a".repeat(200) }, { lastStatus: 100 }, { lastStatus: 599 }]) {
      expect(reconciliationIntent({ ...intent, ...valid })).toEqual({ ...intent, ...valid });
    }
    for (const invalid of [
      { idempotencyKey: "bad" },
      { idempotencyKey: [intent.idempotencyKey] as unknown as string },
      { subject: ["event-123"] as unknown as string },
      { subject: null as unknown as string },
      { verb: "voice.move_member" },
      { subject: "message body" },
      { subject: "" },
      { subject: "a".repeat(201) },
      { attempts: 0 },
      { attempts: 1.5 },
      { attempts: 2147483648 },
      { lastStatus: 99 },
      { lastStatus: 600 },
    ]) {
      expect(() => reconciliationIntent({ ...intent, ...invalid })).toThrow();
    }
  });

  it("rejects malformed announcement transitions before opening a transaction", async () => {
    const begin = vi.fn();
    const store = pgReconciliationStore({ begin } as never);
    await expect(store.claimAnnouncement("not-a-uuid")).rejects.toThrow("Invalid announcement key");
    for (const [attempts, state] of [
      [0, "closed"],
      [1, "sending"],
    ] as const) {
      await expect(
        store.finishAnnouncement(intent.idempotencyKey, attempts, state as "closed"),
      ).rejects.toThrow("Invalid announcement claim settlement");
    }
    expect(begin).not.toHaveBeenCalled();
  });

  it("propagates persistence failures and refuses absent receipts", async () => {
    const failure = new Error("database unavailable");
    const sql = { begin: vi.fn().mockRejectedValue(failure) };
    const store = pgReconciliationStore(sql as never);
    await expect(store.record(intent)).rejects.toBe(failure);
    await expect(
      store.resolve(intent.idempotencyKey, "123", "confirmed", undefined as never),
    ).rejects.toThrow("receipt is required");
    await expect(
      store.resolve(intent.idempotencyKey, "123", "free text", async () => {}),
    ).rejects.toThrow();
    for (const [key, actor] of [
      [[intent.idempotencyKey], "123"],
      [intent.idempotencyKey, ["123"]],
      [intent.idempotencyKey, 123],
      [intent.idempotencyKey, null],
    ]) {
      await expect(
        store.resolve(key as string, actor as string, "confirmed", async () => {}),
      ).rejects.toThrow("Invalid reconciliation resolution");
    }
    expect(sql.begin).toHaveBeenCalledTimes(1);
  });
});
