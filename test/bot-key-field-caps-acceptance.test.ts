import { describe, expect, it, vi } from "vitest";
import {
  InvalidActionRequestError,
  announcementPayload,
  eventCancelPayload,
  eventUpsertPayload,
  roleAssignPayload,
} from "../src/bot/actions";
import { createBotClient } from "../src/bot/client";
import { handleCallInternalAction } from "../src/jobs/call-internal-action";
import { handleSyncEvent } from "../src/jobs/sync-event";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient, EventStore, EventUpsert, SyncAttempt } from "../src/jobs/types";

// Acceptance: oversized bot key fields are rejected before they reach a
// signed body.
//
// The sibling fields already carry caps (announcement body 2000, event name
// 100, description 1000 in src/bot/client-validation.ts and
// src/bot/actions.ts), but the map keys — role_key, channel_key, event_key —
// and the event location are checked for blankness only, so an unbounded
// value is serialized into the canonical body and signed.
//
// Locked caps (characters, counted like the sibling caps, never bytes):
// - role_key / channel_key / event_key: at most 64. Event keys are ULIDs
//   (26 characters, src/events/keys.ts) and the MCP surface already bounds
//   event_key at 64 (src/mcp/server.ts); role/channel keys are short map
//   slugs such as "rocketleague" / "qa-throwaway".
// - location: at most 255, the bound the admin event form already enforces
//   on the producing side (src/admin/validation-event-form.ts).
//
// Both validation layers carry the caps: the payload constructors
// (src/bot/actions.ts, InvalidActionRequestError) and the live client
// (src/bot/client-validation.ts + the event.cancel check in
// src/bot/client-factory.ts, BotTerminalError). Rejection happens before
// sign/send — signing lives inside the transport the fetch stub stands in
// for, so zero fetch calls proves nothing was signed or sent. Error
// messages carry lengths only, never the rejected value. The queue
// handlers map the terminal rejection to a non-retryable failure.

const KEY_CAP = 64;
const LOCATION_CAP = 255;

const opts = { url: "https://bot-staging.internal.example", secret: "s", keyId: "web-staging" };
const uuid = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const atKeyCap = "k".repeat(KEY_CAP);
const overKeyCap = "k".repeat(KEY_CAP + 1);
const atLocationCap = "L".repeat(LOCATION_CAP);
const overLocationCap = "L".repeat(LOCATION_CAP + 1);

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next;
  });
  return {
    client: createBotClient({ ...opts, fetchFn: fetchFn as unknown as typeof fetch }),
    seen,
    fetchFn,
  };
}

const assigned = () =>
  jsonResponse(200, { ok: true, result: { outcome: "assigned" }, request_id: "r1" });
const announced = () =>
  jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" });
const upserted = () =>
  jsonResponse(200, { ok: true, result: { outcome: "created", event_id: "d1" }, request_id: "r1" });
const cancelled = () =>
  jsonResponse(200, {
    ok: true,
    result: { outcome: "cancelled", event_id: "d1" },
    request_id: "r1",
  });

