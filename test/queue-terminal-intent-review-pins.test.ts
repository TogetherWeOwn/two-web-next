// Builder-owned unit pins for the terminal-intent review findings.
//
// The acceptance suite (Test Author-owned) drives the consumer through
// hermetic doubles that bypass the pgEventStore row builder, so these pins
// cover what it cannot see without editing its doubles: the attemptFrom
// terminal_reason mapping through fake-SQL prepareSync/pendingSync, the
// intent-before-budget order at the request-budget boundary, the
// failed-with-intent late-settlement redelivery, the rejecting intent-note
// race with claim reopen, and the past-budget distinct alert. Hermetic stub
// stores only; no database, queue or network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { handleSyncEvent } from "../src/jobs/sync-event";
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
const EVENT_KEY = "e-pin";
const IDEMPOTENCY_KEY = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_TOKEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTENT = "The bot refused event.upsert with `action_not_allowed`";

const refusal: BotFailure = {
  ok: false,
  code: "action_not_allowed",
  status: 403,
  requestId: "r1",
  message: "flag off with provider-only detail",
  retryable: false,
  retryAfterSeconds: null,
};

function pendingAttempt(
  over: {
    requestAttempts?: number;
    terminalReason?: string | null;
    state?: SyncAttempt["state"];
    nextAttemptAt?: Date | null;
  } = {},
): SyncAttempt {
  const attempt: SyncAttempt = {
    idempotencyKey: IDEMPOTENCY_KEY,
    eventKey: EVENT_KEY,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00.000Z"),
    state: over.state ?? "pending",
    requestAttempts: over.requestAttempts ?? 0,
    nextAttemptAt: over.nextAttemptAt ?? new Date("2026-10-01T11:00:00.000Z"),
    action: "event.upsert",
    payload: {
      eventKey: EVENT_KEY,
      name: "Game night",
      startsAt: "2026-10-01T13:00:00.000Z",
      endsAt: "2026-10-01T14:00:00.000Z",
      location: "Discord",
      description: null,
    },
  };
  // Only the builder spelling: the row mapping is the single path under test.
  if (over.terminalReason !== undefined) attempt.terminalReason = over.terminalReason;
  return attempt;
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

describe("attemptFrom terminal_reason mapping", () => {
  const dbRow = (terminalReason: string | null) => ({
    idempotency_key: IDEMPOTENCY_KEY,
    revision: 1,
    mirrored_at: new Date("2026-10-01T11:00:00.000Z"),
    state: "pending",
    request_attempts: 0,
    next_attempt_at: new Date("2026-10-01T11:00:00.000Z"),
    terminal_reason: terminalReason,
    discord_event_id: null,
    action: "event.upsert",
    payload: {
      eventKey: EVENT_KEY,
      name: "Game night",
      startsAt: "2026-10-01T13:00:00.000Z",
      endsAt: null,
      location: "Discord",
      description: null,
    },
  });

  // Shape-dispatched fake postgres client: the cached prepareSync SELECT and
  // the pendingSync SELECT answer the row; nothing else is queried here.
  const fakeSql = (row: ReturnType<typeof dbRow> | null) =>
    (async (strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (q.includes("from event_sync_attempts a join events")) return row ? [row] : [];
      return [];
    }) as never;

  it.each([[INTENT], [null]] as const)(
    "prepareSync surfaces terminal_reason %j as terminalReason",
    async (terminalReason) => {
      const store = pgEventStore(fakeSql(dbRow(terminalReason)));
      const got = await store.prepareSync(EVENT_KEY, IDEMPOTENCY_KEY, now());
      expect(got).not.toBeNull();
      if (got && !("waiting" in got)) expect(got.terminalReason).toBe(terminalReason);
      else throw new Error("expected a cached attempt");
    },
  );

  it.each([[INTENT], [null]] as const)(
    "pendingSync surfaces terminal_reason %j as terminalReason",
    async (terminalReason) => {
      const store = pgEventStore(fakeSql(dbRow(terminalReason)));
      const got = await store.pendingSync(EVENT_KEY);
      expect(got?.terminalReason).toBe(terminalReason);
    },
  );
});

describe("intent-before-budget order", () => {
  const stubEvents = (prepared: SyncAttempt) =>
    ({
      prepareSync: vi.fn(async () => prepared),
      claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
      completeSync: vi.fn(async () => {}),
      deferSync: vi.fn(async () => {}),
      failSync: vi.fn(async () => {}),
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    }) as unknown as EventStore;

  const stubBot = () =>
    ({
      upsertEvent: vi.fn(async () => refusal),
      cancelEvent: vi.fn(async () => refusal),
      postAnnouncement: vi.fn(),
      assignRole: vi.fn(),
    }) as unknown as BotClient;

  it("intent with requestAttempts at the budget still returns the stored reason", async () => {
    const bot = stubBot();
    const outcome = await handleSyncEvent(
      { eventKey: EVENT_KEY, idempotencyKey: IDEMPOTENCY_KEY },
      1,
      {
        bot,
        events: stubEvents(
          pendingAttempt({ requestAttempts: SYNC_EVENT.tries, terminalReason: INTENT }),
        ),
      },
    );
    expect(bot.upsertEvent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ failed: INTENT, definitive: true });
    expect((outcome as { failed?: string }).failed).not.toContain("budget exhausted");
    expect(
      (outcome as { intentRedeliveryBackoffSeconds?: number }).intentRedeliveryBackoffSeconds,
    ).toBe(backoffFor(SYNC_EVENT.backoffSeconds, SYNC_EVENT.tries));
  });

  it("a failed row carrying intent returns the stored reason for the terminal path", async () => {
    const bot = stubBot();
    const outcome = await handleSyncEvent(
      { eventKey: EVENT_KEY, idempotencyKey: IDEMPOTENCY_KEY },
      1,
      { bot, events: stubEvents(pendingAttempt({ state: "failed", terminalReason: INTENT })) },
    );
    expect(bot.upsertEvent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ failed: INTENT, definitive: true });
    expect(
      (outcome as { intentRedeliveryBackoffSeconds?: number }).intentRedeliveryBackoffSeconds,
    ).toBe(backoffFor(SYNC_EVENT.backoffSeconds, 1));
  });

  it.each([
    ["failed", "failed"],
    ["succeeded", "succeeded"],
  ] as const)("a %s row without intent stays done", async (_label, state) => {
    const bot = stubBot();
    const outcome = await handleSyncEvent(
      { eventKey: EVENT_KEY, idempotencyKey: IDEMPOTENCY_KEY },
      1,
      { bot, events: stubEvents(pendingAttempt({ state })) },
    );
    expect(outcome).toEqual({ done: true });
    expect(bot.upsertEvent).not.toHaveBeenCalled();
  });
});

