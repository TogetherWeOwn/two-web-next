// Cancelled-row sync carriers never ask the bot to upsert (TOG-12448).
//
// Event mutations share W13's tracked `sync-event` carrier; it holds identity
// only, and the consumer sends whatever the persisted attempt snapshot says.
// A cancelled row snapshots `event.cancel`, which must reach `cancelEvent` and
// never `upsertEvent`. An upsert control proves the same path still upserts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSyncMessage } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { isQueueMessage, toQueueMessage } from "../src/jobs/envelope";
import type {
  BotClient,
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
});
