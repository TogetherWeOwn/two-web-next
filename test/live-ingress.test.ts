import { createHash, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { LiveGuildHub, publicVoiceRooms } from "../src/live/guild-hub";
import { handleLiveIngress, type LiveIngressEnv } from "../src/live/ingress";
import type { LiveSocketEnv } from "../src/live/socket-route";
import { LIVE_INGEST_PATH } from "../src/live/transport";
import { roomAllowlistCases } from "./fixtures/live-room-allowlists";

const origin = "https://site.example";
const guildId = "100";
const occurredAt = "2026-11-20T06:00:00Z";
const guild = { ownerId: "101", afkChannelId: null };
const ops = [{ topic: "guild", op: "upsert", id: guildId, value: guild }];
const envelope = (seq: number) => ({ v: 1, guild_id: guildId, seq, occurred_at: occurredAt, ops });
const config = {
  APP_URL: origin,
  DISCORD_GUILD_ID: guildId,
  BOT_ENDPOINT_URL: "https://bot.example",
  DISCORD_LIVE_INGEST_ENABLED: "true",
  DISCORD_LIVE_INGEST_KEY_ID: "ingress-fixture",
  DISCORD_LIVE_INGEST_SECRET: "synthetic ingress material",
  DISCORD_LIVE_SNAPSHOT_KEY_ID: "snapshot-fixture",
  DISCORD_LIVE_SNAPSHOT_SECRET: "synthetic snapshot material",
} satisfies LiveIngressEnv;
const publicConfig = {
  ...config,
  DISCORD_LIVE_SOCKET_ENABLED: "true",
  DISCORD_LIVE_PUBLIC_VOICE_ROOM_IDS: "200",
};

function signed(
  seq: number,
  body = JSON.stringify(envelope(seq)),
  url = origin + LIVE_INGEST_PATH,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "a".repeat(32);
  const hash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", config.DISCORD_LIVE_INGEST_SECRET)
    .update(`POST\n${LIVE_INGEST_PATH}\n${timestamp}\n${nonce}\n${hash}`)
    .digest("hex");
  const headers = {
    "X-TWO-Key-Id": config.DISCORD_LIVE_INGEST_KEY_ID,
    "X-TWO-Timestamp": timestamp,
    "X-TWO-Nonce": nonce,
    "X-TWO-Signature": `sha256=${signature}`,
  };
  return new Request(url, { method: "POST", body, headers });
}

function fixture(hubEnv: LiveSocketEnv = config) {
  const storage = new Map();
  const kv = { get: storage.get.bind(storage), put: vi.fn(storage.set.bind(storage)) };
  const setAlarm = vi.fn<(until: number | Date) => Promise<void>>().mockResolvedValue(undefined);
  const waitUntil = vi.fn();
  const txn = { getAlarm: async () => null, setAlarm };
  const transaction = (run: (storage: typeof txn) => Promise<void>) => run(txn);
  const ctx = {
    storage: { kv, transaction },
    getWebSockets: () => [],
    waitUntil,
  } as unknown as DurableObjectState;
  let hub = new LiveGuildHub(ctx, hubEnv);
  const getByName = vi.fn(() => ({
    fetch: (url: string, init: RequestInit) => hub.fetch(new Request(url, init)),
  }));
  const env = { ...hubEnv, DISCORD_LIVE_HUB: { getByName } as unknown as DurableObjectNamespace };
  return {
    env,
    storage,
    put: kv.put,
    setAlarm,
    waitUntil,
    getByName,
    message: (socket: WebSocket, type: "subscribe" | "resync") =>
      hub.webSocketMessage(socket, JSON.stringify({ v: 1, type, topics: ["voice"] })),
    evict: () => {
      hub = new LiveGuildHub(ctx, hubEnv);
    },
  };
}

function snapshot(seq: number, observedAt = new Date().toISOString()) {
  return Response.json({
    v: 1,
    guild_id: guildId,
    seq,
    observed_at: observedAt,
    topics: {
      guild,
      roles: [{ id: guildId, permissions: "0" }],
      channels: [],
      members: [{ userId: guild.ownerId, roleIds: [], nick: null, bot: false, pending: false }],
      voice: [],
      events: [],
    },
  });
}

function guestSocket(until: number): WebSocket {
  let meta: unknown = { v: 1, ref: null, until, topics: null, nextResync: 0 };
  return {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => structuredClone(meta),
    serializeAttachment: (value: unknown) => {
      meta = structuredClone(value);
    },
    send: vi.fn(),
  } as unknown as WebSocket;
}

afterEach(() => vi.unstubAllGlobals());

it.each(roomAllowlistCases)("validates public room allowlists (%s)", (_name, input, size) => {
  expect(publicVoiceRooms(input)?.size ?? null).toBe(size);
});

it("does not touch a guild object before flag, host, signature, size and schema checks", async () => {
  const { env, getByName } = fixture();
  const send = async (request: Request, bindings: LiveIngressEnv = env) =>
    (await handleLiveIngress(request, bindings))?.status;
  expect(await send(new Request(`${origin}/up`))).toBeUndefined();
  expect(await send(signed(1), { ...env, DISCORD_LIVE_INGEST_ENABLED: undefined })).toBe(503);
  expect(await send(signed(1), config)).toBe(503);
  expect(
    await send(signed(1), { ...env, DISCORD_LIVE_SNAPSHOT_SECRET: env.DISCORD_LIVE_INGEST_SECRET }),
  ).toBe(503);
  expect(await send(new Request(origin + LIVE_INGEST_PATH))).toBe(405);
  expect(await send(signed(1, undefined, `https://other.example${LIVE_INGEST_PATH}`))).toBe(401);
  expect(await send(signed(1, undefined, `${origin}${LIVE_INGEST_PATH}?other=1`))).toBe(401);
  const valid = signed(1);
  const conflictingHost = signed(1);
  conflictingHost.headers.set("Host", "other.example");
  expect(await send(conflictingHost)).toBe(401);
  expect(
    await send(
      new Request(valid.url, {
        headers: valid.headers,
        method: "POST",
        body: JSON.stringify(envelope(2)),
      }),
    ),
  ).toBe(401);
  expect(await send(signed(1, " ".repeat(64 * 1024 + 1)))).toBe(413);
  expect(await send(signed(1, JSON.stringify({ ...envelope(1), guild_id: "200" })))).toBe(400);
  expect(getByName).not.toHaveBeenCalled();
});

it.each([1, 2])("returns 503 if publishing cursor %i cannot be checkpointed", async (seq) => {
  vi.stubGlobal("fetch", async () => snapshot(1));
  const { env, put, storage } = fixture();
  const send = async (cursor: number) => (await handleLiveIngress(signed(cursor), env))?.status;
  if (seq === 2) expect(await send(1)).toBe(204);
  put.mockImplementation((key, value) => {
    if (value.applied === seq) throw new Error("checkpoint unavailable");
    return storage.set(key, value);
  });
  expect(await send(seq)).toBe(503);
  expect([...storage.values()]).toEqual([{ applied: seq - 1, minimum: 1 }]);
});

it.each([1, 2])(
  "requires a browser to retry a failed public alarm after ingress cursor %i",
  async (seq) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const observedAt = new Date(now).toISOString();
    const pull = vi.fn(async () => snapshot(1, observedAt));
    vi.stubGlobal("fetch", pull);
    const { env, message, setAlarm, waitUntil } = fixture(publicConfig);
    const socket = guestSocket(now + 60_000);
    try {
      setAlarm.mockRejectedValueOnce(new Error("alarm write unavailable"));
      const send = async (cursor: number) => (await handleLiveIngress(signed(cursor), env))?.status;
      expect(await send(1)).toBe(204);
      expect(setAlarm).not.toHaveBeenCalled();
      await expect(message(socket, "subscribe")).rejects.toThrow("alarm write unavailable");
      expect(await send(seq)).toBe(204);
      expect(waitUntil).not.toHaveBeenCalled();
      expect(setAlarm).toHaveBeenCalledOnce();
      expect(pull).toHaveBeenCalledTimes(2);

      clock.mockReturnValue(now + 5_001);
      pull.mockResolvedValueOnce(snapshot(seq, observedAt));
      await message(socket, "resync");
      expect(waitUntil).toHaveBeenCalledOnce();
      expect(pull).toHaveBeenCalledTimes(3);
      expect(setAlarm).toHaveBeenCalledTimes(2);
      expect(setAlarm.mock.calls[1]).toEqual(setAlarm.mock.calls[0]);
    } finally {
      clock.mockRestore();
    }
  },
);

