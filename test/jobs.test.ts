import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_INTERNAL_ACTION, PRUNE_CRON, RECONCILE_CRON, SYNC_EVENT } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { reconcileEvents, runScheduled } from "../src/jobs/cron";
import { dispatchSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import { BotTransportError } from "../src/jobs/types";
import type { BotClient, BotFailure, EventStore, UniqueLock } from "../src/jobs/types";

const payload = { eventKey: "e1", name: "n", startsAt: "s", endsAt: null, location: "l", description: null };
const fail = (o: Partial<BotFailure>): BotFailure => ({
  ok: false, code: "x", status: 503, requestId: null, message: "m", retryable: true, retryAfterSeconds: null, ...o,
});

function memLock(): UniqueLock & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    acquire: async (k) => (held.has(k) ? false : (held.add(k), true)),
    release: async (k) => void held.delete(k),
  };
}
function store(over: Partial<EventStore> = {}): EventStore & { mirrored: string[] } {
  const mirrored: string[] = [];
  return {
    mirrored,
    find: async () => ({ eventKey: "e1", payload, mirrored: true }),
    recordMirrored: async (_k, id) => void mirrored.push(id),
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
    ...over,
  };
}
function msg(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() { r.acked = true; },
    retry(o?: { delaySeconds?: number }) { r.retried = o?.delaySeconds ?? "now"; },
  });
}
const noBot = {} as BotClient;

describe("retry constants match the Laravel originals (two-web @ 3965a6e8)", () => {
  it("SyncEventToDiscord", () => {
    expect(SYNC_EVENT).toEqual({ debounceSeconds: 10, uniqueForSeconds: 300, backoffSeconds: [10, 60, 300, 900, 3600], tries: 6 });
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
    const bot = { upsertEvent: async () => { throw new BotTransportError("down"); } } as unknown as BotClient;
    const lock = memLock();
    for (const [attempt, delay] of [[1, 10], [2, 60], [3, 300], [4, 900], [5, 3600]] as const) {
      const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, attempt);
      await consume({ messages: [m] }, { bot, events: store(), lock });
      expect(m.retried).toBe(delay);
      expect(m.acked).toBe(false);
    }
    const last = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, 6);
    lock.held.add(uniqueKey("e1"));
    await consume({ messages: [last] }, { bot, events: store(), lock });
    expect(last.acked).toBe(true);
    expect(lock.held.has(uniqueKey("e1"))).toBe(false); // lock freed on terminal outcome
  });

  it("bot Retry-After beats the backoff; terminal refusal fails now", async () => {
    let answer: BotFailure = fail({ retryAfterSeconds: 42 });
    const bot = { upsertEvent: async () => answer } as unknown as BotClient;
    const a = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, 1);
    await consume({ messages: [a] }, { bot, events: store(), lock: memLock() });
    expect(a.retried).toBe(42);
    answer = fail({ retryable: false, code: "action_not_allowed" });
    const b = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, 1);
    await consume({ messages: [b] }, { bot, events: store(), lock: memLock() });
    expect(b.acked).toBe(true);
    expect(b.retried).toBeUndefined();
  });

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
    await consume({ messages: [msg(body), msg(body, 2)] }, { bot, events: s, lock: memLock() });
    expect(created).toBe(1);
    expect(s.mirrored).toEqual(["discord-1", "discord-1"]);
  });

  it("drops deleted and unmirrored events without calling the bot", async () => {
    const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" });
    const m2 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" });
    await consume({ messages: [m1] }, { bot: noBot, events: store({ find: async () => null }), lock: memLock() });
    await consume(
      { messages: [m2] },
      { bot: noBot, events: store({ find: async () => ({ eventKey: "e1", payload, mirrored: false }) }), lock: memLock() },
    );
    expect(m1.acked && m2.acked).toBe(true);
  });
});

describe("CallInternalAction", () => {
  const ann = { kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } };
  it("walks 5/15/60/180 then fails on attempt 5", async () => {
    const bot = { postAnnouncement: async () => fail({}) } as unknown as BotClient;
    for (const [attempt, delay] of [[1, 5], [2, 15], [3, 60], [4, 180]] as const) {
      const m = msg(ann, attempt);
      await consume({ messages: [m] }, { bot, events: store(), lock: memLock() });
      expect(m.retried).toBe(delay);
    }
    const last = msg(ann, 5);
    await consume({ messages: [last] }, { bot, events: store(), lock: memLock() });
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
    await consume({ messages: [msg(ann), msg(ann, 2)] }, { bot, events: store(), lock: memLock() });
    expect(seen.get("k")).toBe(2);
  });

  it("role.assign sends no key", async () => {
    let called = 0;
    const bot = { assignRole: async () => (called++, { ok: true, requestId: null, outcome: "already_held" }) } as unknown as BotClient;
    const m = msg({ kind: "role-assign", idempotencyKey: null, action: { userId: "u", roleKey: "r" } });
    await consume({ messages: [m] }, { bot, events: store(), lock: memLock() });
    expect(called).toBe(1);
    expect(m.acked).toBe(true);
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
    const flight = async (name: string, fn: () => Promise<void>) => (ran.push(name), await fn(), true);
    const jobs = { reconcile: async () => void ran.push("r"), prune: async () => void ran.push("p") };
    await runScheduled(RECONCILE_CRON, flight, jobs);
    await runScheduled(PRUNE_CRON, flight, jobs);
    expect(ran).toEqual(["events:reconcile", "r", "model:prune", "p"]);
    await expect(runScheduled("* * * * *", flight, jobs)).rejects.toThrow(/unknown cron/);
  });
});