describe("failed intent note with claim reopen", () => {
  type NoteMode = "ok" | "reject" | "hang";
  type FailMode = "ok" | "reject";

  function setup() {
    const modes = { note: "ok" as NoteMode, fail: "ok" as FailMode };
    let prepared: SyncAttempt = pendingAttempt({ requestAttempts: 1 });
    const upsertEvent = vi.fn(async () => refusal);
    const bot = {
      upsertEvent,
      cancelEvent: vi.fn(async () => refusal),
      postAnnouncement: vi.fn(),
      assignRole: vi.fn(),
    } as unknown as BotClient;
    const failSync = vi.fn(async (_key: string) => {
      if (modes.fail === "reject") throw new Error("settlement store unavailable");
    });
    const noteTerminalIntent = vi.fn(async (_key: string, _reason: string) => {
      if (modes.note === "hang") await new Promise<void>(() => {});
      if (modes.note === "reject") throw new Error("intent store unavailable");
    });
    const pendingSync = vi.fn(async (_eventKey: string) => prepared);
    const deferSync = vi.fn(async (_attempt: SyncAttempt, _at: Date | null) => {});
    const events = {
      prepareSync: vi.fn(async () => prepared),
      claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
      completeSync: vi.fn(async () => {}),
      deferSync,
      failSync,
      noteTerminalIntent,
      needsSync: async () => false,
      pendingSync,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    } as unknown as EventStore;
    const ledger = {
      enqueued: vi.fn(async () => {}),
      reserved: vi.fn(async (_jobId: string) => {}),
      released: vi.fn(async (_jobId: string, _at: Date) => {}),
      dequeued: vi.fn(async (_jobId: string) => {}),
      failed: vi.fn(async (_jobId: string, _k: string, _key: string | null, _r: string) => {}),
    } as unknown as QueueLedger;
    const lock = {
      acquire: vi.fn(async () => LEASE_TOKEN),
      release: vi.fn(async () => {}),
    } as unknown as UniqueLock;
    const message = (body: unknown, attempts = 1) => ({
      body,
      attempts,
      ack: vi.fn(() => {}),
      retry: vi.fn((_o?: { delaySeconds?: number }) => {}),
    });
    return {
      modes,
      setPrepared: (attempt: SyncAttempt) => {
        prepared = attempt;
      },
      upsertEvent,
      failSync,
      noteTerminalIntent,
      pendingSync,
      deferSync,
      ledger,
      lock,
      message,
      deps: { bot, events, ledger, lock, now },
    };
  }

  it("note reject plus wedged settlement reopens the claim and retries released-only", async () => {
    const s = setup();
    s.modes.note = "reject";
    s.modes.fail = "reject";
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    // Settlement still ran; both store writes failed, so the released-only
    // path holds the row without any terminal effect.
    expect(s.noteTerminalIntent).toHaveBeenCalledExactlyOnceWith(
      IDEMPOTENCY_KEY,
      expect.any(String),
    );
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    // The claim reopened to a due deadline so a healed redelivery re-derives.
    expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
    expect(s.deferSync).toHaveBeenCalledOnce();
    const reopenedAt = s.deferSync.mock.calls[0]?.[1] as Date;
    expect(reopenedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
  });

  it("note reject with committing settlement still reaches the terminal path", async () => {
    const s = setup();
    s.modes.note = "reject";
    s.modes.fail = "ok";
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.failed).toHaveBeenCalledTimes(1);
    expect(failingAlerts()).toHaveLength(1);
    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
  });

  it("a healed redelivery after a failed note settles terminally exactly once", async () => {
    const s = setup();
    s.modes.note = "reject";
    s.modes.fail = "reject";
    await consume({ messages: [s.message(carrier(), 1)] }, s.deps);
    expect(s.ledger.failed).not.toHaveBeenCalled();

    // The store heals: the reopened due claim re-runs the bot flow,
    // re-derives the refusal, re-notes and settles.
    s.modes.note = "ok";
    s.modes.fail = "ok";
    s.setPrepared(pendingAttempt({ requestAttempts: 2 }));
    const m2 = s.message(carrier(), 2);
    await consume({ messages: [m2] }, s.deps);

    // The bot ran on both deliveries (re-derivation), settlement committed
    // once, and the terminal effects landed exactly once.
    expect(s.upsertEvent).toHaveBeenCalledTimes(2);
    expect(s.failSync).toHaveBeenCalledTimes(2);
    expect(s.ledger.failed).toHaveBeenCalledTimes(1);
    expect(failingAlerts()).toHaveLength(1);
    expect(m2.ack).toHaveBeenCalledExactlyOnceWith();
  });

  it("a hung intent note resolves through the rejecting race and reopens", async () => {
    const s = setup();
    s.modes.note = "hang";
    s.modes.fail = "reject";
    const started = Date.now();
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    // The batch was never held hostage: the rejecting race gave up the wait.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
    expect(s.deferSync).toHaveBeenCalledOnce();
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
  });
});

