// Policy pin for Parity §6 SyncEventToDiscord (TOG-11768).
//
// The queue binding and worker wiring belong to W13/PR #7 + TOG-10815; this
// file pins only the policy numbers the single tracked producer applies — 10 s
// debounce, 6 tries over the 10/60/300/900/3600 ladder, per-eventKey
// uniqueness and the terminal mirror-stamp contract — asserted against the
// `src/jobs/*` constants with a fake clock. Change a number here only
// together with a deliberate, reviewed parity decision.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMirrored } from "../src/admin/validation";
import { buildSyncMessage } from "../src/events/sync";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import { trackingQueue } from "../src/jobs/ledger";
import { dispatchSyncEvent, handleSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import type { BotClient, BotFailure, EventStore, QueueLedger, SyncAttempt, UniqueLock } from "../src/jobs/types";

const payload = { eventKey: "e1", name: "n", startsAt: "2026-10-01T12:00:00.000Z", endsAt: null, location: "l", description: null };
const fail = (o: Partial<BotFailure>): BotFailure => ({
  ok: false, code: "x", status: 503, requestId: null, message: "m", retryable: true, retryAfterSeconds: null, ...o,
});

/** TTL-aware lock: a held key absorbs redispatch until its expiry, like pgUniqueLock. */
function timeAwareLock(): UniqueLock & { rows: Map<string, { token: string; expiresAt: number }> } {
  const rows = new Map<string, { token: string; expiresAt: number }>();
  return {
    rows,
    acquire: async (k, ttlSeconds) => {
      const held = rows.get(k);
      if (held && held.expiresAt > Date.now()) return null;
      const token = crypto.randomUUID();
      rows.set(k, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
      return token;
    },
    release: async (k, token) => {
      if (rows.get(k)?.token === token) rows.delete(k);
    },
  };
}

function memLedger(): QueueLedger & { rows: Map<string, { state: string; availableAt?: Date }> } {
  const rows = new Map<string, { state: string; availableAt?: Date }>();
  return {
    rows,
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending", availableAt: j.availableAt }),
    reserved: async (id) => void rows.set(id, { ...rows.get(id), state: "reserved" } as never),
    released: async (id, at) => void rows.set(id, { ...rows.get(id), state: "released", availableAt: at } as never),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id) => void rows.set(id, { state: "failed" }),
  };
}

/** Request ledger double: `priorAttempts` request tries already spent before this carrier. */
function store(over: Partial<EventStore> = {}, priorAttempts = 0) {
  const stamped: { eventKey: string; discordEventId: string; mirroredAt: Date }[] = [];
  const events: EventStore = {
    prepareSync: async (eventKey, idempotencyKey, mirroredAt) => ({ eventKey, idempotencyKey, mirroredAt, revision: 1,
      state: "pending", requestAttempts: priorAttempts, nextAttemptAt: new Date(0), action: "event.upsert", payload: { ...payload, eventKey } }),
    claimSync: async (attempt) => ({ ...attempt, requestAttempts: attempt.requestAttempts + 1 }),
    deferSync: async () => {},
    completeSync: async (attempt, discordEventId) =>
      void stamped.push({ eventKey: attempt.eventKey, discordEventId, mirroredAt: attempt.mirroredAt }),
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
    ...over,
  };
  return { events, stamped };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("policy constants (Parity §6 SyncEventToDiscord)", () => {
  it("pins the legacy values on the jobs constants", () => {
    expect(SYNC_EVENT).toEqual({
      debounceSeconds: 10,
      uniqueForSeconds: 300,
      backoffSeconds: [10, 60, 300, 900, 3600],
      tries: 6,
    });
  });

  it("the backoff ladder holds at the last value", () => {
    for (let attempt = 1; attempt <= 9; attempt++) {
      const want = [10, 60, 300, 900, 3600][Math.min(attempt, 5) - 1]!;
      expect(backoffFor(SYNC_EVENT.backoffSeconds, attempt)).toBe(want);
    }
  });
});

describe("debounce window (fake clock)", () => {
  it("delays every dispatch 10 s, absorbs redispatch inside the uniqueness window, readmits after", async () => {
    const lock = timeAwareLock();
    const sent: { body: any; opts: any }[] = [];
    const ledger = memLedger();
    const queue = trackingQueue(
      { send: async (body: unknown, opts?: { delaySeconds?: number }) => void sent.push({ body, opts }) },
      ledger,
      () => new Date(),
    );

    expect(await dispatchSyncEvent(queue, lock, "e1")).toBe(true);
    expect(await dispatchSyncEvent(queue, lock, "e1")).toBe(false); // absorbed
    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts).toEqual({ delaySeconds: 10 });

    // The uniqueness lease spans the full window from dispatch time.
    expect(lock.rows.get(uniqueKey("e1"))!.expiresAt - Date.now()).toBe(SYNC_EVENT.uniqueForSeconds * 1000);
    // The ledger availability carries the same debounce delay.
    const jobId = sent[0]!.body.jobId as string;
    expect(ledger.rows.get(jobId)?.availableAt).toEqual(new Date(Date.now() + 10_000));

    // A different event is independent.
    expect(await dispatchSyncEvent(queue, lock, "e2")).toBe(true);
    expect(sent).toHaveLength(2);

    // Past the window the same key is admitted again.
    vi.advanceTimersByTime(SYNC_EVENT.uniqueForSeconds * 1000 + 1);
    expect(await dispatchSyncEvent(queue, lock, "e1")).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("publish and cancel write-backs share the same 10 s debounce; drafts enqueue nothing", async () => {
    const sent: { m: unknown; o?: { delaySeconds?: number } }[] = [];
    const queue = { send: async (m: unknown, o?: { delaySeconds?: number }) => void sent.push({ m, o }) };
    for (const status of ["published", "cancelled"] as const) {
      const message = buildSyncMessage("e1", status)!;
      // Fresh lock per status: the debounce, not uniqueness, is under test here.
      expect(await dispatchSyncEvent(queue, timeAwareLock(), message.eventKey, message.idempotencyKey)).toBe(true);
    }
    expect(sent.map((s) => s.o)).toEqual([{ delaySeconds: 10 }, { delaySeconds: 10 }]);
    expect(buildSyncMessage("e1", "draft")).toBeNull();
  });
});

describe("retry count and backoff ladder", () => {
  it("walks 10/60/300/900/3600 on transport failure, then fails on attempt 6", async () => {
    const bot = { upsertEvent: async () => { throw new BotTransportError("bot down"); } } as unknown as BotClient;
    for (const [attempt, delay] of [[1, 10], [2, 60], [3, 300], [4, 900], [5, 3600]] as const) {
      const deferred: (Date | null)[] = [];
      const s = store({ deferSync: async (_a, at) => void deferred.push(at) }, attempt - 1);
      const outcome = await handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, attempt, { bot, events: s.events });
      expect(outcome).toEqual({ retryInSeconds: delay });
      // The request ledger carries the same deadline the carrier waits for.
      expect(deferred).toEqual([new Date(Date.now() + delay * 1000)]);
      expect(s.stamped).toHaveLength(0); // a wait stamps nothing
    }
    const deferred: (Date | null)[] = [];
    const s = store({ deferSync: async (_a, at) => void deferred.push(at) }, 5);
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 6, { bot, events: s.events }))
      .resolves.toEqual({ failed: "carrier exhausted; unresolved identity retained" });
    expect(deferred).toEqual([null]); // exhausted: no further deadline
    expect(s.stamped).toHaveLength(0);
  });

  it("the bot's Retry-After beats the ladder; terminal answers fail now", async () => {
    let answer: BotFailure = fail({ retryAfterSeconds: 42 });
    const bot = { upsertEvent: async () => answer } as unknown as BotClient;
    const s = store();
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 1, { bot, events: s.events }))
      .resolves.toEqual({ retryInSeconds: 42 });

    answer = fail({ retryable: false, code: "action_not_allowed" });
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 1, { bot, events: s.events }))
      .resolves.toMatchObject({ definitive: true, failed: expect.stringContaining("action_not_allowed") });

    // Class-only (#233): a terminal throw fails with its class, never the
    // message (which can carry secrets) — so this pins "BotTerminalError".
    const terminal = { upsertEvent: async () => { throw new BotTerminalError("missing secret"); } } as unknown as BotClient;
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 1, { bot: terminal, events: s.events }))
      .resolves.toEqual({ failed: "BotTerminalError", definitive: true });
    expect(s.stamped).toHaveLength(0);
  });
});

