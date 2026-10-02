// Cancelled-row sync carriers never ask the bot to upsert (TOG-12448).
//
// src/events/sync.ts emits an `event.cancel` carrier for cancelled rows, but
// src/jobs/envelope.ts maps only `event.upsert` to a QueueMessage: the cancel
// carrier stays unrecognized, and the consumer discards it on the malformed
// path (one warn, one ack, no retry, no ledger/lock/store/bot work). This suite
// pins that terminal behavior through `toQueueMessage` -> `consume` with a
// fetch double behind the real bot client, so any upsert attempt would be
// visible. An upsert control proves the same path still sends.
//
// Test-only: if a storm is ever found here, park blocked with evidence for the
// jobs owner instead of changing the envelope, consumer or sync producer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { actionFor, buildSyncMessage } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { toQueueMessage } from "../src/jobs/envelope";
import type { EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

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

function dependencies() {
  const seen: { url: unknown; init: { body?: unknown } }[] = [];
  const fetchFn = vi.fn(async (url: unknown, init: { body?: unknown }) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        ok: true,
        result: { outcome: "created", event_id: "d1" },
        request_id: "r1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const bot = createBotClient({
    url: "https://bot-staging.internal.example",
    secret: "s",
    keyId: "web-staging",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const find = vi.fn(async (eventKey: string) => ({
    eventKey,
    payload: { ...payload, eventKey },
    mirrored: true,
  }));
  const recordMirrored = vi.fn(async () => {});
  const events = {
    find,
    recordMirrored,
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
  return { bot, events, ledger, lock, fetchFn, seen, find, recordMirrored };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cancelled-row sync carrier", () => {
  it("the producer still emits event.cancel for cancelled rows", () => {
    expect(actionFor("cancelled")).toBe("event.cancel");
    const cancel = buildSyncMessage("e-cancel", "cancelled");
    expect(cancel).toMatchObject({
      dedupeKey: "e-cancel",
      eventKey: "e-cancel",
      action: "event.cancel",
    });
  });

  it("the envelope leaves the cancel carrier unrecognized", () => {
    const cancel = buildSyncMessage("e-cancel", "cancelled");
    expect(toQueueMessage(cancel)).toBeNull();
  });

  it("the envelope still maps the upsert carrier (control)", () => {
    const upsert = buildSyncMessage("e-up", "published");
    expect(toQueueMessage(upsert)).toMatchObject({
      kind: "sync-event",
      eventKey: "e-up",
      idempotencyKey: upsert!.idempotencyKey,
    });
  });

  describe.each([1, 2, 3, 4, 5, 6])("consume at attempt %i", (attempts) => {
    it("acks the cancel carrier once: no retry, no fetch, no ledger/lock/store", async () => {
      const cancel = buildSyncMessage("e-cancel", "cancelled");
      const m = message(cancel, attempts);
      const deps = dependencies();

      await consume({ messages: [m] }, deps);

      expect(m.ack).toHaveBeenCalledExactlyOnceWith();
      expect(m.retry).not.toHaveBeenCalled();
      expect(deps.fetchFn).not.toHaveBeenCalled();
      expect(deps.find).not.toHaveBeenCalled();
      expect(deps.recordMirrored).not.toHaveBeenCalled();
      for (const operation of Object.values(deps.ledger)) expect(operation).not.toHaveBeenCalled();
      expect(deps.lock.acquire).not.toHaveBeenCalled();
      expect(deps.lock.release).not.toHaveBeenCalled();
      // One fixed warning: no carrier-controlled text escapes through this path.
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("queue malformed message discarded");
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  it("the upsert control still sends one event.upsert through the same path", async () => {
    const upsert = buildSyncMessage("e-up", "published");
    const m = message(upsert);
    const deps = dependencies();

    await consume({ messages: [m] }, deps);

    expect(m.ack).toHaveBeenCalledExactlyOnceWith();
    expect(m.retry).not.toHaveBeenCalled();
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(deps.seen[0]!.init.body));
    expect(sent).toMatchObject({ action: "event.upsert", event_key: "e-up" });
    expect(deps.recordMirrored).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
