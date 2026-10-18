// Acceptance: a definitive sync failure whose settlement (`events.failSync`)
// throws must fail open without hiding the stuck message from the ledger.
//
// The consumer stamps the ledger row `reserved` before it runs the job. The
// ready-wait probe only ages rows that are not reserved, so a settlement
// outage that retries the carrier while leaving the row `reserved` inflates
// the reserved count behind a healthy age signal. The settlement-failure
// retry must therefore stamp `ledger.released` (bounded, best-effort, like
// every other ledger write) before it calls `message.retry()` — the same
// order the ordinary redelivery paths already use. It must still never ack:
// the attempt remains unsettled and keeps blocking future revisions until a
// later delivery settles it.
//
// Hermetic: in-memory event store, ledger, lock and bot doubles only. No
// database, queue or network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const now = () => new Date(NOW.getTime());
const EVENT_KEY = "e-settle";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";

type BotMode = "refusal" | "terminal" | "throw" | "transport" | "ok";
type ReleasedMode = "ok" | "reject" | "hang";

const refusal: BotFailure = {
  ok: false,
  code: "action_not_allowed",
  status: 403,
  requestId: "r1",
  message: "flag off",
  retryable: false,
  retryAfterSeconds: null,
};

function attemptFor(eventKey: string, idempotencyKey: string): SyncAttempt {
  return {
    idempotencyKey,
    eventKey,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00.000Z"),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date("2026-10-01T11:00:00.000Z"),
    action: "event.upsert",
    payload: {
      eventKey,
      name: "Game night",
      startsAt: "2026-10-01T13:00:00.000Z",
      endsAt: "2026-10-01T14:00:00.000Z",
      location: "Discord",
      description: null,
    },
  };
}

function carrier(over: Record<string, unknown> = {}) {
  return {
    kind: "sync-event",
    eventKey: EVENT_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    leaseToken: LEASE_TOKEN,
    jobId: JOB_ID,
    ...over,
  };
}

function setup(
  opts: {
    botMode?: BotMode;
    failSyncThrows?: boolean;
    releasedMode?: ReleasedMode;
    waiting?: boolean;
    botByEventKey?: Record<string, BotMode>;
  } = {},
) {
  const order: string[] = [];
  const rows = new Map<string, { state: string; availableAt?: Date; reason?: string }>();
  const seed = (jobId: string) => rows.set(jobId, { state: "pending" });
  seed(JOB_ID);

  const answerFor = (mode: BotMode) => async () => {
    if (mode === "refusal") return refusal;
    if (mode === "terminal") throw new BotTerminalError("bot misconfigured");
    if (mode === "throw") throw new Error("unexpected bot failure");
    if (mode === "transport") throw new BotTransportError("bot down");
    return { ok: true as const, requestId: "r1", discordEventId: "d1" };
  };
  const upsertEvent = vi.fn(async (payload: { eventKey: string }) =>
    answerFor(opts.botByEventKey?.[payload.eventKey] ?? opts.botMode ?? "refusal")(),
  );
  const bot = {
    upsertEvent,
    cancelEvent: vi.fn(answerFor(opts.botMode ?? "refusal")),
    postAnnouncement: vi.fn(),
    assignRole: vi.fn(),
  } as unknown as BotClient;

  const failSync = vi.fn((_idempotencyKey: string) => {
    order.push("events.failSync");
    return opts.failSyncThrows
      ? Promise.reject(new Error("settlement store unavailable"))
      : Promise.resolve();
  });
  const deferSync = vi.fn(() => {
    order.push("events.deferSync");
    return Promise.resolve();
  });
  const completeSync = vi.fn(() => Promise.resolve());
  const events = {
    prepareSync: vi.fn(async (eventKey: string, key: string) =>
      opts.waiting ? { waiting: true as const } : attemptFor(eventKey, key),
    ),
    claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
    completeSync,
    deferSync,
    failSync,
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  } as unknown as EventStore;

  const ledger: QueueLedger = {
    enqueued: vi.fn(() => Promise.resolve()),
    reserved: vi.fn((jobId: string) => {
      order.push("ledger.reserved");
      rows.set(jobId, { ...rows.get(jobId), state: "reserved" });
      return Promise.resolve();
    }),
    released: vi.fn((jobId: string, availableAt: Date) => {
      order.push("ledger.released");
      if (opts.releasedMode === "reject") return Promise.reject(new Error("ledger down"));
      if (opts.releasedMode === "hang") return new Promise<void>(() => {});
      rows.set(jobId, { ...rows.get(jobId), state: "released", availableAt });
      return Promise.resolve();
    }),
    dequeued: vi.fn((jobId: string) => {
      order.push("ledger.dequeued");
      rows.delete(jobId);
      return Promise.resolve();
    }),
    failed: vi.fn((jobId: string, _kind: string, _key: string | null, reason: string) => {
      order.push("ledger.failed");
      rows.set(jobId, { state: "failed", reason });
      return Promise.resolve();
    }),
  };

  const lock: UniqueLock = {
    acquire: vi.fn(async () => LEASE_TOKEN),
    release: vi.fn(() => {
      order.push("lock.release");
      return Promise.resolve();
    }),
  };

  const message = (body: unknown, attempts = 1, prefix = "message") => ({
    body,
    attempts,
    ack: vi.fn(() => void order.push(`${prefix}.ack`)),
    retry: vi.fn(() => void order.push(`${prefix}.retry`)),
  });

  return {
    order,
    rows,
    seed,
    message,
    upsertEvent,
    failSync,
    deferSync,
    completeSync,
    ledger,
    lock,
    deps: { bot, events, ledger, lock, now },
  };
}

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

