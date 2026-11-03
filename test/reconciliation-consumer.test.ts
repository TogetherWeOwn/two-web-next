// Consumer stuck-intent and Echo-confirm pins (contract v2 §7.4/§11).
//
// The consumer records the same-key intent FIRST, then settles terminally:
// a record failure redelivers the same carrier instead of settling first
// and losing the operator row, and a missing store throws loudly for the
// same reason. Echo rows confirm only on bot-confirmed delivery — never at
// enqueue — and a rejecting confirm redelivers the same carrier. Hermetic:
// in-memory doubles, synthetic keys, no queue, no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { CALL_INTERNAL_ACTION } from "../src/jobs/constants";
import {
  stuckIntent,
  type ReconciliationStore,
  type StuckIntentRecord,
} from "../src/jobs/reconciliation";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const KEY = "11111111-1111-4111-8111-111111111111";
const EVENT_KEY = "evt-test-consumer-stuck";
const CHANNEL_KEY = "channel-test-consumer-stuck";

function msg(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() {
      r.acked = true;
    },
    retry(o?: { delaySeconds?: number }) {
      r.retried = o?.delaySeconds ?? "now";
    },
  });
}
const memLock = (): UniqueLock => ({ acquire: async () => "lease", release: async () => {} });
function memLedger() {
  const rows = new Map<string, { state: string; reason?: string }>();
  const ledger: QueueLedger = {
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending" }),
    reserved: async (id) => void rows.set(id, { state: "reserved" }),
    released: async (id) => void rows.set(id, { state: "released" }),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _k, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
  return { ledger, rows };
}
function memStore(): EventStore {
  return {
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
}

/** In-memory operator surface: records intents keyed by UUID, like Postgres. */
function memReconciliation() {
  const rows = new Map<string, StuckIntentRecord>();
  const now = new Date(1_700_000_000_000);
  const store: ReconciliationStore = {
    recordStuck: async (intent) => {
      const existing = rows.get(intent.idempotencyKey);
      const record: StuckIntentRecord = {
        ...intent,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastAttemptAt: now,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      rows.set(intent.idempotencyKey, record);
      return record;
    },
    listOpen: async () => [...rows.values()].filter((r) => !r.resolvedAt),
    listResolved: async () => [...rows.values()].filter((r) => !!r.resolvedAt),
    getStuck: async (key) => rows.get(key) ?? null,
    resolveStuck: async (key, resolution) => {
      const row = rows.get(key);
      if (!row || row.resolvedAt) return null;
      const resolved = {
        ...row,
        resolvedAt: now,
        resolvedBy: resolution.by,
        resolution: resolution.note,
      };
      rows.set(key, resolved);
      return resolved;
    },
  };
  return { store, rows };
}

function stuckSyncStore(): EventStore {
  // prepareSync returns null → handleSyncEvent resolves done... no. For the
  // consumer stuck path we need the handler to return {stuck}: drive it via
  // a needs_reconciliation bot answer on a pending claim.
  const attempt: SyncAttempt = {
    idempotencyKey: KEY,
    eventKey: EVENT_KEY,
    revision: 1,
    mirroredAt: new Date(1_000_000),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date(0),
    action: "event.upsert",
    payload: {
      eventKey: EVENT_KEY,
      name: "Synthetic",
      startsAt: "2026-10-01T12:00:00Z",
      endsAt: "2026-10-01T13:00:00Z",
      location: "Synthetic location",
      description: null,
    },
  };
  return {
    ...memStore(),
    prepareSync: async () => attempt,
    claimSync: async () => {
      attempt.requestAttempts++;
      attempt.nextAttemptAt = null;
      return attempt;
    },
  };
}

function needsReconciliationBot(): BotClient {
  const answer = {
    ok: false,
    code: "needs_reconciliation",
    status: 409,
    requestId: "req-1",
    message: "MESSAGE_SENTINEL",
    retryable: true,
    retryAfterSeconds: null,
  };
  return {
    postAnnouncement: async () => answer,
    assignRole: async () => answer,
    upsertEvent: async () => answer,
    cancelEvent: async () => answer,
  } as unknown as BotClient;
}

function capture() {
  const calls: unknown[][] = [];
  for (const method of ["error", "warn", "info"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("consumer stuck-intent settlement", () => {
  it("records the same-key intent, then acks terminally with a class-only reason", async () => {
    const calls = capture();
    const { store, rows } = memReconciliation();
    const { ledger, rows: ledgerRows } = memLedger();
    ledgerRows.set("j1", { state: "pending" });
    const m = msg({ kind: "sync-event", eventKey: EVENT_KEY, idempotencyKey: KEY, jobId: "j1" }, 1);
    await consume(
      { messages: [m] },
      {
        bot: needsReconciliationBot(),
        events: stuckSyncStore(),
        lock: memLock(),
        ledger,
        reconciliation: store,
      },
    );
    // Record-first: the operator row exists under the carrier key.
    expect(rows.get(KEY)).toMatchObject({
      idempotencyKey: KEY,
      verb: "event.upsert",
      subject: EVENT_KEY,
      lastCode: "needs_reconciliation",
    });
    // ... then terminal settlement: acked, failed ledger row, never retried.
    expect(m.acked).toBe(true);
    expect(m.retried).toBeUndefined();
    expect(ledgerRows.get("j1")).toMatchObject({
      state: "failed",
      reason: "stuck event.upsert for evt-test-consumer-stuck (last code needs_reconciliation)",
    });
    // Class-only: the ledger reason and logs name the verb, subject and code.
    const failed = calls.find(([label]) => label === "job failed");
    expect(failed?.[2]).toContain("stuck event.upsert");
    expect(JSON.stringify(calls)).not.toContain("MESSAGE_SENTINEL");
  });

  it("records an announcement stuck intent without settling any sync claim", async () => {
    const { store, rows } = memReconciliation();
    const { ledger, rows: ledgerRows } = memLedger();
    ledgerRows.set("j2", { state: "pending" });
    const m = msg(
      {
        kind: "announcement",
        idempotencyKey: KEY,
        action: { channelKey: CHANNEL_KEY, body: "b" },
        jobId: "j2",
      },
      1,
    );
    const failSync = vi.fn(async () => {});
    await consume(
      { messages: [m] },
      {
        bot: needsReconciliationBot(),
        events: { ...memStore(), failSync },
        lock: memLock(),
        ledger,
        reconciliation: store,
      },
    );
    expect(rows.get(KEY)).toMatchObject({ verb: "announcement.post", subject: CHANNEL_KEY });
    expect(failSync).not.toHaveBeenCalled();
    expect(m.acked).toBe(true);
    expect(ledgerRows.get("j2")?.state).toBe("failed");
  });

  it("throws to the transport when recording fails, instead of settling and losing the row", async () => {
    capture();
    const failing: ReconciliationStore = {
      ...memReconciliation().store,
      recordStuck: async () => {
        throw new Error("store down");
      },
    };
    const { ledger } = memLedger();
    const m = msg({ kind: "sync-event", eventKey: EVENT_KEY, idempotencyKey: KEY }, 1);
    // Record-first: the throw escapes consume unsettled, so the queue
    // transport redelivers the same carrier under the same key. Settle-first
    // would have acked and lost the operator row.
    await expect(
      consume(
        { messages: [m] },
        {
          bot: needsReconciliationBot(),
          events: stuckSyncStore(),
          lock: memLock(),
          ledger,
          reconciliation: failing,
        },
      ),
    ).rejects.toThrow("store down");
    expect(m.acked).toBe(false);
    expect(m.retried).toBeUndefined();
    expect(m.body).toMatchObject({ idempotencyKey: KEY });
  });

  it("throws loudly with no store wired instead of settling silently", async () => {
    capture();
    const { ledger } = memLedger();
    const m = msg({ kind: "sync-event", eventKey: EVENT_KEY, idempotencyKey: KEY }, 1);
    await expect(
      consume(
        { messages: [m] },
        { bot: needsReconciliationBot(), events: stuckSyncStore(), lock: memLock(), ledger },
      ),
    ).rejects.toThrow("reconciliation store missing");
    expect(m.acked).toBe(false);
  });
});

describe("consumer Echo confirm gating", () => {
  const announced = {
    kind: "announcement",
    idempotencyKey: KEY,
    action: { channelKey: CHANNEL_KEY, body: "echo body" },
    echoId: 42,
  };
  const okBot = {
    postAnnouncement: async () => ({
      ok: true,
      requestId: "req-1",
      messageId: "m1",
      replayed: false,
    }),
    assignRole: async () => ({ ok: true, requestId: null, outcome: "already_held" }),
    upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
    cancelEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
  } as unknown as BotClient;

  it("confirms the Echo row only on bot-confirmed delivery", async () => {
    const confirmed: number[] = [];
    const { ledger } = memLedger();
    const m = msg({ ...announced }, 1);
    await consume(
      { messages: [m] },
      {
        bot: okBot,
        events: memStore(),
        lock: memLock(),
        ledger,
        onAnnouncementConfirmed: async (echoId) => void confirmed.push(echoId),
      },
    );
    expect(confirmed).toEqual([42]);
    expect(m.acked).toBe(true);
  });

  it("never confirms without an echoId on the carrier", async () => {
    const confirmed: number[] = [];
    const { ledger } = memLedger();
    const m = msg(
      { kind: "announcement", idempotencyKey: KEY, action: { channelKey: CHANNEL_KEY, body: "b" } },
      1,
    );
    await consume(
      { messages: [m] },
      {
        bot: okBot,
        events: memStore(),
        lock: memLock(),
        ledger,
        onAnnouncementConfirmed: async (echoId) => void confirmed.push(echoId),
      },
    );
    expect(confirmed).toEqual([]);
    expect(m.acked).toBe(true);
  });

  it("redelivers the same carrier when the confirm rejects, within budget", async () => {
    const { ledger } = memLedger();
    const m = msg({ ...announced }, 1);
    await consume(
      { messages: [m] },
      {
        bot: okBot,
        events: memStore(),
        lock: memLock(),
        ledger,
        onAnnouncementConfirmed: async () => {
          throw new Error("confirm store down");
        },
      },
    );
    // Same carrier, same key, same echoId: the same-key re-post replays
    // instead of duplicating.
    expect(m.acked).toBe(false);
    expect(m.retried).toBeDefined();
    expect(m.body).toMatchObject({ idempotencyKey: KEY, echoId: 42 });
  });

  it("fails terminally when the confirm rejects past the announcement budget", async () => {
    const { ledger, rows } = memLedger();
    rows.set("j9", { state: "pending" });
    const m = msg({ ...announced, jobId: "j9" }, CALL_INTERNAL_ACTION.tries);
    await consume(
      { messages: [m] },
      {
        bot: okBot,
        events: memStore(),
        lock: memLock(),
        ledger,
        onAnnouncementConfirmed: async () => {
          throw new Error("confirm store down");
        },
      },
    );
    expect(m.acked).toBe(true);
    expect(rows.get("j9")).toMatchObject({
      state: "failed",
      reason: "announcement confirm unavailable",
    });
  });

  it("never claims delivery for a stuck announcement", async () => {
    const confirmed: number[] = [];
    const { store } = memReconciliation();
    const { ledger } = memLedger();
    const m = msg({ ...announced }, 1);
    await consume(
      { messages: [m] },
      {
        bot: needsReconciliationBot(),
        events: memStore(),
        lock: memLock(),
        ledger,
        reconciliation: store,
        onAnnouncementConfirmed: async (echoId) => void confirmed.push(echoId),
      },
    );
    expect(confirmed).toEqual([]);
    expect(m.acked).toBe(true);
  });
});

describe("stuckIntent member-visibility guard", () => {
  it("a stuck intent carries no body text a member surface could mistake for delivery", () => {
    const intent = stuckIntent({
      idempotencyKey: KEY,
      verb: "announcement.post",
      subject: CHANNEL_KEY,
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "req-1",
      attempts: 1,
    });
    const serialized = JSON.stringify(intent);
    expect(serialized).not.toMatch(/deliver|success|posted|sent/i);
  });
});
