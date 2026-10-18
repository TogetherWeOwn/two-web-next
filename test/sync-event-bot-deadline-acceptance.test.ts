import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { INTERNAL_ACTION_DEADLINE_MS } from "../src/jobs/internal-action-deadline";
import { handleSyncEvent } from "../src/jobs/sync-event";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

// Acceptance: a stalled bot body read on the sync-event path must retry on
// budget instead of wedging the serial batch. The internal-action handler
// already races its bot calls against the shared independent deadline; the
// sync-event handler must race BOTH of its bot calls (upsert and cancel)
// against that same deadline. Expiry must surface exactly like a transport
// loss — the existing retry/backoff disposition, with its budget accounting
// untouched — never as a terminal or definitive-refusal reclassification.
// A bot promise that settles after the deadline is the race loser: it must
// not change the disposed outcome, settle the attempt, or leak a rejection.
const clock = 1_000_000;
const eventKey = "evt-deadline-acceptance";
const idempotencyKey = "sync-deadline-request-key";

function makeAttempt(
  priorRequests = 0,
  action: "event.upsert" | "event.cancel" = "event.upsert",
  discordEventId: string | null = "discord-1",
  key = eventKey,
): SyncAttempt {
  return {
    eventKey: key,
    idempotencyKey,
    revision: 1,
    mirroredAt: new Date(clock - 12_500),
    state: "pending",
    requestAttempts: priorRequests,
    nextAttemptAt: new Date(0),
    discordEventId,
    ...(action === "event.cancel"
      ? { action, payload: { eventKey: key } }
      : {
          action,
          payload: {
            eventKey: key,
            name: "Deadline acceptance social",
            startsAt: "2026-10-01T12:00:00Z",
            endsAt: "2026-10-01T13:00:00Z",
            location: "Clubhouse",
            description: "Fixture payload.",
          },
        }),
  };
}

function fixture(attempt: SyncAttempt) {
  const events: EventStore = {
    prepareSync: vi.fn(async () => attempt),
    claimSync: vi.fn(async () => {
      attempt.requestAttempts++;
      attempt.nextAttemptAt = null;
      return attempt;
    }),
    deferSync: vi.fn(async (_attempt, deadline) => {
      attempt.nextAttemptAt = deadline;
    }),
    completeSync: vi.fn(async () => {}),
    failSync: vi.fn(async () => {}),
    needsSync: vi.fn(async () => false),
    pendingSync: vi.fn(async () => attempt),
    closeFinished: vi.fn(async () => 0),
    materializeSeries: vi.fn(async () => 0),
    staleEventKeys: vi.fn(async () => []),
  };
  const onRetryDiagnostic = vi.fn();
  return { attempt, events, onRetryDiagnostic, now: () => new Date(clock) };
}

const okAnswer = { ok: true, requestId: null, discordEventId: "discord-9" } as const;
const refusal = (over: Partial<BotFailure> = {}): BotFailure => ({
  ok: false,
  code: "internal",
  status: 500,
  requestId: null,
  message: "fixture refusal",
  retryable: true,
  retryAfterSeconds: null,
  ...over,
});

