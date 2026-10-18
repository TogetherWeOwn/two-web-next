// Acceptance: a wedged `events.failSync` cannot stall the consumer batch.
//
// When a sync fails definitively, the consumer settles the attempt through
// `events.failSync` before it stamps the ledger `failed`, releases the lock
// and acks the carrier. Every other ledger/lock wait in the consumer is raced
// against a short bound, but the settlement wait is not: a `failSync` that
// never settles blocks the serial batch, so no later message is acked or
// retried either.
//
// The settlement wait must race the same bound as the sibling ledger waits.
// On expiry the message takes the existing settlement-failure path — stamp
// `ledger.released` (bounded, best-effort), then `message.retry()` undelayed —
// and must never ack: the attempt remains unsettled and keeps blocking future
// revisions until a later delivery settles it. A definitive outcome still
// owes its terminal record on that same delivery: after the retry is queued,
// one `queue.failing` alert and one `ledger.failed` stamp land (the terminal
// stamp follows the released stamp, so the row reads `failed`). A settlement
// that resolves after the bound must not flip the carrier to the settled
// path afterwards. Normal and rejecting `failSync` behavior is unchanged;
// there is no new ack path.
//
// Hermetic: in-memory event store, ledger, lock and bot doubles only. No
// database, queue or network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { BotTerminalError } from "../src/jobs/types";
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
const EVENT_KEY = "e-wedge";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";

// The bound the sibling ledger waits already use is ~2s. A wedged settlement
// must give up in that class of wait: never sooner than 1.5s (a much shorter
// give-up would abandon slow-but-healthy settlements), and the batch must
// move on well inside a 10s window even on a loaded runner.
const SETTLE_WINDOW_MS = 10_000;
const MIN_BOUND_MS = 1_500;
// A settlement that beats the bound comfortably (slow control) and one that
// only resolves after it (late case). Real timers fire late, never early,
// so both stay on their side of the bound under load.
const SLOW_MS = 100;
const LATE_MS = 3_500;

type BotMode = "refusal" | "terminal" | "ok";
type FailSyncMode = "ok" | "reject" | "hang" | "slow" | "late";

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

// Reports how `p` ends, or "pending" if it has not settled within `ms`.
// Handlers attach immediately, so a late rejection is never unhandled; a
// wedged promise holds no timer, so abandoning it cannot pollute later tests.
function outcomeWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<"resolved" | "rejected" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = p.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

