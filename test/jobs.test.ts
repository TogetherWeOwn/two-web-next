import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CALL_INTERNAL_ACTION,
  PRUNE_CRON,
  RECONCILE_CRON,
  SYNC_EVENT,
} from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { reconcileEvents, runScheduled, type SingleFlight } from "../src/jobs/cron";
import { trackingQueue } from "../src/jobs/ledger";
import { dispatchSyncEvent, handleSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import { BotTransportError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  TxClient,
  UniqueLock,
} from "../src/jobs/types";

const payload = {
  eventKey: "e1",
  name: "n",
  startsAt: "s",
  endsAt: null,
  location: "l",
  description: null,
};
const leaseToken = "11111111-1111-4111-8111-111111111111";
const fail = (o: Partial<BotFailure>): BotFailure => ({
  ok: false,
  code: "x",
  status: 503,
  requestId: null,
  message: "m",
  retryable: true,
  retryAfterSeconds: null,
  ...o,
});

function memLock(): UniqueLock & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    acquire: async (k) => (held.has(k) ? null : (held.add(k), leaseToken)),
    release: async (k, token) => {
      if (token === leaseToken) held.delete(k);
    },
  };
}
function memLedger(): QueueLedger & {
  rows: Map<string, { state: string; availableAt?: Date; reason?: string }>;
} {
  const rows = new Map<string, { state: string; availableAt?: Date; reason?: string }>();
  return {
    rows,
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending", availableAt: j.availableAt }),
    reserved: async (id) => void rows.set(id, { ...rows.get(id), state: "reserved" } as never),
    released: async (id, at) =>
      void rows.set(id, { ...rows.get(id), state: "released", availableAt: at } as never),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _kind, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
}
function store(over: Partial<EventStore> = {}): EventStore & { mirrored: string[] } {
  const mirrored: string[] = [];
  return {
    mirrored,
    prepareSync: async (_eventKey, idempotencyKey, mirroredAt) => ({
      eventKey: "e1",
      idempotencyKey,
      mirroredAt,
      revision: 1,
      state: "pending",
      requestAttempts: 0,
      nextAttemptAt: new Date(0),
      action: "event.upsert",
      payload,
    }),
    claimSync: async (attempt) => ({ ...attempt, requestAttempts: attempt.requestAttempts + 1 }),
    deferSync: async () => {},
    completeSync: async (_attempt, id) => void mirrored.push(id),
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
    ...over,
  };
}
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
const noBot = {} as BotClient;

describe("retry constants match the Laravel originals (two-web @ 3965a6e8)", () => {
  it("SyncEventToDiscord", () => {
    expect(SYNC_EVENT).toEqual({
      debounceSeconds: 10,
      uniqueForSeconds: 300,
      backoffSeconds: [10, 60, 300, 900, 3600],
      tries: 6,
    });
  });
  it("CallInternalAction", () => {
    expect(CALL_INTERNAL_ACTION).toEqual({ tries: 5, backoffSeconds: [5, 15, 60, 180] });
  });
  it("wrangler cron triggers are the pinned expressions", () => {
    const cfg = readFileSync("wrangler.jsonc", "utf8");
    expect(cfg).toContain(`"crons": ["${RECONCILE_CRON}", "${PRUNE_CRON}"]`);
  });
});

describe("SyncEventToDiscord", () => {
  it("dispatch debounces, is unique, and keeps one idempotency key", async () => {
    const sent: { body: any; o: any }[] = [];
    const q = { send: async (body: unknown, o?: unknown) => void sent.push({ body, o }) };
    const lock = memLock();
    expect(await dispatchSyncEvent(q, lock, "e1")).toBe(true);
    expect(await dispatchSyncEvent(q, lock, "e1")).toBe(false); // absorbed
    expect(sent).toHaveLength(1);
    expect(sent[0]!.o).toEqual({ delaySeconds: 10 });
    expect(sent[0]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("walks the backoff, then fails on attempt 6", async () => {
    const bot = {
      upsertEvent: async () => {
        throw new BotTransportError("down");
      },
    } as unknown as BotClient;
    const lock = memLock();
    for (const [attempt, delay] of [
      [1, 10],
      [2, 60],
      [3, 300],
      [4, 900],
      [5, 3600],
    ] as const) {
      const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, attempt);
      await consume({ messages: [m] }, { bot, events: store(), lock, ledger: memLedger() });
      expect(m.retried).toBe(delay);
      expect(m.acked).toBe(false);
    }
    const last = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", leaseToken }, 6);
    lock.held.add(uniqueKey("e1"));
    await consume({ messages: [last] }, { bot, events: store(), lock, ledger: memLedger() });
    expect(last.acked).toBe(true);
    expect(lock.held.has(uniqueKey("e1"))).toBe(false); // lock freed on terminal outcome
  });

  it("bot Retry-After beats the backoff; terminal refusal fails now", async () => {
    let answer: BotFailure = fail({ retryAfterSeconds: 42 });
    const bot = { upsertEvent: async () => answer } as unknown as BotClient;
    const a = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, 1);
    await consume(
      { messages: [a] },
      { bot, events: store(), lock: memLock(), ledger: memLedger() },
    );
    expect(a.retried).toBe(42);
    answer = fail({ retryable: false, code: "action_not_allowed" });
    const b = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, 1);
    await consume(
      { messages: [b] },
      { bot, events: store(), lock: memLock(), ledger: memLedger() },
    );
    expect(b.acked).toBe(true);
    expect(b.retried).toBeUndefined();
  });

  for (const exhausted of [false, true]) {
    it(`retries a failed explicit deadline write unchanged, including the exhausted null deadline (${exhausted})`, async () => {
      const start = 1_000_000;
      let clock = start;
      const error = new Error("retry deadline unavailable");
      const deferSync = vi
        .fn<EventStore["deferSync"]>()
        .mockImplementationOnce(async () => {
          clock += 5000;
          throw error;
        })
        .mockResolvedValue(undefined);
      const events = store({
        deferSync,
        claimSync: async (attempt) => ({ ...attempt, requestAttempts: exhausted ? 6 : 1 }),
      });
      const bot = {
        upsertEvent: vi.fn(async () => fail({ retryAfterSeconds: 42 })),
      } as unknown as BotClient;
      await expect(
        handleSyncEvent({ eventKey: "e1", idempotencyKey: "same-key" }, 1, {
          bot,
          events,
          now: () => new Date(clock),
        }),
      ).rejects.toBe(error);
      const deadline = exhausted ? null : new Date(start + 42_000);
      expect(deferSync.mock.calls.map(([, at]) => at)).toEqual([deadline, deadline]);
      expect(
        deferSync.mock.calls.map(([attempt]) => ({
          key: attempt.idempotencyKey,
          requests: attempt.requestAttempts,
        })),
      ).toEqual(Array(2).fill({ key: "same-key", requests: exhausted ? 6 : 1 }));
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(events.mirrored).toEqual([]);
    });
  }

  for (const exhausted of [false, true]) {
    it(`carries the known absolute wait after two failed writes without renewing an exhausted request (${exhausted})`, async () => {
      const start = 1_000_000;
      let clock = start;
      const error = new Error("retry result unavailable");
      const deferSync = vi.fn<EventStore["deferSync"]>().mockImplementation(async () => {
        clock += 5000;
        throw error;
      });
      const events = store({
        deferSync,
        claimSync: async (attempt) => ({
          ...attempt,
          requestAttempts: exhausted ? 6 : 1,
          nextAttemptAt: null,
        }),
      });
      const bot = {
        upsertEvent: vi.fn(async () => fail({ retryAfterSeconds: 42 })),
      } as unknown as BotClient;
      const carrier = msg({
        kind: "sync-event",
        eventKey: "e1",
        idempotencyKey: "same-key",
        jobId: "job",
      });
      const ledger = memLedger();
      await consume(
        { messages: [carrier] },
        { bot, events, ledger, lock: memLock(), now: () => new Date(clock) },
      );
      expect(deferSync.mock.calls.map(([, at]) => at)).toEqual(
        Array(2).fill(exhausted ? null : new Date(start + 42_000)),
      );
      expect(
        deferSync.mock.calls.map(([attempt]) => ({
          key: attempt.idempotencyKey,
          requests: attempt.requestAttempts,
        })),
      ).toEqual(Array(2).fill({ key: "same-key", requests: exhausted ? 6 : 1 }));
      expect(carrier.retried).toBe(exhausted ? undefined : 32);
      expect(carrier.acked).toBe(exhausted);
      expect(ledger.rows.get("job")!.state).toBe(exhausted ? "failed" : "released");
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(events.mirrored).toEqual([]);
    });
  }

  it("duplicate delivery reuses the key and replays the original answer, mirroring once", async () => {
    const seen = new Map<string, string>();
    let created = 0;
    const bot = {
      upsertEvent: async (_p: unknown, key: string) => {
        if (!seen.has(key)) seen.set(key, `discord-${++created}`);
        return { ok: true, requestId: null, discordEventId: seen.get(key)! };
      },
    } as unknown as BotClient;
    const s = store();
    const body = { kind: "sync-event", eventKey: "e1", idempotencyKey: "same-key" };
    await consume(
      { messages: [msg(body), msg(body, 2)] },
      { bot, events: s, lock: memLock(), ledger: memLedger() },
    );
    expect(created).toBe(1);
    expect(s.mirrored).toEqual(["discord-1", "discord-1"]);
  });

  it("drops deleted and unmirrored events without calling the bot", async () => {
    const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" });
    const m2 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" });
    await consume(
      { messages: [m1] },
      {
        bot: noBot,
        events: store({ prepareSync: async () => null }),
        lock: memLock(),
        ledger: memLedger(),
      },
    );
    await consume(
      { messages: [m2] },
      {
        bot: noBot,
        events: store({ prepareSync: async () => null }),
        lock: memLock(),
        ledger: memLedger(),
      },
    );
    expect(m1.acked && m2.acked).toBe(true);
  });
});

describe("CallInternalAction", () => {
  const ann = { kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } };
  it("walks 5/15/60/180 then fails on attempt 5", async () => {
    const bot = { postAnnouncement: async () => fail({}) } as unknown as BotClient;
    for (const [attempt, delay] of [
      [1, 5],
      [2, 15],
      [3, 60],
      [4, 180],
    ] as const) {
      const m = msg(ann, attempt);
      await consume(
        { messages: [m] },
        { bot, events: store(), lock: memLock(), ledger: memLedger() },
      );
      expect(m.retried).toBe(delay);
    }
    const last = msg(ann, 5);
    await consume(
      { messages: [last] },
      { bot, events: store(), lock: memLock(), ledger: memLedger() },
    );
    expect(last.acked).toBe(true);
    expect(last.retried).toBeUndefined();
  });

  it("redelivered announcement carries the same key and replays", async () => {
    const seen = new Map<string, number>();
    const bot = {
      postAnnouncement: async (_a: unknown, key: string) => {
        const replayed = seen.has(key);
        seen.set(key, (seen.get(key) ?? 0) + 1);
        return { ok: true, requestId: null, messageId: "m1", replayed };
      },
    } as unknown as BotClient;
    await consume(
      { messages: [msg(ann), msg(ann, 2)] },
      { bot, events: store(), lock: memLock(), ledger: memLedger() },
    );
    expect(seen.get("k")).toBe(2);
  });

  it("role.assign sends no key", async () => {
    let called = 0;
    const bot = {
      assignRole: async () => (called++, { ok: true, requestId: null, outcome: "already_held" }),
    } as unknown as BotClient;
    const m = msg({
      kind: "role-assign",
      idempotencyKey: null,
      action: { userId: "u", roleKey: "r" },
    });
    await consume(
      { messages: [m] },
      { bot, events: store(), lock: memLock(), ledger: memLedger() },
    );
    expect(called).toBe(1);
    expect(m.acked).toBe(true);
  });
});

