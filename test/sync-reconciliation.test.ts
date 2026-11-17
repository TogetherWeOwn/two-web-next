import { describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { handleSyncEvent } from "../src/jobs/sync-event";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const key = "12345678-1234-4234-8234-123456789abc";
const now = new Date("2026-01-01T00:00:00Z");
const failure = (code: string, retryable = true): BotFailure => ({
  ok: false,
  code,
  status: 409,
  requestId: "private",
  message: "private",
  retryable,
  retryAfterSeconds: null,
});

function fixture(action: "event.upsert" | "event.cancel", answer: BotFailure, count = 0) {
  const base = {
    idempotencyKey: key,
    eventKey: "event-1",
    revision: 1,
    mirroredAt: now,
    state: "pending" as const,
    requestAttempts: count,
    nextAttemptAt: now,
  };
  const attempt: SyncAttempt =
    action === "event.cancel"
      ? { ...base, action, payload: { eventKey: "event-1" } }
      : {
          ...base,
          action,
          payload: {
            eventKey: "event-1",
            name: "Night",
            startsAt: now.toISOString(),
            endsAt: null,
            location: "online",
            description: null,
          },
        };
  const bot = {
    upsertEvent: vi.fn(async () => answer),
    cancelEvent: vi.fn(async () => answer),
  } as unknown as BotClient;
  const events = {
    prepareSync: vi.fn(async () => attempt),
    claimSync: vi.fn(async () => ({ ...attempt, requestAttempts: count + 1, nextAttemptAt: null })),
    deferSync: vi.fn(async () => {}),
    completeSync: vi.fn(async () => {}),
    failSync: vi.fn(async () => {}),
  } as unknown as EventStore;
  const ledger = {
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
  } as unknown as QueueLedger;
  const lock = { release: vi.fn(async () => {}) } as unknown as UniqueLock;
  return {
    bot,
    events,
    ledger,
    lock,
    now: () => now,
    reconciliation: { recordSync: vi.fn(async () => {}) },
  };
}

describe.each(["event.upsert", "event.cancel"] as const)("%s reconciliation", (action) => {
  it("hard-stops regardless of retryable and persists scalar context before ack", async () => {
    const deps = fixture(action, failure("needs_reconciliation"));
    const m = {
      body: { kind: "sync-event", eventKey: "event-1", idempotencyKey: key, jobId: "job" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    deps.reconciliation.recordSync.mockImplementation(async () => {
      expect(m.ack).not.toHaveBeenCalled();
    });
    await consume({ messages: [m] }, deps);
    expect(deps.reconciliation.recordSync).toHaveBeenCalledWith({
      idempotencyKey: key,
      verb: action,
      subject: "event-1",
      attempts: 1,
      lastCode: "needs_reconciliation",
      lastStatus: 409,
    });
    expect(
      action === "event.cancel" ? deps.bot.cancelEvent : deps.bot.upsertEvent,
    ).toHaveBeenCalledWith(expect.anything(), key);
    expect(deps.events.failSync).not.toHaveBeenCalled();
    expect(deps.events.deferSync).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("does not acknowledge when recordSyncing fails", async () => {
    const deps = fixture(action, failure("needs_reconciliation", false));
    deps.reconciliation.recordSync.mockRejectedValue(new Error("private"));
    const m = {
      body: { kind: "sync-event", eventKey: "event-1", idempotencyKey: key },
      attempts: 6,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consume({ messages: [m] }, deps);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledOnce();
    expect(deps.events.failSync).not.toHaveBeenCalled();
  });

  it("records ambiguous local completion failure at the request cap", async () => {
    const deps = fixture(action, failure("in_progress"), 5);
    const send = action === "event.cancel" ? deps.bot.cancelEvent : deps.bot.upsertEvent;
    vi.mocked(send).mockResolvedValue({ ok: true, requestId: null, discordEventId: "discord" });
    vi.mocked(deps.events.completeSync).mockRejectedValue(new Error("database failed"));
    const outcome = await handleSyncEvent({ eventKey: "event-1", idempotencyKey: key }, 6, deps);
    expect(outcome).toMatchObject({
      reconciliation: { idempotencyKey: key, attempts: 6, lastCode: null },
    });
    expect(deps.events.failSync).not.toHaveBeenCalled();
  });

  it("retries in progress with the same key and records exhaustion", async () => {
    const retrying = fixture(action, failure("in_progress"));
    expect(
      await handleSyncEvent({ eventKey: "event-1", idempotencyKey: key }, 1, retrying),
    ).toEqual({ retryInSeconds: 10 });
    expect(
      action === "event.cancel" ? retrying.bot.cancelEvent : retrying.bot.upsertEvent,
    ).toHaveBeenCalledWith(expect.anything(), key);
    const exhausted = fixture(action, failure("in_progress"), 5);
    expect(
      await handleSyncEvent({ eventKey: "event-1", idempotencyKey: key }, 6, exhausted),
    ).toEqual({
      reconciliation: {
        idempotencyKey: key,
        verb: action,
        subject: "event-1",
        attempts: 6,
        lastCode: "in_progress",
        lastStatus: 409,
      },
    });
    expect(exhausted.events.deferSync).not.toHaveBeenCalled();
  });
});
