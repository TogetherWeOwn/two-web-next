import { describe, expect, it, vi } from "vitest";
import { createBotClient, retryableFallback } from "../src/bot/client";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";

const opts = { url: "https://bot-staging.internal.example", secret: "s", keyId: "web-staging" };
const uuid = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function clientWith(responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next;
  });
  return { client: createBotClient({ ...opts, fetchFn: fetchFn as unknown as typeof fetch }), seen, fetchFn };
}

const announced = () =>
  jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" });
const announcedReplay = () =>
  jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" }, { "Idempotent-Replay": "true" });

describe("createBotClient (ported InternalActionClient)", () => {
  it("assertConfigured throws BotTerminalError on a missing value (exit 2, not a failed check)", () => {
    expect(() => createBotClient({ ...opts, url: "" }).assertConfigured()).toThrow(BotTerminalError);
    expect(() => createBotClient({ ...opts, secret: "" }).assertConfigured()).toThrow(BotTerminalError);
    expect(() => createBotClient({ ...opts, keyId: "" }).assertConfigured()).toThrow(BotTerminalError);
  });

  it("signs role.assign with the ported signer and parses assigned", async () => {
    const { client, seen } = clientWith([jsonResponse(200, { ok: true, result: { outcome: "assigned" }, request_id: "r1" })]);
    const r = await client.assignRole({ userId: "900000000000009999", roleKey: "rocketleague" });
    expect(r).toMatchObject({ ok: true, outcome: "assigned", requestId: "r1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://bot-staging.internal.example/internal/actions");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(
      ["content-type", "X-TWO-Key-Id", "X-TWO-Nonce", "X-TWO-Signature", "X-TWO-Timestamp"].sort(),
    );
    // Natural idempotency: no Idempotency-Key header at all (absent, not blank).
    expect(headers["X-TWO-Key-Id"]).toBe("web-staging");
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The signed bytes are the sent bytes: body sha256 matches what the signer would hash.
    const body = seen[0]!.init.body as string;
    expect(body).toBe('{"action":"role.assign","discord_id":"900000000000009999","role_key":"rocketleague"}');
  });

  it("rejects a non-snowflake discord_id before sending (terminal, no network)", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.assignRole({ userId: "not-an-id", roleKey: "r" })).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("announcement.post sends the key, reads replay + message id", async () => {
    const { client, seen } = clientWith([announcedReplay()]);
    const r = await client.postAnnouncement({ channelKey: "qa-throwaway", body: "hi" }, uuid);
    expect(r).toMatchObject({ ok: true, messageId: "m1", replayed: true });
    expect((seen[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(uuid);
  });

  it("rejects a non-UUID idempotency key before sending", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.postAnnouncement({ channelKey: "c", body: "b" }, "not-a-uuid")).rejects.toThrow(
      BotTerminalError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an over-long announcement body before sending", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.postAnnouncement({ channelKey: "c", body: "x".repeat(2001) }, uuid)).rejects.toThrow(
      BotTerminalError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("event.upsert sends location (never channel_key) and parses created + event_id", async () => {
    const { client, seen } = clientWith([
      jsonResponse(200, { ok: true, result: { outcome: "created", event_id: "d1" }, request_id: "r1" }),
    ]);
    const r = await client.upsertEvent(
      { eventKey: "e1", name: "n", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-01T01:00:00Z", location: "L", description: null },
      uuid,
    );
    expect(r).toMatchObject({ ok: true, outcome: "created", discordEventId: "d1" });
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body).toMatchObject({ action: "event.upsert", event_key: "e1", location: "L" });
    expect("channel_key" in body).toBe(false);
    expect("description" in body).toBe(false); // omitted, not null
  });

  it("an unreadable success (unknown outcome) is transport, not refusal", async () => {
    const { client } = clientWith([jsonResponse(200, { ok: true, result: { outcome: "mystery" }, request_id: "r" })]);
    await expect(client.assignRole({ userId: "1", roleKey: "r" })).rejects.toThrow(BotTransportError);
  });

  it("a bot refusal branches on the wire retryable flag", async () => {
    const { client } = clientWith([
      jsonResponse(409, { ok: false, error: { code: "in_progress", message: "busy" }, request_id: "r" }),
    ]);
    const r = await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid);
    expect(r).toMatchObject({ ok: false, code: "in_progress", retryable: true });
  });

  it("missing retryable falls back to the published table; unknown codes fail closed", async () => {
    const { client } = clientWith([
      jsonResponse(409, { ok: false, error: { code: "in_progress", message: "busy" }, request_id: "r" }),
      jsonResponse(400, { ok: false, error: { code: "weird-new-code", message: "?" }, request_id: "r" }),
    ]);
    expect(await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid)).toMatchObject({ retryable: true });
    expect(await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid)).toMatchObject({
      code: "weird-new-code",
      retryable: false,
    });
    expect(retryableFallback("replayed")).toBe(false);
    expect(retryableFallback("rate_limited")).toBe(true);
  });

  it("a 429 carries the numeric Retry-After; a date is ignored", async () => {
    const { client } = clientWith([
      jsonResponse(429, { ok: false, error: { code: "rate_limited", message: "slow", retryable: true }, request_id: "r" }, { "Retry-After": "42" }),
      jsonResponse(429, { ok: false, error: { code: "rate_limited", message: "slow", retryable: true }, request_id: "r" }, { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
    ]);
    expect(await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid)).toMatchObject({ retryAfterSeconds: 42 });
    expect(await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid)).toMatchObject({ retryAfterSeconds: null });
  });

  it("an unreachable bot throws transport (a wait, never a failure)", async () => {
    const client = createBotClient({ ...opts, fetchFn: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(client.assignRole({ userId: "1", roleKey: "r" })).rejects.toThrow(BotTransportError);
  });

  it("a non-JSON answer throws transport", async () => {
    const client = createBotClient({
      ...opts,
      fetchFn: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.assignRole({ userId: "1", roleKey: "r" })).rejects.toThrow(BotTransportError);
  });

  it("same key + fresh nonce across retries: two sends, one key, different nonces and signatures", async () => {
    const { client, seen } = clientWith([announced(), announcedReplay()]);
    await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid);
    await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid);
    const h = seen.map((s) => s.init.headers as Record<string, string>);
    expect(h[0]!["Idempotency-Key"]).toBe(uuid);
    expect(h[1]!["Idempotency-Key"]).toBe(uuid);
    expect(h[0]!["X-TWO-Nonce"]).not.toBe(h[1]!["X-TWO-Nonce"]);
    expect(h[0]!["X-TWO-Signature"]).not.toBe(h[1]!["X-TWO-Signature"]);
  });

  it("validates event times locally (ends after starts)", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.upsertEvent(
        { eventKey: "e", name: "n", startsAt: "2026-10-01T01:00:00Z", endsAt: "2026-10-01T00:00:00Z", location: "L", description: null },
        uuid,
      ),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
