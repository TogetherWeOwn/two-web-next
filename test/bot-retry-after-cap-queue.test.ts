// Queue-level pin for the shared Retry-After cap (TOG-30733 review follow-up).
//
// The shared parser caps representable-but-absurd headers at
// MAX_RETRY_DELAY_SECONDS before the bot transport hands them to queue
// admission. This test runs that full chain — header string through the
// signed bot transport into both queue consumers — so a bot 429 with
// `Retry-After: 86401` (or larger) parks for 24h instead of silently
// falling back to the attempt's backoff. Parser-only coverage lives in
// test/retry-after-shared-parser-acceptance.test.ts; this file owns the
// transport-to-queue contract the operator runbooks describe.
//
// Hermetic: stubbed fetch only, no live Discord or bot calls, no DB.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { handleCallInternalAction } from "../src/jobs/call-internal-action";
import { MAX_RETRY_DELAY_SECONDS } from "../src/jobs/retry-delay";
import { handleSyncEvent } from "../src/jobs/sync-event";
import type { BotClient, BotFailure, EventStore, SyncAttempt } from "../src/jobs/types";

const botOpts = {
  url: "https://bot.example.test",
  secret: "fixture-secret",
  keyId: "web-fixture",
};
const uuid = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";

/** One bot 429 `rate_limited` refusal as the transport delivers it for a header string. */
async function transportRetryAfterSeconds(header: string): Promise<number | null> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "rate_limited", message: "slow", retryable: true },
          request_id: "r1",
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "Retry-After": header },
        },
      ),
  );
  const client = createBotClient({ ...botOpts, fetchFn: fetchFn as unknown as typeof fetch });
  const result = await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid);
  if (result.ok) throw new Error("expected a bot refusal");
  return result.retryAfterSeconds;
}

function queueBotWith(retryAfterSeconds: number | null): BotClient {
  const answer: BotFailure = {
    ok: false,
    code: "rate_limited",
    status: 429,
    requestId: null,
    message: "slow down",
    retryable: true,
    retryAfterSeconds,
  };
  return {
    postAnnouncement: async () => answer,
    assignRole: async () => answer,
    upsertEvent: async () => answer,
    cancelEvent: async () => answer,
  } as unknown as BotClient;
}

const ann = {
  kind: "announcement",
  idempotencyKey: "k",
  action: { channelKey: "c", body: "b" },
} as const;

const CLOCK = Date.parse("2026-10-11T12:00:00Z");
const syncMsg = {
  eventKey: "event-key",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};

function syncAttempt(): SyncAttempt {
  return {
    eventKey: "event-key",
    idempotencyKey: syncMsg.idempotencyKey,
    revision: 1,
    mirroredAt: new Date(0),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date(0),
    action: "event.upsert",
    payload: {
      eventKey: "event-key",
      name: "event",
      startsAt: "2026-10-01T12:00:00Z",
      endsAt: "2026-10-01T13:00:00Z",
      location: "room",
      description: "details",
    },
  };
}

function syncStore() {
  const deferred: Array<Date | null> = [];
  const current = syncAttempt();
  const events = {
    prepareSync: async () => current,
    claimSync: async () => current,
    deferSync: async (_attempt: SyncAttempt, at: Date | null) => void deferred.push(at),
    completeSync: async () => {},
  } as unknown as EventStore;
  return { events, deferred };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bot Retry-After cap through the queue", () => {
  it.each([["86401"], ["100000"], ["999999999"]])(
    "header %s waits 24h through the transport and both queue consumers",
    async (header) => {
      const transported = await transportRetryAfterSeconds(header);
      expect(transported).toBe(MAX_RETRY_DELAY_SECONDS);
      vi.restoreAllMocks();

      const internal = await handleCallInternalAction({ ...ann }, 1, queueBotWith(transported));
      expect(internal).toEqual({ retryInSeconds: MAX_RETRY_DELAY_SECONDS });

      const { events, deferred } = syncStore();
      const sync = await handleSyncEvent(syncMsg, 1, {
        bot: queueBotWith(transported),
        events,
        now: () => new Date(CLOCK),
      });
      expect(sync).toEqual({ retryInSeconds: MAX_RETRY_DELAY_SECONDS });
      expect(deferred).toEqual([new Date(CLOCK + MAX_RETRY_DELAY_SECONDS * 1000)]);
    },
  );
});