const upsertInput = (over: Partial<EventUpsert> = {}): EventUpsert => ({
  eventKey: "e1",
  name: "n",
  startsAt: "2026-10-01T00:00:00Z",
  endsAt: "2026-10-01T01:00:00Z",
  location: "L",
  description: null,
  ...over,
});

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("live client rejects oversized key fields before sign/send", () => {
  it("role.assign: an over-cap role_key is terminal with zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.assignRole({ userId: "900000000000009999", roleKey: overKeyCap }),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("announcement.post: an over-cap channel_key is terminal with zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.postAnnouncement({ channelKey: overKeyCap, body: "b" }, uuid),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("event.upsert: an over-cap event_key is terminal with zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.upsertEvent(upsertInput({ eventKey: overKeyCap }), uuid)).rejects.toThrow(
      BotTerminalError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("event.upsert: an over-cap location is terminal with zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.upsertEvent(upsertInput({ location: overLocationCap }), uuid),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("event.cancel: an over-cap event_key is terminal with zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.cancelEvent({ eventKey: overKeyCap }, uuid)).rejects.toThrow(
      BotTerminalError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("live client sends values exactly at the cap", () => {
  it("role.assign sends a role_key of exactly 64 characters, verbatim", async () => {
    const { client, seen, fetchFn } = clientWith([assigned()]);
    const r = await client.assignRole({ userId: "900000000000009999", roleKey: atKeyCap });
    expect(r).toMatchObject({ ok: true, outcome: "assigned" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seen[0]!.init.body as string).role_key).toBe(atKeyCap);
  });

  it("announcement.post sends a channel_key of exactly 64 characters, verbatim", async () => {
    const { client, seen, fetchFn } = clientWith([announced()]);
    const r = await client.postAnnouncement({ channelKey: atKeyCap, body: "b" }, uuid);
    expect(r).toMatchObject({ ok: true, messageId: "m1" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seen[0]!.init.body as string).channel_key).toBe(atKeyCap);
  });

  it("event.upsert sends an event_key of exactly 64 characters, verbatim", async () => {
    const { client, seen, fetchFn } = clientWith([upserted()]);
    const r = await client.upsertEvent(upsertInput({ eventKey: atKeyCap }), uuid);
    expect(r).toMatchObject({ ok: true, outcome: "created" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seen[0]!.init.body as string).event_key).toBe(atKeyCap);
  });

  it("event.upsert sends a location of exactly 255 characters, verbatim", async () => {
    const { client, seen, fetchFn } = clientWith([upserted()]);
    const r = await client.upsertEvent(upsertInput({ location: atLocationCap }), uuid);
    expect(r).toMatchObject({ ok: true, outcome: "created" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seen[0]!.init.body as string).location).toBe(atLocationCap);
  });

  it("event.cancel sends an event_key of exactly 64 characters, verbatim", async () => {
    const { client, seen, fetchFn } = clientWith([cancelled()]);
    const r = await client.cancelEvent({ eventKey: atKeyCap }, uuid);
    expect(r).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seen[0]!.init.body as string).event_key).toBe(atKeyCap);
  });

  it("counts characters, not bytes: 64 multi-byte characters send, 65 refuse", async () => {
    // "é" is one character and two UTF-8 bytes: a byte count would refuse
    // the at-cap key the sibling caps (body/name) would accept.
    const sending = clientWith([assigned()]);
    await expect(
      sending.client.assignRole({ userId: "1", roleKey: "é".repeat(KEY_CAP) }),
    ).resolves.toMatchObject({ ok: true });
    expect(sending.fetchFn).toHaveBeenCalledTimes(1);

    const refusing = clientWith([]);
    await expect(
      refusing.client.assignRole({ userId: "1", roleKey: "é".repeat(KEY_CAP + 1) }),
    ).rejects.toThrow(BotTerminalError);
    expect(refusing.fetchFn).not.toHaveBeenCalled();
  });
});

describe("rejection messages carry lengths only, never values", () => {
  it("role_key: the message names the cap and the length, not the key", async () => {
    const marker = "marker-do-not-echo";
    const value = marker + "x".repeat(KEY_CAP + 1 - marker.length);
    const { client } = clientWith([]);
    const err = await rejectionOf(client.assignRole({ userId: "1", roleKey: value }));
    expect(err).toBeInstanceOf(BotTerminalError);
    expect(err.message).toContain(String(KEY_CAP));
    expect(err.message).toContain(String(KEY_CAP + 1));
    expect(err.message).not.toContain(marker);
    expect(err.message).not.toContain(value);
  });

  it("location: the message names the cap and the length, not the location", async () => {
    const marker = "marker-do-not-echo";
    const value = marker + "y".repeat(LOCATION_CAP + 1 - marker.length);
    const { client } = clientWith([]);
    const err = await rejectionOf(client.upsertEvent(upsertInput({ location: value }), uuid));
    expect(err).toBeInstanceOf(BotTerminalError);
    expect(err.message).toContain(String(LOCATION_CAP));
    expect(err.message).toContain(String(LOCATION_CAP + 1));
    expect(err.message).not.toContain(marker);
    expect(err.message).not.toContain(value);
  });
});

describe("payload constructors carry the same caps", () => {
  const eventDates = {
    startsAt: new Date("2026-09-01T18:00:00Z"),
    endsAt: new Date("2026-09-01T19:00:00Z"),
  };

  it("roleAssignPayload refuses an over-cap role_key and accepts the cap", () => {
    expect(() =>
      roleAssignPayload({ discordId: "900000000000009999", roleKey: overKeyCap }),
    ).toThrow(InvalidActionRequestError);
    expect(roleAssignPayload({ discordId: "900000000000009999", roleKey: atKeyCap }).role_key).toBe(
      atKeyCap,
    );
  });

  it("announcementPayload refuses an over-cap channel_key and accepts the cap", () => {
    expect(() => announcementPayload({ channelKey: overKeyCap, body: "b" })).toThrow(
      InvalidActionRequestError,
    );
    expect(announcementPayload({ channelKey: atKeyCap, body: "b" }).channel_key).toBe(atKeyCap);
  });

  it("eventUpsertPayload refuses an over-cap event_key and accepts the cap", () => {
    expect(() =>
      eventUpsertPayload({
        eventKey: overKeyCap,
        name: "n",
        ...eventDates,
        location: "here",
        description: null,
      }),
    ).toThrow(InvalidActionRequestError);
    expect(
      eventUpsertPayload({
        eventKey: atKeyCap,
        name: "n",
        ...eventDates,
        location: "here",
        description: null,
      }).event_key,
    ).toBe(atKeyCap);
  });

  it("eventUpsertPayload refuses an over-cap location and accepts the cap", () => {
    expect(() =>
      eventUpsertPayload({
        eventKey: "k",
        name: "n",
        ...eventDates,
        location: overLocationCap,
        description: null,
      }),
    ).toThrow(InvalidActionRequestError);
    expect(
      eventUpsertPayload({
        eventKey: "k",
        name: "n",
        ...eventDates,
        location: atLocationCap,
        description: null,
      }).location,
    ).toBe(atLocationCap);
  });

  it("eventCancelPayload refuses an over-cap event_key and accepts the cap", () => {
    expect(() => eventCancelPayload({ eventKey: overKeyCap })).toThrow(InvalidActionRequestError);
    expect(eventCancelPayload({ eventKey: atKeyCap }).event_key).toBe(atKeyCap);
  });

  it("constructor messages carry lengths only, never values", () => {
    const marker = "marker-do-not-echo";
    const value = marker + "z".repeat(KEY_CAP + 1 - marker.length);
    const err = thrownBy(() => announcementPayload({ channelKey: value, body: "b" }));
    expect(err).toBeInstanceOf(InvalidActionRequestError);
    expect(err.message).toContain(String(KEY_CAP));
    expect(err.message).toContain(String(KEY_CAP + 1));
    expect(err.message).not.toContain(marker);
    expect(err.message).not.toContain(value);
  });
});

describe("queue handlers map the rejection to a non-retryable terminal", () => {
  it("announcement: over-cap channel_key fails terminal on the first attempt, zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    const outcome = await handleCallInternalAction(
      { kind: "announcement", idempotencyKey: uuid, action: { channelKey: overKeyCap, body: "b" } },
      1,
      client as unknown as BotClient,
    );
    // Class-only terminal reason, no retryInSeconds: never a retry storm.
    expect(outcome).toEqual({ failed: "BotTerminalError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("role-assign: over-cap role_key fails terminal on the first attempt, zero wire calls", async () => {
    const { client, fetchFn } = clientWith([]);
    const outcome = await handleCallInternalAction(
      {
        kind: "role-assign",
        idempotencyKey: null,
        action: { userId: "900000000000009999", roleKey: overKeyCap },
      },
      1,
      client as unknown as BotClient,
    );
    expect(outcome).toEqual({ failed: "BotTerminalError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  function syncStore(attempt: SyncAttempt) {
    const calls = { completed: 0, deferred: 0 };
    const events: EventStore = {
      prepareSync: async () => attempt,
      claimSync: async (a) => ({ ...a, requestAttempts: a.requestAttempts + 1 }),
      completeSync: async () => void calls.completed++,
      deferSync: async () => void calls.deferred++,
      failSync: async () => {},
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    };
    return { events, calls };
  }

  const syncAttempt = (payload: EventUpsert): SyncAttempt => ({
    idempotencyKey: uuid,
    eventKey: payload.eventKey,
    revision: 1,
    mirroredAt: new Date(),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date(0),
    action: "event.upsert",
    payload,
  });

  it("sync-event upsert: over-cap location is definitive terminal, nothing stamped or deferred", async () => {
    const { client, fetchFn } = clientWith([]);
    const { events, calls } = syncStore(syncAttempt(upsertInput({ location: overLocationCap })));
    const outcome = await handleSyncEvent({ eventKey: "e1", idempotencyKey: uuid }, 1, {
      bot: client as unknown as BotClient,
      events,
    });
    expect(outcome).toEqual({ failed: "BotTerminalError", definitive: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls).toEqual({ completed: 0, deferred: 0 });
  });

  it("sync-event cancel: over-cap event_key is definitive terminal, nothing stamped or deferred", async () => {
    const { client, fetchFn } = clientWith([]);
    const attempt: SyncAttempt = {
      idempotencyKey: uuid,
      eventKey: overKeyCap,
      revision: 1,
      mirroredAt: new Date(),
      state: "pending",
      requestAttempts: 0,
      nextAttemptAt: new Date(0),
      // Mirrored before, so the handler takes the bot path, not local settle.
      discordEventId: "d1",
      action: "event.cancel",
      payload: { eventKey: overKeyCap },
    };
    const { events, calls } = syncStore(attempt);
    const outcome = await handleSyncEvent({ eventKey: overKeyCap, idempotencyKey: uuid }, 1, {
      bot: client as unknown as BotClient,
      events,
    });
    expect(outcome).toEqual({ failed: "BotTerminalError", definitive: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls).toEqual({ completed: 0, deferred: 0 });
  });

  it("sync-event upsert: at-cap key and location still send and complete", async () => {
    const { client, fetchFn } = clientWith([upserted()]);
    const payload = upsertInput({ eventKey: atKeyCap, location: atLocationCap });
    const { events, calls } = syncStore(syncAttempt(payload));
    const outcome = await handleSyncEvent({ eventKey: atKeyCap, idempotencyKey: uuid }, 1, {
      bot: client as unknown as BotClient,
      events,
    });
    expect(outcome).toEqual({ done: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls.completed).toBe(1);
  });
});
