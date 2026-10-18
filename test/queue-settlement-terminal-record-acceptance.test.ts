// Acceptance: a definitive sync failure must leave an operator-visible
// terminal record even when settling the attempt (`failSync`) itself throws.
//
// Settlement is correctness-critical: while `failSync` has not recorded the
// failed attempt, the delivery must retry and never ack (an acked message
// whose attempt never settled would strand the revision). But that retry
// must not be silent: the same delivery still owes exactly one
// `queue.failing` alert and one failed-jobs stamp (`ledger.failed`), matching
// what a settled definitive failure produces. Production redeliveries do not
// re-attempt settlement for this attempt: claiming nulls the row's
// `nextAttemptAt` and a throwing `failSync` never restores it, so each
// redelivery waits until the carrier exhausts its tries, which acks exactly
// once with the jobId fence keeping the first (definitive) failed row.
//
// Hermetic consumer fixtures only: no database, no live queue.
import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { BotTerminalError } from "../src/jobs/types";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const NOW = new Date("2026-10-18T00:00:00Z");
const LEASE = "5e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const JOB = "job-terminal-record-1";

type FailedRow = { jobId: unknown; kind: unknown; key: unknown; reason: unknown };

function attemptFor(
  action: "event.upsert" | "event.cancel",
  overrides: Partial<SyncAttempt> = {},
): SyncAttempt {
  const base = {
    idempotencyKey: UUID,
    eventKey: "e1",
    revision: 1,
    mirroredAt: NOW,
    state: "pending" as const,
    requestAttempts: 0,
    nextAttemptAt: NOW,
  };
  const attempt =
    action === "event.cancel"
      ? { ...base, action, payload: { eventKey: "e1" } }
      : {
          ...base,
          action,
          payload: {
            eventKey: "e1",
            name: "Fixture",
            startsAt: "2026-10-19T12:00:00Z",
            endsAt: "2026-10-19T13:00:00Z",
            location: "Discord",
            description: null,
          },
        };
  return { ...attempt, ...overrides } as SyncAttempt;
}

// A ledger double that models the durable jobId fence the Postgres ledger
// enforces: repeated `failed` stamps for one jobId keep a single row (the
// first one). Call counts stay observable via the mock itself.
function fencedLedger() {
  const rows = new Map<unknown, FailedRow>();
  const ledger = {
    enqueued: vi.fn<QueueLedger["enqueued"]>().mockResolvedValue(undefined),
    reserved: vi.fn<QueueLedger["reserved"]>().mockResolvedValue(undefined),
    released: vi.fn<QueueLedger["released"]>().mockResolvedValue(undefined),
    dequeued: vi.fn<QueueLedger["dequeued"]>().mockResolvedValue(undefined),
    failed: vi.fn<QueueLedger["failed"]>().mockImplementation(async (jobId, kind, key, reason) => {
      if (!rows.has(jobId)) rows.set(jobId, { jobId, kind, key, reason });
    }),
  };
  return { ledger, rows };
}

function fixture(
  action: "event.upsert" | "event.cancel" = "event.upsert",
  failSync: EventStore["failSync"] = async () => {},
) {
  const attempt = attemptFor(action);
  const events = {
    // A fresh snapshot per delivery, like re-reading the attempt row: claiming
    // mutates the snapshot, and a redelivery must not inherit that mutation.
    prepareSync: vi
      .fn<EventStore["prepareSync"]>()
      .mockImplementation(async () => attemptFor(action)),
    claimSync: vi.fn<EventStore["claimSync"]>().mockImplementation(async (a) => {
      a.requestAttempts++;
      a.nextAttemptAt = null;
      return a;
    }),
    completeSync: vi.fn<EventStore["completeSync"]>().mockResolvedValue(undefined),
    deferSync: vi.fn<EventStore["deferSync"]>().mockResolvedValue(undefined),
    failSync: vi.fn<EventStore["failSync"]>(failSync),
    needsSync: vi.fn<EventStore["needsSync"]>().mockResolvedValue(false),
    pendingSync: vi.fn<EventStore["pendingSync"]>().mockResolvedValue(null),
    closeFinished: vi.fn<EventStore["closeFinished"]>().mockResolvedValue(0),
    materializeSeries: vi.fn<EventStore["materializeSeries"]>().mockResolvedValue(0),
    staleEventKeys: vi.fn<EventStore["staleEventKeys"]>().mockResolvedValue([]),
  };
  const { ledger, rows } = fencedLedger();
  const lock = {
    acquire: vi.fn<UniqueLock["acquire"]>().mockResolvedValue(LEASE),
    release: vi.fn<UniqueLock["release"]>().mockResolvedValue(undefined),
  };
  return { attempt, events, ledger, rows, lock, now: () => NOW };
}

function terminalBot(): BotClient {
  const fail = vi.fn(async () => {
    throw new BotTerminalError("synthetic definitive refusal");
  });
  return { upsertEvent: fail, cancelEvent: fail } as unknown as BotClient;
}

