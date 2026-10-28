// Acceptance: terminal-intent marker and settlement-only redelivery.
//
// A definitive sync failure first records a terminal-intent marker on the
// pending attempt (`terminal_reason`, state stays pending), then runs the
// existing bounded `failSync` race unchanged. Settlement committing takes
// today's terminal path; settlement wedged or rejected takes today's
// released-only path. A redelivery that still finds the attempt pending with
// intent set skips the bot flow and re-runs bounded `failSync`: settling
// reaches the terminal path, a still-wedged settlement backs off, and an
// exhausted carrier still backs off instead of burying the row. Intent
// carriers never stamp `failed`, alert, or ack before `failSync` commits,
// and the marker holds class/code only, never provider text.
//
// Hermetic: in-memory event store, ledger, lock and bot doubles only. No
// database, queue or network. The store contract at the bottom pins the
// bounded `UPDATE ... WHERE terminal_reason IS NULL` shape with fake clients.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { botRefusalReason, terminalFailureReason } from "../src/jobs/queue-error";
import { BotTerminalError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  TxClient,
  UniqueLock,
} from "../src/jobs/types";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const now = () => new Date(NOW.getTime());
const EVENT_KEY = "e-intent";
const IDEMPOTENCY_KEY = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_TOKEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const SETTLE_WINDOW_MS = 10_000;
const MIN_BOUND_MS = 1_500;

type BotMode = "refusal" | "terminal" | "ok" | "throw";
type FailSyncMode = "ok" | "reject" | "hang";

const refusal: BotFailure = {
  ok: false,
  code: "action_not_allowed",
  status: 403,
  requestId: "r1",
  message: "flag off with provider-only detail",
  retryable: false,
  retryAfterSeconds: null,
};

