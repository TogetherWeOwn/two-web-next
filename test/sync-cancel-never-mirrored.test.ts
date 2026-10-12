// Never-mirrored cancel skips the bot (TOG-22698).
//
// Legacy SyncEventToDiscord never calls the bot when a cancelled event was
// never mirrored (discord_event_id null); it stamps RSVPs locally and resolves
// the ledger revision without a bot revision. The Next consumer routed every
// event.cancel to bot.cancelEvent (src/jobs/sync-event.ts:136-137) with no test.
import { describe, expect, it, vi } from "vitest";
import { handleSyncEvent } from "../src/jobs/sync-event";
import { BotTransportError } from "../src/jobs/types";
import type { BotClient, EventStore, SyncAttempt } from "../src/jobs/types";

function attemptFor(
  eventKey: string,
  idempotencyKey: string,
  discordEventId: string | null,
): SyncAttempt {
  return {
    eventKey,
    idempotencyKey,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00Z"),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date("2026-10-01T11:00:00Z"),
    action: "event.cancel",
    payload: { eventKey },
    discordEventId,
  } as SyncAttempt;
}

function dependencies(attempt: SyncAttempt) {
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
    prepareSync: vi.fn(async () => attempt),
    claimSync: vi.fn(async (a: SyncAttempt) => a),
    completeSync,
    deferSync: vi.fn(async () => {}),
    failSync: vi.fn(async () => {}),
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  } as unknown as EventStore;
  return { bot, events, upsertEvent, cancelEvent, completeSync };
}

describe("never-mirrored cancel skips the bot", () => {
  it("completes locally with zero bot calls when discordEventId is null", async () => {
    const attempt = attemptFor("e-cancel", "k-never", null);
    const deps = dependencies(attempt);

    const outcome = await handleSyncEvent({ eventKey: "e-cancel", idempotencyKey: "k-never" }, 1, {
      bot: deps.bot,
      events: deps.events,
    });

    expect(outcome).toEqual({ done: true });
    expect(deps.cancelEvent).not.toHaveBeenCalled();
    expect(deps.upsertEvent).not.toHaveBeenCalled();
    expect(deps.completeSync).toHaveBeenCalledTimes(1);
    expect(deps.completeSync).toHaveBeenCalledWith(attempt, null);
  });

  it("still calls bot.cancelEvent when the event was mirrored", async () => {
    const attempt = attemptFor("e-cancel", "k-mirrored", "d1");
    const deps = dependencies(attempt);

    const outcome = await handleSyncEvent(
      { eventKey: "e-cancel", idempotencyKey: "k-mirrored" },
      1,
      { bot: deps.bot, events: deps.events },
    );

    expect(outcome).toEqual({ done: true });
    expect(deps.cancelEvent).toHaveBeenCalledExactlyOnceWith(
      { eventKey: "e-cancel" },
      "k-mirrored",
    );
    expect(deps.upsertEvent).not.toHaveBeenCalled();
    expect(deps.completeSync).toHaveBeenCalledTimes(1);
  });

  it("mirrored outage still retries with backoff and stamps nothing", async () => {
    const attempt = attemptFor("e-cancel", "k-outage", "d1");
    const deps = dependencies(attempt);
    deps.bot = {
      ...deps.bot,
      cancelEvent: vi.fn(async () => {
        throw new BotTransportError("bot down");
      }),
    } as unknown as BotClient;

    const outcome = await handleSyncEvent({ eventKey: "e-cancel", idempotencyKey: "k-outage" }, 1, {
      bot: deps.bot,
      events: deps.events,
    });

    expect(outcome).toEqual({ retryInSeconds: 10 });
    expect(deps.completeSync).not.toHaveBeenCalled();
  });
});
