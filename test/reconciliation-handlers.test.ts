// Keyed-handler stuck-intent pins (contract v2 §7.4/§11).
//
// Every keyed bot mutation persists exactly one UUID per logical intent and
// retries ONLY with that key: `needs_reconciliation` is an immediate hard
// stop, retryable unknowns retry same-key to the budget, then escalate with
// the last wire outcome attached. No path re-keys, no path ends in a member
// error or a false success claim. Hermetic: stub bots and stores, no queue,
// no database.
import { describe, expect, it, vi } from "vitest";
import { handleCallInternalAction } from "../src/jobs/call-internal-action";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "../src/jobs/constants";
import { handleSyncEvent } from "../src/jobs/sync-event";
import { BotTransportError } from "../src/jobs/types";
import type { BotClient, BotFailure, EventStore, SyncAttempt } from "../src/jobs/types";

const KEY = "11111111-1111-4111-8111-111111111111";
const EVENT_KEY = "evt-test-reconciliation";
const CHANNEL_KEY = "channel-test-reconciliation";

function failure(over: Partial<BotFailure> = {}): BotFailure {
  return {
    ok: false,
    code: "upstream_timeout",
    status: 504,
    requestId: "req-sentinel",
    message: "MESSAGE_SENTINEL",
    retryable: true,
    retryAfterSeconds: null,
    ...over,
  };
}

/** The same-key spy: records every key the bot actually received. */
function keyedBot(answer: BotFailure | Error) {
  const seen: (string | null | undefined)[] = [];
  const respond = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const bot = {
    postAnnouncement: vi.fn(async (_action: unknown, key: string) => {
      seen.push(key);
      return respond();
    }),
    assignRole: vi.fn(async () => respond()),
    upsertEvent: vi.fn(async (_payload: unknown, key: string) => {
      seen.push(key);
      return respond();
    }),
    cancelEvent: vi.fn(async (_payload: unknown, key: string) => {
      seen.push(key);
      return respond();
    }),
  } as unknown as BotClient;
  return { bot, seen };
}

function syncAttempt(over: Partial<SyncAttempt> = {}): SyncAttempt {
  return {
    idempotencyKey: KEY,
    eventKey: EVENT_KEY,
    revision: 1,
    mirroredAt: new Date(1_000_000),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date(0),
    action: "event.upsert",
    payload: {
      eventKey: EVENT_KEY,
      name: "Synthetic",
      startsAt: "2026-10-01T12:00:00Z",
      endsAt: "2026-10-01T13:00:00Z",
    },
    ...over,
  } as SyncAttempt;
}

function syncStore(attempt: SyncAttempt | { waiting: true } | null, priorRequests = 0) {
  if (attempt !== null && !("waiting" in attempt)) attempt.requestAttempts = priorRequests;
  const deferred: (Date | null)[] = [];
  return {
    store: {
      prepareSync: async () => attempt,
      claimSync: async (a: SyncAttempt) => {
        if (attempt === null || "waiting" in attempt) return null;
        a.requestAttempts++;
        a.nextAttemptAt = null;
        return a;
      },
      deferSync: async (_a: SyncAttempt, deadline: Date | null) => void deferred.push(deadline),
      completeSync: async () => {},
      failSync: async () => {},
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    } as unknown as EventStore,
    deferred,
  };
}

const announcementMsg = {
  kind: "announcement",
  idempotencyKey: KEY,
  action: { channelKey: CHANNEL_KEY, body: "body" },
} as const;

describe("announcement handler stuck intents", () => {
  it("hard-stops on needs_reconciliation with the same key, even when the flag says retryable", async () => {
    const { bot, seen } = keyedBot(
      failure({ code: "needs_reconciliation", status: 409, retryable: true }),
    );
    const outcome = await handleCallInternalAction({ ...announcementMsg }, 1, bot);
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      verb: "announcement.post",
      subject: CHANNEL_KEY,
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "req-sentinel",
    });
    // One bot call, one key: no retry, no re-key — the carrier key is the intent.
    expect(seen).toEqual([KEY]);
  });

  it("hard-stops on needs_reconciliation regardless of status or flag", async () => {
    for (const answer of [
      failure({ code: "needs_reconciliation", status: 500, retryable: false }),
      failure({ code: "needs_reconciliation", status: 200, retryable: true }),
    ]) {
      const { bot, seen } = keyedBot(answer);
      const outcome = await handleCallInternalAction({ ...announcementMsg }, 1, bot);
      expect("stuck" in outcome).toBe(true);
      expect(seen).toEqual([KEY]);
    }
  });

  it("escalates retryable exhaustion with the same key and the last wire outcome", async () => {
    const { bot, seen } = keyedBot(failure({ code: "upstream_timeout", status: 504 }));
    const outcome = await handleCallInternalAction(
      { ...announcementMsg },
      CALL_INTERNAL_ACTION.tries,
      bot,
    );
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      verb: "announcement.post",
      subject: CHANNEL_KEY,
      lastCode: "upstream_timeout",
      lastStatus: 504,
    });
    expect(seen).toEqual([KEY]);
  });

  it("escalates transport loss at the cap with nulls, never a terminal failure", async () => {
    const { bot, seen } = keyedBot(new BotTransportError("bot down"));
    const outcome = await handleCallInternalAction(
      { ...announcementMsg },
      CALL_INTERNAL_ACTION.tries,
      bot,
    );
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      lastCode: null,
      lastStatus: null,
      lastRequestId: null,
    });
    // The one attempt went out under the carrier key, then transport failed.
    expect(seen).toEqual([KEY]);
  });

  it("retries unknowns below the cap with the same key and claims nothing", async () => {
    const { bot, seen } = keyedBot(new BotTransportError("bot down"));
    const before = { ...announcementMsg };
    const outcome = await handleCallInternalAction(before, 1, bot);
    expect(outcome).toHaveProperty("retryInSeconds");
    expect("stuck" in outcome || "failed" in outcome || "done" in outcome).toBe(false);
    expect(seen).toEqual([KEY]);
    // The message is untouched: the consumer redelivers this same carrier.
    expect(before.idempotencyKey).toBe(KEY);
  });

  it("keeps keyless role.assign terminal: needs_reconciliation is not an operator intent without a key", async () => {
    const { bot } = keyedBot(failure({ code: "needs_reconciliation", retryable: true }));
    const outcome = await handleCallInternalAction(
      { kind: "role-assign", idempotencyKey: null, action: { userId: "u", roleKey: "r" } },
      CALL_INTERNAL_ACTION.tries,
      bot,
    );
    expect("stuck" in outcome).toBe(false);
    expect(outcome).toHaveProperty("failed");
  });
});

