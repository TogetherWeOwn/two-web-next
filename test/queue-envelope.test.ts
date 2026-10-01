import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { uniqueKey, type Outcome } from "../src/jobs/sync-event";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

const handlers = vi.hoisted(() => ({ sync: vi.fn(), internal: vi.fn() }));
vi.mock("../src/jobs/sync-event", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/jobs/sync-event")>(),
  handleSyncEvent: handlers.sync,
}));
vi.mock("../src/jobs/call-internal-action", () => ({ handleCallInternalAction: handlers.internal }));

const sync = { kind: "sync-event", eventKey: "event-1", idempotencyKey: "sync-key" };
const announcement = {
  kind: "announcement", idempotencyKey: "announcement-key", action: { channelKey: "general", body: "hello" },
};
const role = { kind: "role-assign", idempotencyKey: null, action: { userId: "user-1", roleKey: "member" } };

function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function dependencies() {
  const ledger: QueueLedger = {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const lock: UniqueLock = { acquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
  // These tests isolate the envelope boundary; no bot or event implementation
  // should be reached before validation. The real handlers remain covered in jobs.test.ts.
  return { bot: {} as BotClient, events: {} as EventStore, ledger, lock };
}

const malformed: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["string", "private-envelope-content"],
  ["number", 42],
  ["boolean", false],
  ["array", []],
  ["missing kind", {}],
  ["unknown kind", { kind: "private-unsupported-kind", action: role.action }],
  ["prototype kind", { kind: "toString", action: role.action }],
  ["missing sync event key", { kind: "sync-event", idempotencyKey: "k" }],
  ["non-string sync event key", { ...sync, eventKey: 42 }],
  ["missing sync idempotency key", { kind: "sync-event", eventKey: "e" }],
  ["null sync idempotency key", { ...sync, idempotencyKey: null }],
  ["missing announcement action", { kind: "announcement", idempotencyKey: "k" }],
  ["null announcement action", { ...announcement, action: null }],
  ["primitive announcement action", { ...announcement, action: "private-action" }],
  ["missing announcement channel", { ...announcement, action: { body: "private-body" } }],
  ["non-string announcement body", { ...announcement, action: { channelKey: "c", body: 42 } }],
  ["null announcement idempotency key", { ...announcement, idempotencyKey: null }],
  ["missing role action", { kind: "role-assign", idempotencyKey: null }],
  ["null role action", { ...role, action: null }],
  ["missing role user", { ...role, action: { roleKey: "r" } }],
  ["non-string role key", { ...role, action: { userId: "u", roleKey: 42 } }],
];

describe("queue envelope batch isolation", () => {
  beforeEach(() => {
    handlers.sync.mockReset().mockResolvedValue({ done: true } satisfies Outcome);
    handlers.internal.mockReset().mockResolvedValue({ done: true } satisfies Outcome);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe.each(["ack", "retry"] as const)("healthy sibling receives %s", (disposition) => {
    it.each(malformed)("rejects %s before handlers and continues", async (_label, body) => {
      if (disposition === "retry") handlers.sync.mockResolvedValue({ retryInSeconds: 10 } satisfies Outcome);
      const invalid = message(body);
      const healthy = message(sync);
      const deps = dependencies();

      await consume({ messages: [invalid, healthy] }, deps);

      expect(invalid.ack).toHaveBeenCalledExactlyOnceWith();
      expect(invalid.retry).not.toHaveBeenCalled();
      expect(handlers.internal).not.toHaveBeenCalled();
      expect(handlers.sync).toHaveBeenCalledExactlyOnceWith(sync, 1, deps);
      expect(deps.ledger.reserved).not.toHaveBeenCalled();
      expect(deps.ledger.failed).not.toHaveBeenCalled();
      expect(deps.lock.acquire).not.toHaveBeenCalled();
      if (disposition === "ack") {
        expect(healthy.ack).toHaveBeenCalledExactlyOnceWith();
        expect(healthy.retry).not.toHaveBeenCalled();
        expect(deps.lock.release).toHaveBeenCalledExactlyOnceWith(uniqueKey("event-1"));
      } else {
        expect(healthy.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
        expect(healthy.ack).not.toHaveBeenCalled();
        expect(deps.lock.release).not.toHaveBeenCalled();
      }
      // One fixed warning per malformed message: no attacker-controlled kind,
      // body, action, identifiers or exception text can escape through this path.
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("queue malformed message discarded");
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  it.each([["sync", sync], ["announcement", announcement], ["role", role]])(
    "preserves old %s messages without jobId", async (_label, body) => {
      const m = message(body);
      const deps = dependencies();
      await consume({ messages: [m] }, deps);
      expect(m.ack).toHaveBeenCalledExactlyOnceWith();
      expect(m.retry).not.toHaveBeenCalled();
      expect(handlers.sync.mock.calls.length + handlers.internal.mock.calls.length).toBe(1);
      for (const operation of Object.values(deps.ledger)) expect(operation).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});