describe("past-budget distinct alert", () => {
  function setupIntentRedelivery(attempts: number) {
    const upsertEvent = vi.fn(async () => refusal);
    const bot = {
      upsertEvent,
      cancelEvent: vi.fn(async () => refusal),
      postAnnouncement: vi.fn(),
      assignRole: vi.fn(),
    } as unknown as BotClient;
    const failSync = vi.fn(async (_key: string) => {
      throw new Error("settlement store unavailable");
    });
    const events = {
      prepareSync: vi.fn(async () =>
        pendingAttempt({ requestAttempts: SYNC_EVENT.tries - 1, terminalReason: INTENT }),
      ),
      claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
      completeSync: vi.fn(async () => {}),
      deferSync: vi.fn(async () => {}),
      failSync,
      noteTerminalIntent: vi.fn(async () => {}),
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    } as unknown as EventStore;
    const ledger = {
      enqueued: vi.fn(async () => {}),
      reserved: vi.fn(async (_jobId: string) => {}),
      released: vi.fn(async (_jobId: string, _at: Date) => {}),
      dequeued: vi.fn(async (_jobId: string) => {}),
      failed: vi.fn(async (_jobId: string, _k: string, _key: string | null, _r: string) => {}),
    } as unknown as QueueLedger;
    const lock = {
      acquire: vi.fn(async () => LEASE_TOKEN),
      release: vi.fn(async () => {}),
    } as unknown as UniqueLock;
    const m = {
      body: carrier(),
      attempts,
      ack: vi.fn(() => {}),
      retry: vi.fn((_o?: { delaySeconds?: number }) => {}),
    };
    return { upsertEvent, failSync, ledger, message: m, deps: { bot, events, ledger, lock, now } };
  }

  it("past the carrier budget an unsettled intent redelivery alerts distinctly without burying or acking", async () => {
    const s = setupIntentRedelivery(SYNC_EVENT.tries + 1);
    const expectedDelay = backoffFor(SYNC_EVENT.backoffSeconds, SYNC_EVENT.tries + 1);
    const expectedAt = new Date(NOW.getTime() + expectedDelay * 1000);

    await consume({ messages: [s.message] }, s.deps);

    expect(s.upsertEvent).not.toHaveBeenCalled();
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, expectedAt);
    expect(s.message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: expectedDelay });
    const alerts = failingAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("terminal settlement unavailable");
    expect(alerts[0]).not.toContain(INTENT);
    // Still no failed stamp and no ack before settlement commits.
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.ledger.dequeued).not.toHaveBeenCalled();
    expect(s.message.ack).not.toHaveBeenCalled();
  });

  it("at the carrier budget an unsettled intent redelivery stays silent", async () => {
    const s = setupIntentRedelivery(SYNC_EVENT.tries);

    await consume({ messages: [s.message] }, s.deps);

    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.message.retry).toHaveBeenCalledOnce();
    expect(failingAlerts()).toEqual([]);
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(s.message.ack).not.toHaveBeenCalled();
  });
});
