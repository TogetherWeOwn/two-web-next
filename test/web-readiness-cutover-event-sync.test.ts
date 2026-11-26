import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { probeCutoverEventSync } from "../ci/web-readiness-cutover.mjs";

const discordEventId = "1000000000000000042";

function eventSyncFixture({ claimSucceeds = true, acknowledged = true } = {}) {
  const readback = { state: "succeeded", discord_event_id: discordEventId, acknowledged };
  let completed = false;
  const runtime = vi.fn(async (sql: TemplateStringsArray, ..._parameters: unknown[]) => {
    if (sql[0].startsWith("INSERT INTO events ")) return [{ id: 42 }];
    if (sql[0].startsWith("SELECT a.state, e.discord_event_id,")) {
      if (!completed) throw new Error("Settlement read before completion finished");
      return [readback];
    }
    throw new Error("Unexpected query in the event-sync probe");
  });
  const prepareSync = vi.fn(async (eventKey: string, idempotencyKey: string, _now: Date) => ({
    eventKey,
    idempotencyKey,
    requestAttempts: 0,
  }));
  type Attempt = Awaited<ReturnType<typeof prepareSync>>;
  const claimSync = vi.fn(async (attempt: Attempt, _now: Date) =>
    claimSucceeds ? { ...attempt, requestAttempts: 1 } : null,
  );
  const completeSync = vi.fn<(attempt: Attempt, eventId: string) => Promise<void>>(async () => {
    await setImmediate();
    completed = true;
  });
  const servingStore = vi.fn(() => ({ prepareSync, claimSync, completeSync }));
  return { runtime, servingStore, prepareSync, claimSync, completeSync, readback };
}

it("settles a claimed cutover event and reads back its acknowledged revision", async () => {
  const { runtime, servingStore, prepareSync, claimSync, completeSync } = eventSyncFixture();

  await expect(probeCutoverEventSync(servingStore, runtime)).resolves.toBeUndefined();

  expect(servingStore).toHaveBeenCalledExactlyOnceWith(runtime);
  const [, insertedEventKey] = runtime.mock.calls[0];
  const [eventKey, idempotencyKey, now] = prepareSync.mock.calls[0];
  const prepared = { eventKey, idempotencyKey, requestAttempts: 0 };
  expect(prepareSync).toHaveBeenCalledExactlyOnceWith(
    insertedEventKey,
    expect.any(String),
    expect.any(Date),
  );
  expect(claimSync).toHaveBeenCalledExactlyOnceWith(prepared, now);
  expect(completeSync).toHaveBeenCalledExactlyOnceWith(
    { ...prepared, requestAttempts: 1 },
    discordEventId,
  );
  expect(runtime).toHaveBeenCalledTimes(2);
  const [readQuery, readbackKey, ...otherParameters] = runtime.mock.calls[1];
  expect(readQuery[0]).toContain("SELECT a.state, e.discord_event_id,");
  expect(readbackKey).toBe(idempotencyKey);
  expect(otherParameters).toEqual([]);
  expect(prepareSync).toHaveBeenCalledBefore(claimSync);
  expect(claimSync).toHaveBeenCalledBefore(completeSync);
});

it("rejects an unclaimed cutover event before completing it or reading settlement", async () => {
  const { runtime, servingStore, claimSync, completeSync } = eventSyncFixture({
    claimSucceeds: false,
  });

  await expect(probeCutoverEventSync(servingStore, runtime)).rejects.toMatchObject({
    code: "ERR_ASSERTION",
    actual: undefined,
    expected: 1,
  });

  expect(claimSync).toHaveBeenCalledTimes(1);
  expect(completeSync).not.toHaveBeenCalled();
  expect(runtime).toHaveBeenCalledTimes(1);
});

it("rejects a successful cutover readback with the expected event ID and an unacknowledged revision", async () => {
  const { runtime, servingStore, completeSync, readback } = eventSyncFixture({
    acknowledged: false,
  });

  await expect(probeCutoverEventSync(servingStore, runtime)).rejects.toMatchObject({
    code: "ERR_ASSERTION",
    actual: readback,
    expected: { ...readback, acknowledged: true },
  });

  expect(completeSync).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ requestAttempts: 1 }),
    discordEventId,
  );
  expect(runtime).toHaveBeenCalledTimes(2);
});