function attemptFor(
  eventKey: string,
  idempotencyKey: string,
  over: { requestAttempts?: number; intentReason?: string | null } = {},
): SyncAttempt {
  const base: SyncAttempt = {
    idempotencyKey,
    eventKey,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00.000Z"),
    state: "pending",
    requestAttempts: over.requestAttempts ?? 0,
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
  if (over.intentReason !== undefined && over.intentReason !== null) {
    // The pending row carries the marker; the builder maps the
    // `terminal_reason` column onto this field. Both spellings are set so
    // the redelivery skip works whichever the builder reads.
    return {
      ...base,
      ...({
        terminalReason: over.intentReason,
        terminal_reason: over.intentReason,
      } as unknown as Partial<SyncAttempt>),
    } as SyncAttempt;
  }
  return base;
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
    failSyncMode?: FailSyncMode;
    intentReason?: string | null;
    requestAttempts?: number;
  } = {},
) {
  const order: string[] = [];
  const rows = new Map<string, { state: string; availableAt?: Date; reason?: string }>();
  const seed = (jobId: string) => rows.set(jobId, { state: "pending" });
  seed(JOB_ID);

  const answerFor = (mode: BotMode) => async () => {
    if (mode === "refusal") return refusal;
    if (mode === "terminal") throw new BotTerminalError("bot misconfigured with secret detail");
    if (mode === "throw") throw new Error("unexpected bot failure");
    return { ok: true as const, requestId: "r1", discordEventId: "d1" };
  };
  const upsertEvent = vi.fn(async () => answerFor(opts.botMode ?? "refusal")());
  const bot = {
    upsertEvent,
    cancelEvent: vi.fn(answerFor(opts.botMode ?? "refusal")),
    postAnnouncement: vi.fn(),
    assignRole: vi.fn(),
  } as unknown as BotClient;

  const failSync = vi.fn((_idempotencyKey: string) => {
    order.push("events.failSync");
    const mode = opts.failSyncMode ?? "ok";
    if (mode === "hang") return new Promise<void>(() => {});
    if (mode === "reject") return Promise.reject(new Error("settlement store unavailable"));
    return Promise.resolve();
  });
  const noteTerminalIntent = vi.fn((idempotencyKey: string, _reason: string) => {
    order.push("events.noteTerminalIntent");
    return Promise.resolve();
  });
  const completeSync = vi.fn(() => Promise.resolve());
  const deferSync = vi.fn(() => Promise.resolve());
  const eventsRaw = {
    prepareSync: vi.fn(async (eventKey: string, key: string) =>
      attemptFor(eventKey, key, {
        requestAttempts: opts.requestAttempts ?? 0,
        intentReason: opts.intentReason ?? null,
      }),
    ),
    claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
    completeSync,
    deferSync,
    failSync,
    noteTerminalIntent,
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
  const events = eventsRaw as unknown as EventStore;

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
    upsertEvent,
    failSync,
    noteTerminalIntent,
    completeSync,
    deferSync,
    eventsRaw,
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

describe("definitive intent marking", () => {
  it.each([
    ["a non-retryable bot refusal", "refusal"],
    ["a terminal bot error", "terminal"],
  ] as const)(
    "definitive %s with settling failSync notes intent first, then settles terminal",
    async (_label, botMode) => {
      const s = setup({ botMode, failSyncMode: "ok" });
      const m = s.message(carrier());

      await consume({ messages: [m] }, s.deps);

      // Intent is recorded before the existing settlement race runs.
      expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
      expect(s.noteTerminalIntent).toHaveBeenCalledWith(IDEMPOTENCY_KEY, expect.any(String));
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      // Today's terminal path, exactly once each.
      expect(s.ledger.failed).toHaveBeenCalledTimes(1);
      expect(failingAlerts()).toHaveLength(1);
      expect(m.ack).toHaveBeenCalledExactlyOnceWith();
      expect(m.retry).not.toHaveBeenCalled();
      expect(s.ledger.released).not.toHaveBeenCalled();
      expect(s.ledger.dequeued).not.toHaveBeenCalled();
      expect(s.rows.get(JOB_ID)?.state).toBe("failed");
      expect(s.order).toEqual([
        "ledger.reserved",
        "events.noteTerminalIntent",
        "events.failSync",
        "ledger.failed",
        "lock.release",
        "message.ack",
      ]);
      expect(s.lock.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["a non-retryable bot refusal", "refusal"],
    ["a terminal bot error", "terminal"],
  ] as const)(
    "definitive %s with wedged failSync keeps intent and takes the released-only path",
    async (_label, botMode) => {
      const s = setup({ botMode, failSyncMode: "hang" });
      const m = s.message(carrier());

      const started = Date.now();
      const outcome = await outcomeWithin(consume({ messages: [m] }, s.deps), SETTLE_WINDOW_MS);
      const elapsed = Date.now() - started;

      expect(outcome).toBe("resolved");
      expect(elapsed).toBeGreaterThanOrEqual(MIN_BOUND_MS);
      // Intent is still recorded even though settlement never commits.
      expect(s.noteTerminalIntent).toHaveBeenCalledExactlyOnceWith(
        IDEMPOTENCY_KEY,
        expect.any(String),
      );
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      // Today's released-only path: released + undelayed retry, never terminal.
      expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
      expect(m.retry).toHaveBeenCalledExactlyOnceWith();
      expect(m.ack).not.toHaveBeenCalled();
      expect(s.ledger.failed).not.toHaveBeenCalled();
      expect(s.ledger.dequeued).not.toHaveBeenCalled();
      expect(s.rows.get(JOB_ID)).toEqual({ state: "released", availableAt: NOW });
      expect(failingAlerts()).toEqual([]);
      expect(s.lock.release).not.toHaveBeenCalled();
      expect(s.completeSync).not.toHaveBeenCalled();
      expect(s.order).toEqual([
        "ledger.reserved",
        "events.noteTerminalIntent",
        "events.failSync",
        "ledger.released",
        "message.retry",
      ]);
    },
  );
});

describe("settlement-only redelivery", () => {
  it("redelivery with intent and a now-settling failSync reaches the terminal path without the bot", async () => {
    const intent = botRefusalReason("event.upsert", "action_not_allowed");
    const s = setup({ botMode: "ok", failSyncMode: "ok", intentReason: intent });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    // The bot flow is skipped: no second bot call, no local completion.
    expect(s.upsertEvent).not.toHaveBeenCalled();
    expect(s.completeSync).not.toHaveBeenCalled();
    expect(s.deferSync).not.toHaveBeenCalled();
    // Settlement runs again and commits to today's terminal path.
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.failed).toHaveBeenCalledTimes(1);
    expect(failingAlerts()).toHaveLength(1);
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(m.retry).not.toHaveBeenCalled();
    expect(s.ledger.released).not.toHaveBeenCalled();
    expect(s.lock.release).toHaveBeenCalledTimes(1);
  });

  it("redelivery with intent and a still-wedged failSync backs off silently", async () => {
    const intent = botRefusalReason("event.upsert", "action_not_allowed");
    const s = setup({ botMode: "ok", failSyncMode: "reject", intentReason: intent });
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    const expectedDelay = backoffFor(SYNC_EVENT.backoffSeconds, 1);
    const expectedAt = new Date(NOW.getTime() + expectedDelay * 1000);

    expect(s.upsertEvent).not.toHaveBeenCalled();
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    // Backoff retry, still silent: no failed stamp, alert, or ack before commit.
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, expectedAt);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: expectedDelay });
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
    expect(s.lock.release).not.toHaveBeenCalled();
    expect(s.rows.get(JOB_ID)).toEqual({ state: "released", availableAt: expectedAt });
  });

  it("exhausted intent carrier with wedged settlement still backs off instead of failing", async () => {
    const intent = terminalFailureReason();
    // Carrier attempts exhausted (6 of 6) while the request keeps one attempt
    // spare: both back off to the held last value, so the expectation holds
    // whichever count the redelivery delay is keyed on.
    const s = setup({
      botMode: "throw",
      failSyncMode: "reject",
      intentReason: intent,
      requestAttempts: 5,
    });
    const m = s.message(carrier(), SYNC_EVENT.tries);

    await consume({ messages: [m] }, s.deps);

    const expectedDelay = backoffFor(SYNC_EVENT.backoffSeconds, SYNC_EVENT.tries);
    const expectedAt = new Date(NOW.getTime() + expectedDelay * 1000);

    // Exhaustion must not bury the row or ack it: the attempt is still
    // unsettled, so the carrier goes back on the queue with a backoff delay.
    expect(s.upsertEvent).not.toHaveBeenCalled();
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, expectedAt);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: expectedDelay });
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
    expect(s.lock.release).not.toHaveBeenCalled();
  });
});