const failingAlerts = () => errors.filter((l) => l.includes('"event":"queue.failing"'));

describe("settlement failure on a definitive sync failure", () => {
  it.each([
    ["a non-retryable bot refusal", "refusal"],
    ["a terminal bot error", "terminal"],
  ] as const)(
    "failSync throwing after %s stamps released before the fail-open retry",
    async (_label, botMode) => {
      const s = setup({ botMode, failSyncThrows: true });
      const m = s.message(carrier());

      await consume({ messages: [m] }, s.deps);

      // Settlement was attempted exactly once, for this carrier's key.
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      // Fail open: the carrier goes back on the queue undelayed, never acked
      // while its attempt still blocks future revisions.
      expect(m.retry).toHaveBeenCalledExactlyOnceWith();
      expect(m.ack).not.toHaveBeenCalled();
      // The ledger row must not stay `reserved`: released is stamped with the
      // consumer's clock (the retry carries no delay), and nothing buries or
      // dequeues the row.
      expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
      expect(s.ledger.failed).not.toHaveBeenCalled();
      expect(s.ledger.dequeued).not.toHaveBeenCalled();
      expect(s.rows.get(JOB_ID)).toEqual({ state: "released", availableAt: NOW });
      // Exact call order: released lands before the retry is signalled.
      expect(s.order).toEqual([
        "ledger.reserved",
        "events.failSync",
        "ledger.released",
        "message.retry",
      ]);
      // Not a terminal failure yet: no queue.failing alert, lock stays held
      // for the redelivery.
      expect(failingAlerts()).toEqual([]);
      expect(s.lock.release).not.toHaveBeenCalled();
      expect(s.completeSync).not.toHaveBeenCalled();
    },
  );

  it("a rejecting released stamp still fails open to the retry", async () => {
    const s = setup({ botMode: "refusal", failSyncThrows: true, releasedMode: "reject" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.failSync",
      "ledger.released",
      "message.retry",
    ]);
    // The stamp itself failed, so the visible row is unchanged — but the
    // carrier was still retried rather than held hostage to the ledger.
    expect(s.rows.get(JOB_ID)?.state).toBe("reserved");
  });

  it("a hung released stamp is bounded and still fails open to the retry", async () => {
    const s = setup({ botMode: "refusal", failSyncThrows: true, releasedMode: "hang" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.failSync",
      "ledger.released",
      "message.retry",
    ]);
  }, 15_000);

  it("a settlement failure on one message does not stall the rest of the batch", async () => {
    const goodJob = "77777777-7777-4777-8777-777777777777";
    const s = setup({
      failSyncThrows: true,
      botByEventKey: { [EVENT_KEY]: "refusal", "e-good": "ok" },
    });
    s.seed(goodJob);
    const stuck = s.message(carrier(), 1, "stuck");
    const healthy = s.message(
      carrier({
        eventKey: "e-good",
        idempotencyKey: "88888888-8888-4888-8888-888888888888",
        jobId: goodJob,
      }),
      1,
      "healthy",
    );

    await consume({ messages: [stuck, healthy] }, s.deps);

    expect(stuck.retry).toHaveBeenCalledExactlyOnceWith();
    expect(stuck.ack).not.toHaveBeenCalled();
    expect(healthy.ack).toHaveBeenCalledExactlyOnceWith();
    expect(healthy.retry).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).toHaveBeenCalledExactlyOnceWith(goodJob);
    expect(s.rows.has(goodJob)).toBe(false);
  });
});