function carrier(attempts = 1, body: Record<string, unknown> = {}) {
  return {
    body: {
      kind: "sync-event",
      eventKey: "e1",
      idempotencyKey: UUID,
      jobId: JOB,
      leaseToken: LEASE,
      ...body,
    },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function capture() {
  const calls: { channel: string; args: unknown[] }[] = [];
  for (const channel of ["error", "warn", "info"] as const)
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      calls.push({ channel, args });
    });
  return calls;
}

function failingAlerts(calls: { channel: string; args: unknown[] }[]) {
  return calls
    .filter(
      (c) =>
        c.channel === "error" &&
        typeof c.args[0] === "string" &&
        c.args[0].includes('"event":"queue.failing"'),
    )
    .map((c) => JSON.parse(c.args[0] as string) as Record<string, unknown>);
}

afterEach(() => vi.restoreAllMocks());

describe("definitive failure with a throwing failSync", () => {
  it.each(["event.upsert", "event.cancel"] as const)(
    "%s stamps one failed row and alerts once instead of retrying silently",
    async (action) => {
      const calls = capture();
      const d = fixture(action, async () => {
        throw new Error("settlement store down");
      });
      const m = carrier(1);

      await consume({ messages: [m] }, { ...d, bot: terminalBot() });

      // The attempt settlement was tried exactly once, and its failure still
      // blocks the ack: redelivery must be able to finish settling.
      expect(d.events.failSync).toHaveBeenCalledExactlyOnceWith(UUID);
      expect(m.retry).toHaveBeenCalledOnce();
      expect(m.ack).not.toHaveBeenCalled();
      expect(d.events.completeSync).not.toHaveBeenCalled();

      // The terminal record a settled definitive failure would leave: one
      // failed stamp for this job and one queue.failing alert.
      expect(d.ledger.failed).toHaveBeenCalledExactlyOnceWith(
        JOB,
        "sync-event",
        "sync-event:e1",
        "BotTerminalError",
      );
      expect([...d.rows.values()]).toEqual([
        { jobId: JOB, kind: "sync-event", key: "sync-event:e1", reason: "BotTerminalError" },
      ]);
      const alerts = failingAlerts(calls);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        event: "queue.failing",
        queue: "two-sync-event",
        job: "SyncEventToDiscord",
        attempts: 1,
        exception: "BotTerminalError",
      });
    },
  );

  it("a non-Error failSync rejection still stamps and alerts once", async () => {
    const calls = capture();
    const d = fixture("event.upsert", async () => {
      throw "settlement store down";
    });
    const m = carrier(1);

    await consume({ messages: [m] }, { ...d, bot: terminalBot() });

    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(d.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB,
      "sync-event",
      "sync-event:e1",
      "BotTerminalError",
    );
    expect(d.rows.size).toBe(1);
    expect(failingAlerts(calls)).toHaveLength(1);
  });

  it("redeliveries wait on the claimed row and carrier exhaustion acks once with a single failed row", async () => {
    const calls = capture();
    const d = fixture("event.upsert", async () => {
      throw new Error("settlement store down");
    });
    // Production shape after the first delivery: claiming nulls the cached
    // row's nextAttemptAt and the throwing failSync never restores it, so
    // every redelivery re-reads that same pending, not-yet-due row and waits.
    // Settlement is not re-attempted; the carrier exhausts instead.
    let deliveries = 0;
    d.events.prepareSync
      .mockReset()
      .mockImplementation(async () =>
        ++deliveries === 1
          ? attemptFor("event.upsert")
          : attemptFor("event.upsert", { requestAttempts: 1, nextAttemptAt: null }),
      );
    const bot = terminalBot();
    const first = carrier(1);
    const waitingCarriers = [carrier(2), carrier(3), carrier(4), carrier(5)];
    const last = carrier(6);
    const carriers = [first, ...waitingCarriers, last];

    await consume({ messages: [first] }, { ...d, bot });

    // The terminal record exists from the first delivery onward.
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(d.events.failSync).toHaveBeenCalledExactlyOnceWith(UUID);
    expect([...d.rows.values()]).toEqual([
      { jobId: JOB, kind: "sync-event", key: "sync-event:e1", reason: "BotTerminalError" },
    ]);

    // Waiting redeliveries retry quietly: no settlement re-attempt, no second
    // stamp, no second alert, no ack.
    for (const waiting of waitingCarriers) {
      await consume({ messages: [waiting] }, { ...d, bot });
      expect(waiting.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 300 });
      expect(waiting.ack).not.toHaveBeenCalled();
    }
    expect(d.events.failSync).toHaveBeenCalledTimes(1);
    expect(d.ledger.failed).toHaveBeenCalledTimes(1);
    expect(failingAlerts(calls)).toHaveLength(1);

    // Carrier exhaustion (attempt 6 of 6) is the terminal exit: acked exactly
    // once across all deliveries, settlement still attempted only once, and
    // the fence keeps the first delivery's definitive row.
    await consume({ messages: [last] }, { ...d, bot });

    expect(last.ack).toHaveBeenCalledOnce();
    expect(last.retry).not.toHaveBeenCalled();
    expect(carriers.reduce((n, m) => n + m.ack.mock.calls.length, 0)).toBe(1);
    expect(d.events.failSync).toHaveBeenCalledTimes(1);
    expect(d.ledger.failed).toHaveBeenCalledTimes(2);
    expect(d.ledger.failed).toHaveBeenCalledWith(
      JOB,
      "sync-event",
      "sync-event:e1",
      "waiting carrier exhausted; request remains recoverable",
    );
    expect(d.rows.size).toBe(1);
    expect([...d.rows.values()]).toEqual([
      { jobId: JOB, kind: "sync-event", key: "sync-event:e1", reason: "BotTerminalError" },
    ]);
    expect(d.lock.release).toHaveBeenCalledExactlyOnceWith("sync-event:e1", LEASE);
    expect(failingAlerts(calls)).toHaveLength(2);
  });

  it("a batch sibling settles normally while the throwing delivery still records its failure", async () => {
    const calls = capture();
    const UUID2 = "2e9d2f1a-2b3c-4d5e-8f90-123456789abc";
    const JOB2 = "job-terminal-record-2";
    const d = fixture("event.upsert", async (key) => {
      if (key === UUID) throw new Error("settlement store down");
    });
    const attempt2 = attemptFor("event.upsert", { idempotencyKey: UUID2, eventKey: "e2" });
    // The second delivery's attempt carries its own event key in its payload.
    if (attempt2.action === "event.upsert") attempt2.payload.eventKey = "e2";
    d.events.prepareSync
      .mockReset()
      .mockResolvedValueOnce(d.attempt)
      .mockResolvedValueOnce(attempt2);

    const first = carrier(1);
    const second = carrier(1, { eventKey: "e2", idempotencyKey: UUID2, jobId: JOB2 });
    await consume({ messages: [first, second] }, { ...d, bot: terminalBot() });

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    expect(d.rows.size).toBe(2);
    expect(d.rows.get(JOB)).toEqual({
      jobId: JOB,
      kind: "sync-event",
      key: "sync-event:e1",
      reason: "BotTerminalError",
    });
    expect(d.rows.get(JOB2)).toEqual({
      jobId: JOB2,
      kind: "sync-event",
      key: "sync-event:e2",
      reason: "BotTerminalError",
    });
    expect(failingAlerts(calls)).toHaveLength(2);
  });
});