describe("terminal reason hygiene", () => {
  it("refusal intent carries the classified code, never provider text", async () => {
    const s = setup({ botMode: "refusal", failSyncMode: "ok" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
    const reason = s.noteTerminalIntent.mock.calls[0]?.[1] as unknown as string;
    expect(typeof reason).toBe("string");
    expect(reason).toContain("action_not_allowed");
    expect(reason).not.toContain("flag off with provider-only detail");
    // The helper output is the contract: class/code only. The job scope may
    // include the event key, so pin the shape, not the exact scope string.
    expect(reason.startsWith("The bot refused")).toBe(true);
    expect(reason).toContain(botRefusalReason("x", "action_not_allowed").split("`")[1] as string);
  });

  it("terminal-error intent carries the class, never the thrown message", async () => {
    const s = setup({ botMode: "terminal", failSyncMode: "ok" });
    const m = s.message(carrier());

    await consume({ messages: [m] }, s.deps);

    expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
    const reason = s.noteTerminalIntent.mock.calls[0]?.[1] as unknown as string;
    expect(reason).toBe(terminalFailureReason());
    expect(reason).not.toContain("bot misconfigured");
  });
});

describe("noteTerminalIntent store contract", () => {
  const reason = "The bot refused event.upsert with `action_not_allowed`";

  it("exposes a bounded first-writer-wins UPDATE on the pool path", async () => {
    const store = pgEventStore({} as never) as unknown as Record<string, unknown>;
    expect(typeof store["noteTerminalIntent"]).toBe("function");

    const poolCalls: string[] = [];
    const txCalls: string[] = [];
    let began = false;
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      txCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
      return Promise.resolve([]);
    }) as unknown as TxClient;
    const pool = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        poolCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
        return Promise.resolve([]);
      },
      {
        begin: async (fn: (tx: TxClient) => Promise<void>) => {
          began = true;
          await fn(tx);
        },
      },
    );

    await (
      pgEventStore(pool as never) as unknown as { noteTerminalIntent: Function }
    ).noteTerminalIntent(IDEMPOTENCY_KEY, reason);

    expect(began).toBe(true);
    expect(poolCalls).toEqual([]);
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]).toContain("set_config");
    expect(txCalls[0]).toContain("lock_timeout");
    expect(txCalls[0]).toContain("statement_timeout");
    expect(txCalls[1]).toContain("update event_sync_attempts");
    expect(txCalls[1]).toContain("terminal_reason");
    expect(txCalls[1]).toContain("terminal_reason is null");
    expect(txCalls[1]).toContain(IDEMPOTENCY_KEY);
    expect(txCalls[1]).toContain(reason);
    expect(txCalls[1]).toContain("state = 'pending'");
  });

  it("scopes the timeouts without a nested BEGIN on the transaction path", async () => {
    const calls: string[] = [];
    const txClient = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
      return Promise.resolve([]);
    }) as unknown as TxClient;

    await (
      pgEventStore(txClient) as unknown as { noteTerminalIntent: Function }
    ).noteTerminalIntent(IDEMPOTENCY_KEY, reason);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("set_config");
    expect(calls[1]).toContain("update event_sync_attempts");
    expect(calls[1]).toContain("terminal_reason is null");
  });
});