it.each([2, 3])("checks continuity through alarm I/O when ingress advances to %i", async (seq) => {
  const pull = vi.fn(async () => snapshot(seq)).mockResolvedValueOnce(snapshot(1));
  vi.stubGlobal("fetch", pull);
  const { env, message, setAlarm, waitUntil } = fixture(publicConfig);
  setAlarm.mockImplementationOnce(async () => {
    expect((await handleLiveIngress(signed(seq), env))?.status).toBe(204);
    expect(waitUntil).not.toHaveBeenCalled();
  });
  await message(guestSocket(Date.now() + 60_000), "subscribe");
  const continuous = seq === 2;
  expect(pull).toHaveBeenCalledTimes(continuous ? 1 : 2);
  expect(setAlarm).toHaveBeenCalledOnce();
  expect(waitUntil).toHaveBeenCalledTimes(continuous ? 1 : 0);
});

it("carries both watermarks across eviction without persisting any guild payload", async () => {
  let cursor = 1;
  const floorsAtPull: unknown[][] = [];
  const pull = vi.fn(() => {
    floorsAtPull.push([...storage.values()]);
    return Promise.resolve(snapshot(cursor));
  });
  vi.stubGlobal("fetch", pull);
  const { env, storage, getByName, evict } = fixture();
  const send = async (seq: number) => (await handleLiveIngress(signed(seq), env))?.status;
  expect(await send(1)).toBe(204);
  expect(await send(2)).toBe(204);
  expect(getByName.mock.calls).toEqual([[guildId], [guildId]]);
  expect([...storage.values()]).toEqual([{ applied: 2, minimum: 2 }]);
  expect(pull).toHaveBeenCalledTimes(1);

  cursor = 6;
  expect(await send(7)).toBe(409);
  expect(floorsAtPull).toEqual([[{ applied: 0, minimum: 1 }], [{ applied: 2, minimum: 7 }]]);
  expect([...storage.values()]).toEqual([{ applied: 2, minimum: 7 }]);
  evict();
  expect(await send(2)).toBe(204);
  expect(pull).toHaveBeenCalledTimes(2);
  expect(await send(3)).toBe(409); // Snapshot covers this delta but not the persisted gap.
  cursor = 7;
  expect(await send(7)).toBe(204);
  expect([...storage.values()]).toEqual([{ applied: 7, minimum: 7 }]);
});
