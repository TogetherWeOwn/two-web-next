import { expect, it, vi } from "vitest";
import { LEDGER_DB_TIMEOUT_MS, SYNC_EVENT } from "../src/jobs/constants";
import { reconcileEventSync } from "../src/jobs/event-reconciliation";
import type { SyncAttempt } from "../src/jobs/types";

const claim: SyncAttempt = {
  idempotencyKey: "12345678-1234-4234-8234-123456789abc",
  eventKey: "event-1",
  revision: 1,
  mirroredAt: new Date("2026-01-01"),
  state: "pending",
  requestAttempts: 1,
  nextAttemptAt: null,
  action: "event.cancel",
  payload: { eventKey: "event-1" },
};

function pendingCommit() {
  let complete!: () => void;
  const promise = new Promise<"recorded">((resolve) => {
    complete = () => resolve("recorded");
  });
  return { promise, complete };
}

it("waits for the intent commit and projects only bounded scalar evidence", async () => {
  const commit = pendingCommit();
  const record = vi.fn(() => commit.promise);
  const evidence = {
    code: "synthetic provider body",
    status: 600,
    message: "synthetic provider message",
    requestId: "synthetic provider id",
  };
  const finished = vi.fn();
  const work = reconcileEventSync(claim, 1, record, evidence).then(finished);
  expect(record).toHaveBeenCalledExactlyOnceWith({
    idempotencyKey: claim.idempotencyKey,
    verb: claim.action,
    subject: claim.eventKey,
    attempts: 1,
    lastCode: "unknown",
    lastStatus: null,
  });
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  commit.complete();
  await work;
  expect(finished).toHaveBeenCalledExactlyOnceWith({
    failed: "event sync requires reconciliation; original request retained",
  });
});

it("bounds the wait and leaves late writes to same-key settlement redelivery", async () => {
  vi.useFakeTimers();
  try {
    const commit = pendingCommit();
    const record = vi.fn().mockReturnValueOnce(commit.promise).mockResolvedValueOnce("recorded");
    const result = reconcileEventSync(claim, 1, record);
    await vi.advanceTimersByTimeAsync(LEDGER_DB_TIMEOUT_MS);
    expect(await result).toEqual({ retryInSeconds: 10 });
    commit.complete();
    expect(await reconcileEventSync(claim, 2, record)).toHaveProperty("failed");
    expect(record.mock.calls).toEqual([
      [expect.objectContaining({ idempotencyKey: claim.idempotencyKey, attempts: 1 })],
      record.mock.calls[0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("alerts at the carrier cap when persistence rejects or reports stale ownership", async () => {
  const record = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic driver error"))
    .mockResolvedValueOnce("stale")
    .mockResolvedValueOnce(undefined);
  for (let i = 0; i < 3; i++) {
    expect(await reconcileEventSync(claim, SYNC_EVENT.tries, record)).toEqual({
      retryInSeconds: 3600,
      alert: "event sync reconciliation unconfirmed; original request remains fenced",
    });
  }
});

it("does not fabricate an intent for an unclaimed, retry-eligible, or settled snapshot", async () => {
  const record = vi.fn();
  for (const snapshot of [
    { ...claim, requestAttempts: 0 },
    { ...claim, nextAttemptAt: claim.mirroredAt },
    { ...claim, state: "succeeded" as const },
  ]) {
    expect(await reconcileEventSync(snapshot, 1, record)).toEqual({ retryInSeconds: 10 });
  }
  expect(record).not.toHaveBeenCalled();
});