describe("per-key uniqueness", () => {
  it("namespaces one lock per event key", () => {
    expect(uniqueKey("a")).toBe("sync-event:a");
    expect(uniqueKey("a")).toBe(uniqueKey("a"));
    expect(uniqueKey("a")).not.toBe(uniqueKey("b"));
  });

  it("acquires the lock on the namespaced key for the full uniqueness window", async () => {
    const sent: unknown[] = [];
    const lock = timeAwareLock();
    const acquire = vi.spyOn(lock, "acquire");
    const queue = { send: async (body: unknown) => void sent.push(body) };
    expect(await dispatchSyncEvent(queue, lock, "e1")).toBe(true);
    expect(acquire).toHaveBeenCalledWith(uniqueKey("e1"), SYNC_EVENT.uniqueForSeconds);
    expect(sent).toHaveLength(1);
  });
});

describe("mirrored recheck and terminal stamp", () => {
  it("only published and cancelled rows are mirrored", () => {
    expect(isMirrored("published")).toBe(true);
    expect(isMirrored("cancelled")).toBe(true);
    expect(isMirrored("draft")).toBe(false);
    expect(isMirrored("past")).toBe(false);
  });

  it("re-reads the row on every attempt: deleted, unmirrored or obsolete rows drop without a bot call or stamp", async () => {
    const upsertEvent = vi.fn(async () => ({ ok: true, requestId: null, discordEventId: "d1" }));
    const bot = { upsertEvent } as unknown as BotClient;
    // The store answers null for a deleted row and for a draft/past row alike.
    const prepareSync = vi.fn(async () => null);
    const gone = store({ prepareSync });
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 3, { bot, events: gone.events }))
      .resolves.toEqual({ done: true });
    expect(prepareSync).toHaveBeenCalledWith("e1", "k", expect.any(Date));
    expect(upsertEvent).not.toHaveBeenCalled();
    expect(gone.stamped).toHaveLength(0);

    // A snapshot retired by a newer revision on its first claim never calls out.
    const obsolete = store({ claimSync: async (attempt: SyncAttempt) => ({ ...attempt, state: "obsolete" as const }) });
    await expect(handleSyncEvent({ eventKey: "e1", idempotencyKey: "k" }, 1, { bot, events: obsolete.events }))
      .resolves.toEqual({ done: true });
    expect(upsertEvent).not.toHaveBeenCalled();
    expect(obsolete.stamped).toHaveLength(0);
  });

  it("success stamps the discord id and the fake-clock time, exactly once", async () => {
    const bot = { upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "discord-1" }) } as unknown as BotClient;
    const s = store();
    await expect(handleSyncEvent(
      { eventKey: "e1", idempotencyKey: "k" }, 1,
      { bot, events: s.events, now: () => new Date() },
    )).resolves.toEqual({ done: true });
    expect(s.stamped).toEqual([{ eventKey: "e1", discordEventId: "discord-1", mirroredAt: new Date("2026-10-01T12:00:00.000Z") }]);
  });
});
