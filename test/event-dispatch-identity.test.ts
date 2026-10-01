import { expect, it, vi } from "vitest";
import { dispatchSyncEvent, uniqueKey } from "../src/jobs/sync-event";

it("carries the build-time request identity alongside the acquired ownership token", async () => {
  const queue = { send: vi.fn(async () => {}) };
  const lock = { acquire: vi.fn(async () => "owned-lease"), release: vi.fn(async () => {}) };
  expect(await dispatchSyncEvent(queue, lock, "event-a", "build-time-key")).toBe(true);
  expect(lock.acquire).toHaveBeenCalledExactlyOnceWith(uniqueKey("event-a"), 300);
  expect(queue.send).toHaveBeenCalledExactlyOnceWith(
    { kind: "sync-event", eventKey: "event-a", idempotencyKey: "build-time-key", leaseToken: "owned-lease" },
    { delaySeconds: 10 },
  );
  expect(lock.release).not.toHaveBeenCalled();
});

it("does not acquire or enqueue when successor dispatch already aborted", async () => {
  const queue = { send: vi.fn(async () => {}) };
  const lock = { acquire: vi.fn(async () => "owned-lease"), release: vi.fn(async () => {}) };
  const controller = new AbortController();
  controller.abort(new Error("stop before locking"));
  await expect(dispatchSyncEvent(queue, lock, "event-a", "build-time-key", controller.signal))
    .rejects.toThrow("stop before locking");
  expect(lock.acquire).not.toHaveBeenCalled();
  expect(queue.send).not.toHaveBeenCalled();
  expect(lock.release).not.toHaveBeenCalled();
});

it("compensates only its ownership token when abort follows lock acquisition", async () => {
  const queue = { send: vi.fn(async () => {}) };
  const controller = new AbortController();
  const lock = {
    acquire: vi.fn(async () => { controller.abort(new Error("stop after locking")); return "owned-lease"; }),
    release: vi.fn(async () => {}),
  };
  await expect(dispatchSyncEvent(queue, lock, "event-a", "build-time-key", controller.signal))
    .rejects.toThrow("stop after locking");
  expect(queue.send).not.toHaveBeenCalled();
  expect(lock.release).toHaveBeenCalledExactlyOnceWith(uniqueKey("event-a"), "owned-lease");
});
