// Acceptance: a persistence-carried retry wait that is already due (the
// persisted next-attempt deadline is now or in the past when the consumer
// catches the persistence failure) must never reach the queue transport as
// `delaySeconds: 0` — the retry transport requires a positive integer (see
// src/jobs/retry-delay.ts). The carried wait takes the configured sync-event
// backoff fallback for that carrier attempt, the ledger release stamp stays
// consistent with the delay actually handed to the transport, and a due
// deadline is a delay-shape fix only: it must not become a terminal failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { uniqueKey, type Outcome } from "../src/jobs/sync-event";
import { SyncRetryPersistenceError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

const handlers = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../src/jobs/sync-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/sync-event")>()),
  handleSyncEvent: handlers.sync,
}));

const leaseToken = "11111111-1111-4111-8111-111111111111";
const sync = { kind: "sync-event", eventKey: "event-1", idempotencyKey: "sync-key", leaseToken };
const now = new Date("2030-01-01T00:00:00Z");

function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function dependencies() {
  const ledger: QueueLedger = {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const lock: UniqueLock = {
    acquire: vi.fn(async () => leaseToken),
    release: vi.fn(async () => {}),
  };
  const events = { failSync: vi.fn(async () => {}) } as unknown as EventStore;
  return { bot: {} as BotClient, events, ledger, lock, now: () => now };
}

function persistenceFailure(nextAttemptAt: Date | null) {
  return new SyncRetryPersistenceError(nextAttemptAt, new Error("result write failed"));
}

describe("persistence-carried retry delay (acceptance)", () => {
  beforeEach(() => {
    handlers.sync.mockReset().mockResolvedValue({ done: true } satisfies Outcome);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["the deadline is exactly now", 0, 1],
    ["the deadline is 1ms in the past", -1, 5],
    ["the deadline is 5s in the past", -5_000, 3],
    ["the deadline is an hour in the past", -3_600_000, 2],
  ])(
    "never retries with delaySeconds 0 when %s; the configured backoff fallback applies",
    async (_label, offsetMs, attempts) => {
      handlers.sync.mockRejectedValueOnce(persistenceFailure(new Date(now.getTime() + offsetMs)));
      const m = message({ ...sync, jobId: "job-1" }, attempts);
      const deps = dependencies();

      await consume({ messages: [m] }, deps);

      const fallback = backoffFor(SYNC_EVENT.backoffSeconds, attempts);
      expect(fallback).toBeGreaterThan(0);
      expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: fallback });
      // A due deadline is not a terminal failure: no ack, no failure row,
      // no lock release — the carrier stays on the retry path.
      expect(m.ack).not.toHaveBeenCalled();
      expect(deps.ledger.failed).not.toHaveBeenCalled();
      expect(deps.ledger.dequeued).not.toHaveBeenCalled();
      expect(deps.lock.release).not.toHaveBeenCalled();
      // The ledger availability stamp must agree with the delay actually
      // handed to the transport.
      expect(deps.ledger.reserved).toHaveBeenCalledExactlyOnceWith("job-1");
      expect(deps.ledger.released).toHaveBeenCalledExactlyOnceWith(
        "job-1",
        new Date(now.getTime() + fallback * 1000),
      );
    },
  );

  it("applies the fallback without a ledger row when the carrier has no jobId", async () => {
    handlers.sync.mockRejectedValueOnce(persistenceFailure(new Date(now.getTime() - 1_000)));
    const m = message(sync, 1);
    const deps = dependencies();

    await consume({ messages: [m] }, deps);

    expect(m.retry).toHaveBeenCalledExactlyOnceWith({
      delaySeconds: backoffFor(SYNC_EVENT.backoffSeconds, 1),
    });
    expect(m.ack).not.toHaveBeenCalled();
    for (const operation of Object.values(deps.ledger)) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ["37s remain", 37_000, 37],
    ["a sub-second wait remains and ceils to 1s, not the fallback", 400, 1],
    ["1.5s remain and ceils to 2s", 1_500, 2],
    ["an hour remains", 3_600_000, 3600],
  ])(
    "passes a positive carried wait through unchanged when %s",
    async (_label, offsetMs, delay) => {
      handlers.sync.mockRejectedValueOnce(persistenceFailure(new Date(now.getTime() + offsetMs)));
      const m = message({ ...sync, jobId: "job-1" }, 1);
      const deps = dependencies();

      await consume({ messages: [m] }, deps);

      expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: delay });
      expect(m.ack).not.toHaveBeenCalled();
      expect(deps.ledger.failed).not.toHaveBeenCalled();
      expect(deps.ledger.released).toHaveBeenCalledExactlyOnceWith(
        "job-1",
        new Date(now.getTime() + delay * 1000),
      );
    },
  );

  it("keeps an exhausted carrier terminal even when its deadline is past", async () => {
    handlers.sync.mockRejectedValueOnce(persistenceFailure(new Date(now.getTime() - 5_000)));
    const m = message({ ...sync, jobId: "job-1" }, SYNC_EVENT.tries);
    const deps = dependencies();

    await consume({ messages: [m] }, deps);

    // The fallback must not resurrect a carrier that spent its tries.
    expect(m.retry).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(deps.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      "job-1",
      "sync-event",
      uniqueKey("event-1"),
      expect.any(String),
    );
    expect(deps.ledger.released).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledExactlyOnceWith(uniqueKey("event-1"), leaseToken);
  });

  it("keeps a null deadline terminal: no retry is fabricated for an exhausted request", async () => {
    handlers.sync.mockRejectedValueOnce(persistenceFailure(null));
    const m = message({ ...sync, jobId: "job-1" }, 1);
    const deps = dependencies();

    await consume({ messages: [m] }, deps);

    expect(m.retry).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(deps.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      "job-1",
      "sync-event",
      uniqueKey("event-1"),
      expect.any(String),
    );
    expect(deps.ledger.released).not.toHaveBeenCalled();
  });
});
