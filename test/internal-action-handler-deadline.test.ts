import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import {
  INTERNAL_ACTION_DEADLINE_MS,
  withInternalActionDeadline,
} from "../src/jobs/internal-action-deadline";
import { handleCallInternalAction } from "../src/jobs/call-internal-action";
import { BotTransportError, BotTerminalError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

// TOG-11628: the queued internal-action handler must bound a never-settling
// BotClient promise. Ledger/lock cleanup is already bounded; the bot call was
// awaited bare, so one hung call stalled the whole serial batch behind it.
const ann = {
  kind: "announcement",
  idempotencyKey: "k",
  action: { channelKey: "c", body: "b" },
} as const;
const role = {
  kind: "role-assign",
  idempotencyKey: null,
  action: { userId: "u", roleKey: "r" },
} as const;

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
const store = (): EventStore => ({
  find: async () => null,
  recordMirrored: async () => {},
  closeFinished: async () => 0,
  materializeSeries: async () => 0,
  staleEventKeys: async () => [],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("internal-action handler deadline (TOG-11628)", () => {
  it("pins the per-call bound so changes are deliberate", () => {
    expect(INTERNAL_ACTION_DEADLINE_MS).toBe(10_000);
  });

  it("a never-settling announcement gets a bounded retry and the batch moves on", async () => {
    vi.useFakeTimers();
    const bot = {
      postAnnouncement: () => new Promise(() => {}),
      assignRole: async () => ({ ok: true, requestId: null, outcome: "already_held" }),
      upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
    } as unknown as BotClient;
    const first = msg({ ...ann }, 1);
    const second = msg({ ...role }, 1);
    const p = consume(
      { messages: [first, second] },
      { bot, events: store(), lock: memLock(), ledger: memLedger().ledger },
    );
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    await p;
    // Bounded wait (first backoff is 5 s), same carrier key, no terminal ack …
    expect(first.retried).toBe(5);
    expect(first.acked).toBe(false);
    expect(first.body).toMatchObject({ idempotencyKey: "k" });
    // … and the later message still reaches disposition.
    expect(second.acked).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a never-settling role-assign retries without minting a key", async () => {
    vi.useFakeTimers();
    const bot = { assignRole: () => new Promise(() => {}) } as unknown as BotClient;
    const m = msg({ ...role }, 1);
    const p = consume(
      { messages: [m] },
      { bot, events: store(), lock: memLock(), ledger: memLedger().ledger },
    );
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    await p;
    expect(m.retried).toBe(5);
    expect(m.acked).toBe(false);
    expect(m.body).toMatchObject({ idempotencyKey: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung call at the cap fails terminally instead of retrying", async () => {
    vi.useFakeTimers();
    const bot = { postAnnouncement: () => new Promise(() => {}) } as unknown as BotClient;
    const { ledger, rows } = memLedger();
    rows.set("j1", { state: "pending" });
    const last = msg({ ...ann, jobId: "j1" }, 5);
    const p = consume({ messages: [last] }, { bot, events: store(), lock: memLock(), ledger });
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    await p;
    expect(last.acked).toBe(true);
    expect(last.retried).toBeUndefined();
    expect(rows.get("j1")).toMatchObject({ state: "failed", reason: "gave up after 5 attempts" });
  });

  it("late success after the deadline cannot reclassify the disposed outcome", async () => {
    vi.useFakeTimers();
    let resolve!: (v: unknown) => void;
    const gate = new Promise((res) => {
      resolve = res;
    });
    const bot = { postAnnouncement: () => gate } as unknown as BotClient;
    const p = handleCallInternalAction({ ...ann }, 1, bot);
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    const outcome = await p;
    expect(outcome).toEqual({ retryInSeconds: 5 });
    // The remote call DID finish (success) — too late. It must not turn the
    // retry into a done, throw, or touch any carrier.
    resolve({ ok: true, requestId: null, messageId: "m1", replayed: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late rejection after the deadline is swallowed, not thrown", async () => {
    vi.useFakeTimers();
    let reject!: (e: unknown) => void;
    const gate = new Promise((_res, rej) => {
      reject = rej;
    });
    // No local catch: the handler's Promise.race must stay attached so a
    // late rejection after the deadline is handled, not unhandled.
    const bot = { postAnnouncement: () => gate } as unknown as BotClient;
    const p = handleCallInternalAction({ ...ann }, 1, bot);
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    await expect(p).resolves.toEqual({ retryInSeconds: 5 });
    reject(new TypeError("late boom"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the announcement key survives timeout so redelivery replays the same key", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    let first = true;
    const bot = {
      postAnnouncement: (_a: unknown, key: string) => {
        seen.push(key);
        return first
          ? ((first = false), new Promise(() => {}))
          : Promise.resolve({ ok: true, requestId: null, messageId: "m1", replayed: true });
      },
    } as unknown as BotClient;
    const attempt = handleCallInternalAction({ ...ann }, 1, bot);
    await vi.advanceTimersByTimeAsync(INTERNAL_ACTION_DEADLINE_MS + 1000);
    await expect(attempt).resolves.toEqual({ retryInSeconds: 5 });
    // Redelivery carries the same carrier (same key), and the bot dedupes it.
    await expect(handleCallInternalAction({ ...ann }, 2, bot)).resolves.toEqual({ done: true });
    expect(seen).toEqual(["k", "k"]);
  });

  it("fast paths are unchanged: success, refusal, retry-after, transport and terminal throws", async () => {
    const ok = {
      postAnnouncement: async () => ({
        ok: true,
        requestId: null,
        messageId: "m1",
        replayed: false,
      }),
    } as unknown as BotClient;
    await expect(handleCallInternalAction({ ...ann }, 1, ok)).resolves.toEqual({ done: true });

    const refused = {
      postAnnouncement: async () => ({
        ok: false,
        code: "action_not_allowed",
        status: 403,
        requestId: null,
        message: "no",
        retryable: false,
        retryAfterSeconds: null,
      }),
    } as unknown as BotClient;
    await expect(handleCallInternalAction({ ...ann }, 1, refused)).resolves.toMatchObject({
      failed: expect.stringContaining("announcement.post"),
    });

    const throttled = {
      postAnnouncement: async () => ({
        ok: false,
        code: "rate_limited",
        status: 429,
        requestId: null,
        message: "slow",
        retryable: true,
        retryAfterSeconds: 42,
      }),
    } as unknown as BotClient;
    await expect(handleCallInternalAction({ ...ann }, 1, throttled)).resolves.toEqual({
      retryInSeconds: 42,
    });

    const down = {
      postAnnouncement: async () => {
        throw new BotTransportError("down");
      },
    } as unknown as BotClient;
    await expect(handleCallInternalAction({ ...ann }, 1, down)).resolves.toEqual({
      retryInSeconds: 5,
    });

    const broken = {
      postAnnouncement: async () => {
        throw new BotTerminalError("bad secret");
      },
    } as unknown as BotClient;
    // Class-only (TOG-11627): the terminal message can carry tokens or personal
    // data, so the handler emits only the exception class.
    await expect(handleCallInternalAction({ ...ann }, 1, broken)).resolves.toEqual({
      failed: "BotTerminalError",
    });

    vi.useFakeTimers();
    await expect(handleCallInternalAction({ ...ann }, 1, ok)).resolves.toEqual({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the helper rejects a hung run and clears its timer on fast settle", async () => {
    vi.useFakeTimers();
    const hung = withInternalActionDeadline(new Promise<never>(() => {}), 50);
    const assertion = expect(hung).rejects.toBeInstanceOf(BotTransportError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await expect(withInternalActionDeadline(Promise.resolve(7), 50)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});