describe("controls: outcomes that already settle keep their shape", () => {
  it("a settled definitive failure stamps, alerts, releases the lock and acks once", async () => {
    const calls = capture();
    const d = fixture("event.upsert");
    const m = carrier(1);

    await consume({ messages: [m] }, { ...d, bot: terminalBot() });

    expect(d.events.failSync).toHaveBeenCalledExactlyOnceWith(UUID);
    expect(d.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB,
      "sync-event",
      "sync-event:e1",
      "BotTerminalError",
    );
    expect(d.rows.size).toBe(1);
    expect(failingAlerts(calls)).toHaveLength(1);
    expect(d.lock.release).toHaveBeenCalledExactlyOnceWith("sync-event:e1", LEASE);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("a retryable refusal before exhaustion retries with no failed stamp and no alert", async () => {
    const calls = capture();
    const d = fixture("event.upsert");
    const bot = {
      upsertEvent: vi.fn(async () => ({
        ok: false,
        code: "internal",
        status: 500,
        requestId: null,
        message: "transient",
        retryable: true,
        retryAfterSeconds: 42,
      })),
      cancelEvent: vi.fn(),
    } as unknown as BotClient;
    const m = carrier(1);

    await consume({ messages: [m] }, { ...d, bot });

    expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 42 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.events.deferSync).toHaveBeenCalledOnce();
    expect(d.ledger.failed).not.toHaveBeenCalled();
    expect(d.rows.size).toBe(0);
    expect(failingAlerts(calls)).toHaveLength(0);
  });

  it("a successful sync completes and acks with no failed stamp and no alert", async () => {
    const calls = capture();
    const d = fixture("event.upsert");
    const bot = {
      upsertEvent: vi.fn(async () => ({ ok: true, requestId: null, discordEventId: "d1" })),
      cancelEvent: vi.fn(async () => ({ ok: true, requestId: null, discordEventId: "d1" })),
    } as unknown as BotClient;
    const m = carrier(1);

    await consume({ messages: [m] }, { ...d, bot });

    expect(d.events.completeSync).toHaveBeenCalledOnce();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.ledger.failed).not.toHaveBeenCalled();
    expect(d.rows.size).toBe(0);
    expect(failingAlerts(calls)).toHaveLength(0);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });
});
