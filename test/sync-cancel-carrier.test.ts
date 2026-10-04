// Cancelled-row sync carriers never ask the bot to upsert (TOG-12448,
// TOG-12758).
//
// Event mutations share W13's tracked `sync-event` carrier; it holds identity
// only, and the consumer sends whatever the persisted attempt snapshot says.
// A cancelled row snapshots `event.cancel`, which must reach `cancelEvent` and
// never `upsertEvent`. An upsert control proves the same path still upserts.
// Legacy in-flight W8 carriers (`action`/`dedupeKey`, no `kind`) map to the
// same job with the producer's idempotency key unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSyncMessage } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { isQueueMessage, toQueueMessage } from "../src/jobs/envelope";
import { botClientFor } from "../src/jobs/worker";
import { BotTransportError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const payload = {
  eventKey: "e-up",
  name: "n",
  startsAt: "2026-10-01T12:00:00.000Z",
  endsAt: "2026-10-01T13:00:00.000Z",
  location: "L",
  description: null,
};

function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function attemptFor(
  eventKey: string,
  idempotencyKey: string,
  action: SyncAttempt["action"],
): SyncAttempt {
  const base = {
    idempotencyKey,
    eventKey,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00Z"),
    state: "pending" as const,
    requestAttempts: 0,
    nextAttemptAt: new Date("2026-10-01T11:00:00Z"),
  };
  return action === "event.cancel"
    ? { ...base, action, payload: { eventKey } }
    : { ...base, action, payload: { ...payload, eventKey } };
}

function dependencies(action: SyncAttempt["action"]) {
  const ok = { ok: true as const, requestId: "r1", discordEventId: "d1" };
  const upsertEvent = vi.fn(async () => ok);
  const cancelEvent = vi.fn(async () => ok);
  const bot = {
    assertConfigured() {},
    upsertEvent,
    cancelEvent,
    postAnnouncement: vi.fn(),
    assignRole: vi.fn(),
  } as unknown as BotClient;
  const completeSync = vi.fn(async () => {});
  const events = {
    prepareSync: vi.fn(async (eventKey: string, key: string) => attemptFor(eventKey, key, action)),
    claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
    completeSync,
    deferSync: vi.fn(async () => {}),
    failSync: vi.fn(async () => {}),
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  } as unknown as EventStore;
  const ledger: QueueLedger = {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const lock: UniqueLock = {
    acquire: vi.fn(async () => "lease"),
    release: vi.fn(async () => {}),
  };
  return { bot, events, ledger, lock, upsertEvent, cancelEvent, completeSync };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cancelled-row sync carrier", () => {
  it("builds the same tracked carrier for published and cancelled rows, none for drafts", () => {
    const upsert = buildSyncMessage("e-up", "published");
    const cancel = buildSyncMessage("e-cancel", "cancelled");
    expect(upsert).toMatchObject({ kind: "sync-event", eventKey: "e-up" });
    expect(cancel).toMatchObject({ kind: "sync-event", eventKey: "e-cancel" });
    expect(cancel!.idempotencyKey).not.toBe(upsert!.idempotencyKey);
    expect(buildSyncMessage("e-draft", "draft")).toBeNull();
  });

  it("the envelope recognizes the carrier as-is", () => {
    const cancel = buildSyncMessage("e-cancel", "cancelled");
    expect(isQueueMessage(cancel)).toBe(true);
    expect(toQueueMessage(cancel)).toEqual(cancel);
  });

  describe.each([1, 2, 3])("consume at attempt %i", (attempts) => {
    it("sends event.cancel once and never upserts", async () => {
      const cancel = buildSyncMessage("e-cancel", "cancelled")!;
      const m = message(cancel, attempts);
      const deps = dependencies("event.cancel");

      await consume({ messages: [m] }, deps);

      expect(m.ack).toHaveBeenCalledExactlyOnceWith();
      expect(m.retry).not.toHaveBeenCalled();
      expect(deps.cancelEvent).toHaveBeenCalledExactlyOnceWith(
        { eventKey: "e-cancel" },
        cancel.idempotencyKey,
      );
      expect(deps.upsertEvent).not.toHaveBeenCalled();
      expect(deps.completeSync).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  it("the upsert control sends one event.upsert through the same path", async () => {
    const upsert = buildSyncMessage("e-up", "published")!;
    const m = message(upsert);
    const deps = dependencies("event.upsert");

    await consume({ messages: [m] }, deps);

    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(m.retry).not.toHaveBeenCalled();
    expect(deps.upsertEvent).toHaveBeenCalledTimes(1);
    expect(deps.cancelEvent).not.toHaveBeenCalled();
    expect(deps.completeSync).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  describe("legacy W8 cancel carrier", () => {
    const w8cancel = (idempotencyKey: string) => ({
      dedupeKey: "e-cancel",
      eventKey: "e-cancel",
      action: "event.cancel",
      idempotencyKey,
    });

    it("maps to the sync-event job with the producer key, redelivery unchanged", () => {
      const key = "22222222-2222-4222-8222-222222222222";
      expect(toQueueMessage(structuredClone(w8cancel(key)))).toEqual({
        kind: "sync-event",
        eventKey: "e-cancel",
        idempotencyKey: key,
      });
      // An inconsistent key or action stays unrecognized, like the upsert pin.
      expect(toQueueMessage({ ...w8cancel(key), dedupeKey: "another-event" })).toBeNull();
      expect(toQueueMessage({ ...w8cancel(key), action: "event.reopen" })).toBeNull();
    });

    it("sends exactly one event.cancel with the producer key through consume", async () => {
      const key = "22222222-2222-4222-8222-222222222222";
      for (const attempts of [1, 2]) {
        const m = message(w8cancel(key), attempts);
        const deps = dependencies("event.cancel");

        await consume({ messages: [m] }, deps);

        expect(m.ack).toHaveBeenCalledExactlyOnceWith();
        expect(m.retry).not.toHaveBeenCalled();
        expect(deps.cancelEvent).toHaveBeenCalledExactlyOnceWith({ eventKey: "e-cancel" }, key);
        expect(deps.upsertEvent).not.toHaveBeenCalled();
        expect(deps.completeSync).toHaveBeenCalledTimes(1);
      }
      expect(console.error).not.toHaveBeenCalled();
    });

    it("sends one signed event.cancel with the producer key; redelivery reuses it", async () => {
      const key = "33333333-3333-4333-8333-333333333333";
      const w8 = {
        dedupeKey: "e-cancel",
        eventKey: "e-cancel",
        action: "event.cancel",
        idempotencyKey: key,
      };
      const mapped = toQueueMessage(structuredClone(w8));
      expect(mapped).toEqual({ kind: "sync-event", eventKey: "e-cancel", idempotencyKey: key });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const seen: { body: unknown; idempotencyKey: string | null }[] = [];
      const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({
          body: JSON.parse(init.body as string),
          idempotencyKey: (init.headers as Record<string, string>)["Idempotency-Key"] ?? null,
        });
        return new Response(
          JSON.stringify({
            ok: true,
            request_id: "r1",
            result: { outcome: "cancelled", event_id: "d1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const configured = {
        BOT_ENDPOINT_URL: "https://bot-staging.internal.example",
        BOT_KEY_ID: "web-staging",
        BOT_SHARED_SECRET: "fixture-secret",
      };
      for (const attempts of [1, 2]) {
        const m = message(mapped, attempts);
        const deps = dependencies("event.cancel");
        deps.bot = botClientFor(configured, fetchFn as unknown as typeof fetch);

        await consume({ messages: [m] }, deps);

        expect(m.ack).toHaveBeenCalledExactlyOnceWith();
        expect(m.retry).not.toHaveBeenCalled();
        expect(deps.completeSync).toHaveBeenCalledTimes(1);
      }
      expect(fetchFn).toHaveBeenCalledTimes(2);
      for (const s of seen) {
        expect(s.body).toEqual({ action: "event.cancel", event_key: "e-cancel" });
        expect(s.idempotencyKey).toBe(key);
      }
      info.mockRestore();
    });

    it("releases on transport outage with the normal backoff, never a failure", async () => {
      const key = "22222222-2222-4222-8222-222222222222";
      const m = message(w8cancel(key));
      const deps = dependencies("event.cancel");
      deps.bot = {
        ...deps.bot,
        cancelEvent: vi.fn(async () => {
          throw new BotTransportError("bot down");
        }),
      } as unknown as BotClient;

      await consume({ messages: [m] }, deps);

      expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
      expect(m.ack).not.toHaveBeenCalled();
      expect(deps.completeSync).not.toHaveBeenCalled();
    });

    it("acks a terminal/disabled-flag refusal without retry and never upserts", async () => {
      const key = "22222222-2222-4222-8222-222222222222";
      const refusal: BotFailure = {
        ok: false,
        code: "action_not_allowed",
        status: 403,
        requestId: null,
        message: "flag off",
        retryable: false,
        retryAfterSeconds: null,
      };
      const m = message(w8cancel(key));
      const deps = dependencies("event.cancel");
      deps.bot = {
        ...deps.bot,
        cancelEvent: vi.fn(async () => refusal),
      } as unknown as BotClient;

      await consume({ messages: [m] }, deps);

      expect(m.ack).toHaveBeenCalledExactlyOnceWith();
      expect(m.retry).not.toHaveBeenCalled();
      expect(deps.upsertEvent).not.toHaveBeenCalled();
      // `job failed` plus the one `queue.failing` alert line; no retry warn.
      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