describe("queue ledger (N3)", () => {
  it("tracks reserved -> dequeued on done, and reserved -> failed on terminal failure", async () => {
    const bot = {
      upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
    } as unknown as BotClient;
    const ledger = memLedger();
    await consume(
      { messages: [msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j1" })] },
      { bot, events: store(), lock: memLock(), ledger },
    );
    expect(ledger.rows.has("j1")).toBe(false); // dequeued on terminal success

    const bad = {
      postAnnouncement: async () => fail({ retryable: false, code: "action_not_allowed" }),
    } as unknown as BotClient;
    const ledger2 = memLedger();
    ledger2.rows.set("j2", { state: "pending" });
    await consume(
      {
        messages: [
          msg({
            kind: "announcement",
            idempotencyKey: "k",
            action: { channelKey: "c", body: "b" },
            jobId: "j2",
          }),
        ],
      },
      { bot: bad, events: store(), lock: memLock(), ledger: ledger2 },
    );
    expect(ledger2.rows.get("j2")?.state).toBe("failed");
    expect(ledger2.rows.get("j2")?.reason).toContain("announcement.post");
  });

  it("releases back to pending with the retry's availability on a retry outcome", async () => {
    const bot = {
      upsertEvent: async () => fail({ retryAfterSeconds: 42 }),
    } as unknown as BotClient;
    const ledger = memLedger();
    const before = Date.now();
    await consume(
      {
        messages: [
          msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j1" }, 1),
        ],
      },
      { bot, events: store(), lock: memLock(), ledger },
    );
    const row = ledger.rows.get("j1");
    expect(row?.state).toBe("released");
    expect(row?.availableAt!.getTime()).toBeGreaterThanOrEqual(before + 42_000);
  });

  it("tracks nothing for messages without a jobId (pre-ledger messages in flight)", async () => {
    const bot = {
      upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
    } as unknown as BotClient;
    const ledger = memLedger();
    const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" });
    await consume({ messages: [m] }, { bot, events: store(), lock: memLock(), ledger });
    expect(m.acked).toBe(true);
    expect(ledger.rows.size).toBe(0);
  });

  it("a ledger outage never blocks ack/retry", async () => {
    const bot = {
      upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
    } as unknown as BotClient;
    const dead: QueueLedger = {
      enqueued: async () => Promise.reject(new Error("db down")),
      reserved: async () => Promise.reject(new Error("db down")),
      released: async () => Promise.reject(new Error("db down")),
      dequeued: async () => Promise.reject(new Error("db down")),
      failed: async () => Promise.reject(new Error("db down")),
    };
    const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j1" });
    await consume({ messages: [m] }, { bot, events: store(), lock: memLock(), ledger: dead });
    expect(m.acked).toBe(true);
  });

  it("a hung ledger never stalls handling or the rest of the batch", async () => {
    // A row-lock-wedged `reserved()` neither resolves nor rejects, so `.catch`
    // alone cannot rescue processing. The bounded ledger path must time out so
    // the handler still runs and every message still reaches ack/retry.
    vi.useFakeTimers();
    try {
      const hung: QueueLedger = {
        enqueued: async () => {},
        reserved: () => new Promise<void>(() => {}),
        released: async () => {},
        dequeued: async () => {},
        failed: async () => {},
      };
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
      } as unknown as BotClient;
      const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j1" });
      const m2 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j2" });
      const p = consume(
        { messages: [m1, m2] },
        { bot, events: store(), lock: memLock(), ledger: hung },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.acked).toBe(true);
      expect(m2.acked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung successor ledger is bounded, and its late insert never sends after expiry", async () => {
    vi.useFakeTimers();
    try {
      let unblock!: () => void;
      const occupied = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const rows = new Set<string>();
      const ledger: QueueLedger = {
        enqueued: vi.fn(async ({ jobId }) => {
          await occupied;
          rows.add(jobId);
        }),
        reserved: async () => occupied,
        released: async () => {},
        dequeued: async (id) => {
          await occupied;
          rows.delete(id);
        },
        failed: async () => {},
      };
      const send = vi.fn(async () => {});
      const lock = memLock();
      const bot = {
        upsertEvent: vi.fn(async () => ({ ok: true, requestId: null, discordEventId: "d1" })),
      } as unknown as BotClient;
      const first = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" });
      const second = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" });
      const p = consume(
        { messages: [first, second] },
        {
          bot,
          events: store({ needsSync: async (key) => key === "e1" }),
          lock,
          ledger,
          dispatchPending: (key, signal) =>
            dispatchSyncEvent(
              trackingQueue({ send }, ledger, undefined, signal),
              lock,
              key,
              undefined,
              signal,
            ),
        },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await p;
      expect(first.acked && second.acked).toBe(true);
      expect(bot.upsertEvent).toHaveBeenCalledTimes(2);
      expect(ledger.enqueued).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      unblock(); // the timed-out insert may actually complete after ACK
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      expect(rows.size).toBe(0); // late insert compensated, not phantom depth
      expect(lock.held.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an already-started successor send that completes late retains its ledger row", async () => {
    vi.useFakeTimers();
    try {
      let accepted!: () => void;
      const transport = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      const send = vi.fn(() => transport);
      const lock = memLock();
      const ledger = memLedger();
      const first = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" });
      const second = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" });
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
      } as unknown as BotClient;
      const p = consume(
        { messages: [first, second] },
        {
          bot,
          lock,
          ledger,
          events: store({ needsSync: async (key) => key === "e1" }),
          dispatchPending: (key, signal) =>
            dispatchSyncEvent(
              trackingQueue({ send }, ledger, undefined, signal),
              lock,
              key,
              undefined,
              signal,
            ),
        },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(first.acked && second.acked).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      expect(ledger.rows.size).toBe(1);
      accepted();
      await vi.advanceTimersByTimeAsync(0);
      expect(ledger.rows.size).toBe(1); // acceptance is ambiguous until its consumer settles it
      expect(lock.held.has(uniqueKey("e1"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung dirty check cannot hold terminal ACK or later messages", async () => {
    vi.useFakeTimers();
    try {
      const first = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1" });
      const second = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2" });
      const dispatchPending = vi.fn(async () => {});
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
      } as unknown as BotClient;
      const p = consume(
        { messages: [first, second] },
        {
          bot,
          lock: memLock(),
          ledger: memLedger(),
          dispatchPending,
          events: store({ needsSync: () => new Promise<boolean>(() => {}) }),
        },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(first.acked && second.acked).toBe(true);
      expect(dispatchPending).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an exhausted throw acks and frees the sync lock instead of retrying", async () => {
    // At the tries cap an unexpected throw is terminal: the row is already
    // moved to failed, so requeueing would run the job again with no live
    // depth accounting (and stack duplicate failure rows).
    const bot = {
      upsertEvent: async () => {
        throw new TypeError("boom");
      },
    } as unknown as BotClient;
    const lock = memLock();
    lock.held.add(uniqueKey("e1"));
    const ledger = memLedger();
    const last = msg(
      { kind: "sync-event", eventKey: "e1", idempotencyKey: "k", leaseToken, jobId: "j1" },
      SYNC_EVENT.tries,
    );
    await consume({ messages: [last] }, { bot, events: store(), lock, ledger });
    expect(last.acked).toBe(true);
    expect(last.retried).toBeUndefined();
    expect(lock.held.has(uniqueKey("e1"))).toBe(false);
    expect(ledger.rows.get("j1")?.state).toBe("failed");
    expect(ledger.rows.get("j1")?.reason).toBe("TypeError");
  });

  it("an exhausted throw acks and continues the batch when lock cleanup rejects", async () => {
    // TOG-9895 review: a rejecting lock.release used to propagate out of
    // consume() and skip every later ack (firstAck=0, secondAck=0, whole
    // batch lost). Cleanup is best-effort — the lock row self-heals via TTL.
    const bot = {
      upsertEvent: async () => {
        throw new TypeError("boom");
      },
    } as unknown as BotClient;
    const lock: UniqueLock = {
      acquire: async () => leaseToken,
      release: async (key) => {
        if (key === uniqueKey("e1")) throw new Error("lock DELETE failed");
      },
    };
    const ledger = memLedger();
    const first = msg(
      { kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", leaseToken, jobId: "j1" },
      SYNC_EVENT.tries,
    );
    const second = msg(
      { kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" },
      1,
    );
    await consume({ messages: [first, second] }, { bot, events: store(), lock, ledger });
    expect(first.acked).toBe(true);
    expect(first.retried).toBeUndefined();
    expect(second.retried).toBe("now");
    expect(second.acked).toBe(false);
    expect(ledger.rows.get("j1")?.state).toBe("failed");
  });

  it("an exhausted throw acks and continues the batch when lock cleanup hangs", async () => {
    // A hung release must not hold the batch open either: the bounded cleanup
    // times out, the terminal ack lands, and the rest of the batch runs.
    vi.useFakeTimers();
    try {
      const bot = {
        upsertEvent: async () => {
          throw new TypeError("boom");
        },
      } as unknown as BotClient;
      let unblock!: () => void;
      const hung = new Promise<void>((r) => {
        unblock = r;
      });
      const lock: UniqueLock = {
        acquire: async () => leaseToken,
        release: async (key) => {
          if (key === uniqueKey("e1")) await hung;
        },
      };
      const first = msg(
        { kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", leaseToken, jobId: "j1" },
        SYNC_EVENT.tries,
      );
      const second = msg(
        { kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" },
        1,
      );
      const p = consume(
        { messages: [first, second] },
        { bot, events: store(), lock, ledger: memLedger() },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(first.acked).toBe(true);
      expect(second.retried).toBe("now");
      unblock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a nonterminal throw still releases and retries", async () => {
    const bot = {
      upsertEvent: async () => {
        throw new TypeError("boom");
      },
    } as unknown as BotClient;
    const ledger = memLedger();
    ledger.rows.set("j1", { state: "pending" });
    const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j1" }, 1);
    await consume({ messages: [m] }, { bot, events: store(), lock: memLock(), ledger });
    expect(m.acked).toBe(false);
    expect(m.retried).toBe("now");
    expect(ledger.rows.get("j1")?.state).toBe("released");
  });
});

describe("trackingQueue", () => {
  it("mints a jobId, writes the ledger row with the debounce delay, then sends", async () => {
    const sent: { body: any; o: any }[] = [];
    const ledger = memLedger();
    const now = new Date("2026-09-30T12:00:00Z");
    const q = trackingQueue(
      { send: async (body: unknown, o?: { delaySeconds?: number }) => void sent.push({ body, o }) },
      ledger,
      () => now,
    );
    await q.send({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, { delaySeconds: 10 });
    const jobId = sent[0]!.body.jobId as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledger.rows.get(jobId)?.availableAt).toEqual(new Date(now.getTime() + 10_000));
  });

  it("deletes the ledger row when the send throws", async () => {
    const ledger = memLedger();
    const q = trackingQueue({ send: async () => Promise.reject(new Error("queue down")) }, ledger);
    await expect(
      q.send({ kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } }),
    ).rejects.toThrow("queue down");
    expect(ledger.rows.size).toBe(0);
  });
});

describe("cron", () => {
  it("reconcile closes finished first, then re-dispatches stale events", async () => {
    const order: string[] = [];
    const sent: unknown[] = [];
    const r = await reconcileEvents({
      events: store({
        closeFinished: async () => (order.push("close"), 2),
        staleEventKeys: async () => (order.push("stale"), ["a", "b"]),
      }),
      queue: { send: async (b) => void sent.push(b) },
      lock: memLock(),
    });
    expect(order).toEqual(["close", "stale"]);
    expect(r).toEqual({ closed: 2, materialized: 0, resynced: 2 });
    expect(sent).toHaveLength(2);
  });

  it("routes by cron and rejects unknown expressions", async () => {
    const ran: string[] = [];
    // The flight hands the body its reserved transaction client; the fake
    // stands in with a dummy the memory jobs ignore.
    const flight: SingleFlight = async (name, fn) => (
      ran.push(name), await fn({} as TxClient), true
    );
    const jobs = {
      reconcile: async (_db: unknown) => void ran.push("r"),
      prune: async (_db: unknown) => void ran.push("p"),
    };
    await runScheduled(RECONCILE_CRON, flight, jobs);
    await runScheduled(PRUNE_CRON, flight, jobs);
    expect(ran).toEqual(["events:reconcile", "r", "model:prune", "p"]);
    await expect(runScheduled("* * * * *", flight, jobs)).rejects.toThrow(/unknown cron/);
  });
});