/** A manually settled promise standing in for a stalled bot call. */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Capture a promise's settlement without ever leaving it unhandled. */
function capture<T>(p: Promise<T>) {
  const box: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  const done = p.then(
    (value) => {
      box.settled = true;
      box.value = value;
    },
    (error: unknown) => {
      box.settled = true;
      box.error = error;
    },
  );
  return { box, done };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sync-event bot calls are bounded by the shared deadline", () => {
  it("a never-settling upsert returns the transport retry on budget", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const bot = {
      upsertEvent: vi.fn(() => gate.promise),
      cancelEvent: vi.fn(async () => okAnswer),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    const { box, done } = capture(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot }));

    // Not before the deadline: the wait is the deadline's, not a shortcut.
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS - 1);
    expect(box.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    const settledOnBudget = box.settled;

    // Release the stalled bot so no handler outlives the test; on the fixed
    // path this late success is the race loser and changes nothing.
    gate.resolve(okAnswer);
    await done;

    expect(settledOnBudget).toBe(true);
    expect(box.error).toBeUndefined();
    // First rung of the sync backoff ladder: max(carrier 1, request 1) -> 10s.
    expect(box.value).toEqual({ retryInSeconds: 10 });
    // Expiry classifies as transport loss for observability, with the same
    // counters a bot-down throw would produce.
    expect(d.onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith({
      sync_retry_class: "BotTransportError",
      queue_carrier_attempts: 1,
      sync_request_attempts: 1,
      sync_snapshot_age_at_claim_seconds: 12,
    });
    // Budget accounting unchanged: one claim, one bot call with the original
    // payload and request identity, one deferral at the backoff instant.
    expect(d.events.claimSync).toHaveBeenCalledOnce();
    expect(d.attempt.requestAttempts).toBe(1);
    expect(bot.upsertEvent).toHaveBeenCalledExactlyOnceWith(d.attempt.payload, idempotencyKey);
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 10_000));
    expect(d.events.completeSync).not.toHaveBeenCalled();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.attempt.state).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a never-settling cancel returns the transport retry on budget", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const bot = {
      upsertEvent: vi.fn(async () => okAnswer),
      cancelEvent: vi.fn(() => gate.promise),
    } as unknown as BotClient;
    // Mirrored cancel (a Discord object exists), second request attempt.
    const d = fixture(makeAttempt(1, "event.cancel"));
    const { box, done } = capture(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot }));

    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1_000);
    const settledOnBudget = box.settled;
    gate.resolve(okAnswer);
    await done;

    expect(settledOnBudget).toBe(true);
    expect(box.error).toBeUndefined();
    // Second rung: max(carrier 1, request 2) -> 60s.
    expect(box.value).toEqual({ retryInSeconds: 60 });
    expect(d.onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sync_retry_class: "BotTransportError",
        sync_request_attempts: 2,
      }),
    );
    expect(bot.cancelEvent).toHaveBeenCalledExactlyOnceWith(d.attempt.payload, idempotencyKey);
    expect(bot.upsertEvent).not.toHaveBeenCalled();
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 60_000));
    expect(d.events.completeSync).not.toHaveBeenCalled();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expiry at the request cap keeps the identity recoverable, never definitive", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const bot = { upsertEvent: vi.fn(() => gate.promise) } as unknown as BotClient;
    // The claim spends the last request try; a transport expiry must take the
    // exhausted-carrier path (null next attempt, identity retained), not the
    // definitive-refusal settlement.
    const d = fixture(makeAttempt(5, "event.upsert"));
    const { box, done } = capture(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot }));

    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1_000);
    const settledOnBudget = box.settled;
    gate.resolve(okAnswer);
    await done;

    expect(settledOnBudget).toBe(true);
    expect(box.value).toEqual({ failed: "carrier exhausted; unresolved identity retained" });
    expect(box.value).not.toHaveProperty("definitive");
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, null);
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
    expect(d.attempt.state).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stalled first message retries on budget and the serial batch moves on", async () => {
    vi.useFakeTimers();
    const hangKey = "evt-stalled-first";
    const fastKey = "evt-fast-second";
    const attemptsByKey = new Map<string, SyncAttempt>([
      [hangKey, makeAttempt(0, "event.upsert", "discord-1", hangKey)],
      [fastKey, makeAttempt(0, "event.upsert", "discord-1", fastKey)],
    ]);
    const gate = deferred();
    const bot = {
      upsertEvent: vi.fn((payload: { eventKey: string }) =>
        payload.eventKey === hangKey ? gate.promise : Promise.resolve(okAnswer),
      ),
    } as unknown as BotClient;
    const events: EventStore = {
      prepareSync: vi.fn(async (key: string) => attemptsByKey.get(key) ?? null),
      claimSync: vi.fn(async (attempt: SyncAttempt) => {
        attempt.requestAttempts++;
        attempt.nextAttemptAt = null;
        return attempt;
      }),
      deferSync: vi.fn(async (attempt: SyncAttempt, deadline) => {
        attempt.nextAttemptAt = deadline;
      }),
      completeSync: vi.fn(async () => {}),
      failSync: vi.fn(async () => {}),
      needsSync: vi.fn(async () => false),
      pendingSync: vi.fn(async () => null),
      closeFinished: vi.fn(async () => 0),
      materializeSeries: vi.fn(async () => 0),
      staleEventKeys: vi.fn(async () => []),
    };
    const ledger: QueueLedger = {
      enqueued: vi.fn(async () => {}),
      reserved: vi.fn(async () => {}),
      released: vi.fn(async () => {}),
      dequeued: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const leaseToken = "11111111-1111-4111-8111-111111111111";
    const lock: UniqueLock = {
      acquire: vi.fn(async () => leaseToken),
      release: vi.fn(async () => {}),
    };
    const carrier = (key: string, jobId: string) => ({
      body: { kind: "sync-event", eventKey: key, idempotencyKey, leaseToken, jobId },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    const first = carrier(hangKey, "job-stalled");
    const second = carrier(fastKey, "job-fast");
    const { box, done } = capture(
      consume(
        { messages: [first, second] },
        { bot, events, ledger, lock, now: () => new Date(clock) },
      ),
    );

    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1_000);
    const batchSettledOnBudget = box.settled;
    gate.resolve(okAnswer);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(batchSettledOnBudget).toBe(true);
    expect(box.error).toBeUndefined();
    // The stalled message waits on its backoff rung; the sibling completes.
    expect(first.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    expect(events.failSync).not.toHaveBeenCalled();
    expect(events.completeSync).toHaveBeenCalledExactlyOnceWith(
      attemptsByKey.get(fastKey),
      okAnswer.discordEventId,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a bot settlement after expiry cannot change the disposed outcome", () => {
  const lateOutcomes: Array<{
    name: string;
    settle: (gate: ReturnType<typeof deferred>) => void;
  }> = [
    { name: "late success", settle: (gate) => gate.resolve(okAnswer) },
    {
      name: "late non-retryable refusal",
      settle: (gate) =>
        gate.resolve(refusal({ code: "action_not_allowed", status: 403, retryable: false })),
    },
    {
      name: "late retryable refusal with its own wait",
      settle: (gate) =>
        gate.resolve(refusal({ code: "rate_limited", status: 429, retryAfterSeconds: 999 })),
    },
    {
      name: "late terminal rejection",
      settle: (gate) => gate.reject(new BotTerminalError("late")),
    },
    { name: "late generic rejection", settle: (gate) => gate.reject(new TypeError("late boom")) },
  ];

  it.each(lateOutcomes)("$name stays the timeout disposition", async ({ settle }) => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const gate = deferred();
      const bot = { upsertEvent: vi.fn(() => gate.promise) } as unknown as BotClient;
      const d = fixture(makeAttempt(0, "event.upsert"));
      // Carrier attempt 2, first request claim: max(2, 1) -> 60s rung.
      const { box, done } = capture(
        handleSyncEvent({ eventKey, idempotencyKey }, 2, { ...d, bot }),
      );

      await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1_000);
      const settledOnBudget = box.settled;
      const disposed = box.value;

      settle(gate);
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      // Yield event-loop turns under the fake clock (setImmediate is faked
      // and would never fire) so any unhandled-rejection checkpoint runs.
      for (let round = 0; round < 5; round++) await vi.advanceTimersByTimeAsync(0);

      expect(settledOnBudget).toBe(true);
      expect(disposed).toEqual({ retryInSeconds: 60 });
      expect(box.value).toEqual({ retryInSeconds: 60 });
      expect(box.error).toBeUndefined();
      // The race loser performs no settlement and no second accounting write.
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
        d.attempt,
        new Date(clock + 60_000),
      );
      expect(d.events.completeSync).not.toHaveBeenCalled();
      expect(d.events.failSync).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("fast bot outcomes are unchanged (positive controls)", () => {
  it("succeeds when the bot settles inside the deadline, with no timer leak", async () => {
    vi.useFakeTimers();
    const bot = {
      upsertEvent: vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(okAnswer), 1_000);
          }),
      ),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    const { box, done } = capture(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot }));
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(box.value).toEqual({ done: true });
    expect(d.events.completeSync).toHaveBeenCalledExactlyOnceWith(
      d.attempt,
      okAnswer.discordEventId,
    );
    expect(d.events.deferSync).not.toHaveBeenCalled();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an immediate transport throw takes the same retry the deadline must produce", async () => {
    const bot = {
      upsertEvent: vi.fn(async () => {
        throw new BotTransportError("bot down");
      }),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).resolves.toEqual({
      retryInSeconds: 10,
    });
    expect(d.onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith({
      sync_retry_class: "BotTransportError",
      queue_carrier_attempts: 1,
      sync_request_attempts: 1,
      sync_snapshot_age_at_claim_seconds: 12,
    });
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 10_000));
    expect(d.events.failSync).not.toHaveBeenCalled();
  });

  it("a fast retryable refusal keeps its admitted wait", async () => {
    const bot = {
      upsertEvent: vi.fn(async () =>
        refusal({ code: "rate_limited", status: 429, retryAfterSeconds: 42 }),
      ),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).resolves.toEqual({
      retryInSeconds: 42,
    });
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 42_000));
    expect(d.events.failSync).not.toHaveBeenCalled();
  });

  it("a fast non-retryable refusal stays definitive", async () => {
    const bot = {
      upsertEvent: vi.fn(async () =>
        refusal({ code: "action_not_allowed", status: 403, retryable: false }),
      ),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).resolves.toEqual({
      definitive: true,
      failed: expect.stringContaining("action_not_allowed"),
    });
    expect(d.events.deferSync).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
  });

  it("a fast terminal throw stays terminal", async () => {
    const bot = {
      upsertEvent: vi.fn(async () => {
        throw new BotTerminalError("misconfigured");
      }),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).resolves.toEqual({
      failed: "BotTerminalError",
      definitive: true,
    });
    expect(d.events.deferSync).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
  });

  it("a fast generic throw still defers once and propagates", async () => {
    const boom = new TypeError("local boom");
    const bot = {
      upsertEvent: vi.fn(async () => {
        throw boom;
      }),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.upsert"));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).rejects.toBe(
      boom,
    );
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 10_000));
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
  });

  it("a never-mirrored cancel settles locally and never reaches the bot deadline", async () => {
    const bot = {
      cancelEvent: vi.fn(() => new Promise(() => {})),
    } as unknown as BotClient;
    const d = fixture(makeAttempt(0, "event.cancel", null));
    await expect(handleSyncEvent({ eventKey, idempotencyKey }, 1, { ...d, bot })).resolves.toEqual({
      done: true,
    });
    expect(bot.cancelEvent).not.toHaveBeenCalled();
    expect(d.events.completeSync).toHaveBeenCalledExactlyOnceWith(d.attempt, null);
  });
});