describe("sync-event handler stuck intents", () => {
  it("hard-stops on needs_reconciliation with the same key and the attempt verb", async () => {
    const { bot, seen } = keyedBot(
      failure({ code: "needs_reconciliation", status: 409, retryable: true }),
    );
    const { store } = syncStore(syncAttempt());
    const outcome = await handleSyncEvent({ eventKey: EVENT_KEY, idempotencyKey: KEY }, 1, {
      bot,
      events: store,
    });
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      verb: "event.upsert",
      subject: EVENT_KEY,
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "req-sentinel",
    });
    expect(seen).toEqual([KEY]);
  });

  it("labels a cancel intent with event.cancel, never the upsert default", async () => {
    const { bot } = keyedBot(
      failure({ code: "needs_reconciliation", status: 409, retryable: false }),
    );
    const { store } = syncStore(
      syncAttempt({ action: "event.cancel", payload: { eventKey: EVENT_KEY } }),
    );
    const outcome = await handleSyncEvent({ eventKey: EVENT_KEY, idempotencyKey: KEY }, 1, {
      bot,
      events: store,
    });
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      verb: "event.cancel",
    });
  });

  it("escalates a closed claim with no bot answer instead of a terminal failure", async () => {
    const { bot } = keyedBot(failure());
    const { store } = syncStore({ waiting: true });
    const outcome = await handleSyncEvent(
      { eventKey: EVENT_KEY, idempotencyKey: KEY },
      SYNC_EVENT.tries,
      { bot, events: store },
    );
    expect("stuck" in outcome && outcome.stuck).toMatchObject({
      idempotencyKey: KEY,
      verb: "event.upsert",
      subject: EVENT_KEY,
      lastCode: null,
      lastStatus: null,
      lastRequestId: null,
    });
    expect("failed" in outcome).toBe(false);
  });

  it("escalates a spent request budget with the same key", async () => {
    const { bot, seen } = keyedBot(failure());
    const { store } = syncStore(syncAttempt(), SYNC_EVENT.tries);
    const outcome = await handleSyncEvent({ eventKey: EVENT_KEY, idempotencyKey: KEY }, 1, {
      bot,
      events: store,
    });
    expect("stuck" in outcome && outcome.stuck).toMatchObject({ idempotencyKey: KEY });
    // Budget spent before any bot call: no re-key is even possible.
    expect(seen).toEqual([]);
  });

  it("retries an unknown wire outcome below the cap with the same key", async () => {
    const { bot, seen } = keyedBot(failure({ code: "upstream_timeout", status: 504 }));
    const { store } = syncStore(syncAttempt());
    const outcome = await handleSyncEvent({ eventKey: EVENT_KEY, idempotencyKey: KEY }, 1, {
      bot,
      events: store,
    });
    expect(outcome).toHaveProperty("retryInSeconds");
    expect("stuck" in outcome).toBe(false);
    expect(seen).toEqual([KEY]);
  });

  it("never reports success for an unconfirmed mutation", async () => {
    for (const answer of [
      failure({ code: "needs_reconciliation", retryable: true }),
      new BotTransportError("bot down"),
    ]) {
      const { bot } = keyedBot(answer);
      const attempts = answer instanceof Error ? CALL_INTERNAL_ACTION.tries : 1;
      const sync = await handleSyncEvent({ eventKey: EVENT_KEY, idempotencyKey: KEY }, attempts, {
        bot,
        events: syncStore(syncAttempt()).store,
      });
      const ann = await handleCallInternalAction({ ...announcementMsg }, attempts, bot);
      expect("done" in sync).toBe(false);
      expect("done" in ann).toBe(false);
    }
  });
});