function setup(
  opts: {
    botMode?: BotMode;
    botByEventKey?: Record<string, BotMode>;
    failSyncMode?: FailSyncMode;
    hangOnlyForKey?: string;
  } = {},
) {
  const order: string[] = [];
  const rows = new Map<string, { state: string; availableAt?: Date; reason?: string }>();
  const seed = (jobId: string) => rows.set(jobId, { state: "pending" });
  seed(JOB_ID);

  const answerFor = (mode: BotMode) => async () => {
    if (mode === "refusal") return refusal;
    if (mode === "terminal") throw new BotTerminalError("bot misconfigured");
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

  // Resolves when a "late" settlement finally lands, so the late test can
  // prove the abandoned settlement changes nothing once it arrives.
  let markLateSettled: (() => void) | undefined;
  const lateSettled = new Promise<void>((resolve) => {
    markLateSettled = resolve;
  });
  const failSync = vi.fn((idempotencyKey: string) => {
    order.push("events.failSync");
    const mode = opts.failSyncMode ?? "ok";
    if (
      mode === "hang" &&
      (opts.hangOnlyForKey === undefined || opts.hangOnlyForKey === idempotencyKey)
    ) {
      return new Promise<void>(() => {});
    }
    if (mode === "reject") return Promise.reject(new Error("settlement store unavailable"));
    if (mode === "slow") {
      return new Promise<void>((resolve) => setTimeout(resolve, SLOW_MS));
    }
    if (mode === "late") {
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          markLateSettled?.();
          resolve();
        }, LATE_MS),
      );
    }
    return Promise.resolve();
  });
  const completeSync = vi.fn(() => Promise.resolve());
  const events = {
    prepareSync: vi.fn(async (eventKey: string, key: string) => attemptFor(eventKey, key)),
    claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
    completeSync,
    deferSync: vi.fn(() => Promise.resolve()),
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
    failSync,
    completeSync,
    lateSettled,
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

describe("wedged failSync (new behavior)", () => {
  it.each([
    ["a non-retryable bot refusal", "refusal", expect.stringContaining("action_not_allowed")],
    ["a terminal bot error", "terminal", "BotTerminalError"],
  ] as const)(
    "never-resolving failSync after %s gives up at the bound and retries without ack",
    async (_label, botMode, reason) => {
      const s = setup({ botMode, failSyncMode: "hang" });
      const m = s.message(carrier());

      const started = Date.now();
      const outcome = await outcomeWithin(consume({ messages: [m] }, s.deps), SETTLE_WINDOW_MS);
      const elapsed = Date.now() - started;

      // The batch must finish despite the wedge, and only after a real wait:
      // an immediate give-up would abandon slow-but-healthy settlements.
      expect(outcome).toBe("resolved");
      expect(elapsed).toBeGreaterThanOrEqual(MIN_BOUND_MS);
      // Settlement was attempted exactly once, for this carrier's key.
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      // Existing settlement-failure path: released is stamped with the
      // consumer's clock before the undelayed retry; never ack while the
      // attempt still blocks future revisions.
      expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
      expect(m.retry).toHaveBeenCalledExactlyOnceWith();
      expect(m.ack).not.toHaveBeenCalled();
      // A definitive outcome still records its terminal stamp on this
      // delivery: the failed stamp follows the retry, overwriting the
      // released row; the lock stays held for the redelivery and the
      // attempt is not completed.
      expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
        JOB_ID,
        "sync-event",
        `sync-event:${EVENT_KEY}`,
        reason,
      );
      expect(s.ledger.dequeued).not.toHaveBeenCalled();
      expect(s.rows.get(JOB_ID)).toEqual({ state: "failed", reason });
      expect(s.order).toEqual([
        "ledger.reserved",
        "events.failSync",
        "ledger.released",
        "message.retry",
        "ledger.failed",
      ]);
      expect(failingAlerts()).toHaveLength(1);
      expect(s.lock.release).not.toHaveBeenCalled();
      expect(s.completeSync).not.toHaveBeenCalled();
    },
  );

  it("a wedged failSync on one message does not stall the rest of the batch", async () => {
    const goodJob = "44444444-4444-4444-8444-444444444444";
    const s = setup({
      failSyncMode: "hang",
      hangOnlyForKey: IDEMPOTENCY_KEY,
      botByEventKey: { [EVENT_KEY]: "refusal", "e-good": "ok" },
    });
    s.seed(goodJob);
    const stuck = s.message(carrier(), 1, "stuck");
    const healthy = s.message(
      carrier({
        eventKey: "e-good",
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        jobId: goodJob,
      }),
      1,
      "healthy",
    );

    const outcome = await outcomeWithin(
      consume({ messages: [stuck, healthy] }, s.deps),
      SETTLE_WINDOW_MS,
    );

    expect(outcome).toBe("resolved");
    // The wedged carrier retries without ack; the later healthy carrier
    // still completes and acks.
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(stuck.retry).toHaveBeenCalledExactlyOnceWith();
    expect(stuck.ack).not.toHaveBeenCalled();
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    // The wedged carrier's definitive outcome still lands its one terminal
    // stamp and one alert before the batch moves on.
    expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB_ID,
      "sync-event",
      `sync-event:${EVENT_KEY}`,
      expect.stringContaining("action_not_allowed"),
    );
    expect(failingAlerts()).toHaveLength(1);
    expect(healthy.ack).toHaveBeenCalledExactlyOnceWith();
    expect(healthy.retry).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).toHaveBeenCalledExactlyOnceWith(goodJob);
    expect(s.rows.has(goodJob)).toBe(false);
    expect(s.rows.get(JOB_ID)).toEqual({
      state: "failed",
      reason: expect.stringContaining("action_not_allowed"),
    });
  });

  it("a failSync resolving only after the bound does not flip the carrier to settled", async () => {
    const s = setup({ botMode: "refusal", failSyncMode: "late" });
    const m = s.message(carrier());

    const outcome = await outcomeWithin(consume({ messages: [m] }, s.deps), SETTLE_WINDOW_MS);

    // The consumer gave up at the bound and took the retry path; the
    // definitive outcome lands its one terminal stamp and one alert.
    expect(outcome).toBe("resolved");
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB_ID,
      "sync-event",
      `sync-event:${EVENT_KEY}`,
      expect.stringContaining("action_not_allowed"),
    );
    expect(failingAlerts()).toHaveLength(1);

    // When the abandoned settlement finally lands, nothing else happens:
    // no late ack, no second failed stamp or alert, no lock release, no
    // second settlement.
    await s.lateSettled;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).toHaveBeenCalledTimes(1);
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(s.lock.release).not.toHaveBeenCalled();
    expect(s.failSync).toHaveBeenCalledTimes(1);
    expect(s.rows.get(JOB_ID)).toEqual({
      state: "failed",
      reason: expect.stringContaining("action_not_allowed"),
    });
    expect(failingAlerts()).toHaveLength(1);
  });
});

describe("failSync controls (unchanged paths)", () => {
  it("a rejecting failSync takes today's settlement-failure path", async () => {
    const s = setup({ botMode: "refusal", failSyncMode: "reject" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).toHaveBeenCalledExactlyOnceWith(
      JOB_ID,
      "sync-event",
      `sync-event:${EVENT_KEY}`,
      expect.stringContaining("action_not_allowed"),
    );
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(s.rows.get(JOB_ID)).toEqual({
      state: "failed",
      reason: expect.stringContaining("action_not_allowed"),
    });
    expect(s.order).toEqual([
      "ledger.reserved",
      "events.failSync",
      "ledger.released",
      "message.retry",
      "ledger.failed",
    ]);
    expect(failingAlerts()).toHaveLength(1);
    expect(s.lock.release).not.toHaveBeenCalled();
  });

  it.each([
    ["a resolving", "ok"],
    ["a slow-but-in-bounds", "slow"],
  ] as const)(
    "%s failSync settles: failed stamp, lock release, then ack",
    async (_label, failSyncMode) => {
      const s = setup({ botMode: "refusal", failSyncMode });
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
    },
  );
});