describe("settlement and retry controls (unchanged paths)", () => {
  it("a definitive failure that settles stamps failed, releases the lock, then acks", async () => {
    const s = setup({ botMode: "refusal" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB_ID,
      "sync-event",
      `sync-event:${EVENT_KEY}`,
      expect.stringContaining("action_not_allowed"),
    );
    expect(s.ledger.released).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(s.rows.get(JOB_ID)?.state).toBe("failed");
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(m.retry).not.toHaveBeenCalled();
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.failSync",
      "ledger.failed",
      "lock.release",
      "message.ack",
    ]);
    expect(failingAlerts()).toHaveLength(1);
  });

  it("a redeliverable throw stamps released with the clock, then retries undelayed", async () => {
    const s = setup({ botMode: "throw" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.failSync).not.toHaveBeenCalled();
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.rows.get(JOB_ID)).toEqual({ state: "released", availableAt: NOW });
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.deferSync",
      "ledger.released",
      "message.retry",
    ]);
    expect(failingAlerts()).toEqual([]);
    expect(s.lock.release).not.toHaveBeenCalled();
  });

  it("a delayed retry stamps released at now plus the delay, then retries with it", async () => {
    const s = setup({ botMode: "transport" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    const availableAt = new Date(NOW.getTime() + 10_000);
    expect(s.failSync).not.toHaveBeenCalled();
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, availableAt);
    expect(s.rows.get(JOB_ID)).toEqual({ state: "released", availableAt });
    expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.deferSync",
      "ledger.released",
      "message.retry",
    ]);
  });

  it("a carrier without a ledger row still retries when settlement throws", async () => {
    const s = setup({ botMode: "refusal", failSyncThrows: true });
    const legacy = {
      kind: "sync-event",
      eventKey: EVENT_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
      leaseToken: LEASE_TOKEN,
    };
    const m = s.message(legacy);

    await consume({ messages: [m] }, s.deps);

    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.reserved).not.toHaveBeenCalled();
    expect(s.ledger.released).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.order).toEqual(["events.failSync", "message.retry"]);
  });

  it("a non-definitive terminal failure stamps failed without settling", async () => {
    const s = setup({ waiting: true });
    const m = s.message(carrier(), 6);

    await consume({ messages: [m] }, s.deps);

    expect(s.upsertEvent).not.toHaveBeenCalled();
    expect(s.failSync).not.toHaveBeenCalled();
    expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB_ID,
      "sync-event",
      `sync-event:${EVENT_KEY}`,
      "waiting carrier exhausted; request remains recoverable",
    );
    expect(s.ledger.released).not.toHaveBeenCalled();
    expect(s.rows.get(JOB_ID)?.state).toBe("failed");
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(m.retry).not.toHaveBeenCalled();
    expect(s.order).toEqual(["ledger.reserved", "ledger.failed", "lock.release", "message.ack"]);
  });
});
