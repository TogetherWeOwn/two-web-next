import { createHash, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { LiveGuildHub, publicVoiceRooms } from "../src/live/guild-hub";
import { handleLiveIngress, type LiveIngressEnv } from "../src/live/ingress";
import type { LiveSocketEnv } from "../src/live/socket-route";
import * as transport from "../src/live/transport";
import { roomAllowlistCases } from "./fixtures/live-room-allowlists";

const { LIVE_INGEST_PATH } = transport;
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

function fixture(
  hubEnv: LiveSocketEnv = config,
  sockets: WebSocket[] = [],
  fetchSnapshot?: typeof fetch,
) {
  const storage = new Map();
  const kv = { get: storage.get.bind(storage), put: vi.fn(storage.set.bind(storage)) };
  const setAlarm = vi.fn<(until: number | Date) => Promise<void>>().mockResolvedValue(undefined);
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>();
  const txn = { getAlarm: async () => null, setAlarm };
  const transaction = (run: (storage: typeof txn) => Promise<void>) => run(txn);
  const ctx = {
    storage: { kv, transaction },
    getWebSockets: () => sockets,
    blockConcurrencyWhile: <T>(run: () => Promise<T>) => run(),
    waitUntil,
  } as unknown as DurableObjectState;
  let hub = new LiveGuildHub(ctx, hubEnv, fetchSnapshot);
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
    alarm: () => hub.alarm(),
    evict: () => {
      hub = new LiveGuildHub(ctx, hubEnv, fetchSnapshot);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function guestSocket(until: number): WebSocket {
  let meta: unknown = { v: 1, ref: null, until, topics: null, nextResync: 0 };
  let readyState: number = WebSocket.OPEN;
  return {
    get readyState() {
      return readyState;
    },
    deserializeAttachment: () => structuredClone(meta),
    serializeAttachment: (value: unknown) => {
      meta = structuredClone(value);
    },
    send: vi.fn(),
    close: vi.fn(() => {
      readyState = WebSocket.CLOSED;
    }),
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

it("rejects a signed loader result without an observation deadline at the guild sequence", async () => {
  const { signedLiveSnapshot } = transport;
  const omittedDeadlines: number[] = [];
  const loader = vi.spyOn(transport, "signedLiveSnapshot").mockImplementationOnce((...args) => {
    const load = signedLiveSnapshot(...args);
    return async () => {
      const snapshot = await load();
      if (snapshot) {
        omittedDeadlines.push(snapshot.validUntil);
        Reflect.deleteProperty(snapshot, "validUntil");
      }
      return snapshot;
    };
  });
  const pull = vi.fn(async () => snapshot(2)).mockResolvedValueOnce(snapshot(1));
  vi.stubGlobal("fetch", pull);
  const guest = guestSocket(Date.now() + 60_000);
  try {
    const { env, message, setAlarm, waitUntil, storage } = fixture(publicConfig, [guest]);
    expect(await handleLiveIngress(signed(1), env)).toHaveProperty("status", 409);
    await message(guest, "subscribe");
    expect(omittedDeadlines).toEqual([expect.any(Number), expect.any(Number)]);
    expect(storage.get("live-watermarks-v1")).toEqual({ applied: 0, minimum: 1 });
    expect(setAlarm).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(guest.send).toHaveBeenCalledExactlyOnceWith(
      '{"v":1,"type":"unavailable","topic":"voice"}',
    );
  } finally {
    loader.mockRestore();
  }
});

it("counts ingress snapshot pulls across an expired observation and producer outage", async () => {
  const observation = Date.parse(occurredAt);
  const deadline = observation + 30_000;
  const pullStarted = deferred<void>();
  const overlappingDeltaSeen = deferred<void>();
  const outageReply = deferred<Response>();
  const unavailable = () => new Response(null, { status: 503 });
  const pull = vi
    .fn(async () => unavailable())
    .mockResolvedValueOnce(snapshot(1, occurredAt))
    .mockImplementationOnce(() => {
      pullStarted.resolve();
      return outageReply.promise;
    });
  const { env, put, storage } = fixture(config, [], pull);
  const send = async (seq: number) => (await handleLiveIngress(signed(seq), env))?.status;

  // Keep the transport timeout from racing the deliberately held producer reply.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = vi.spyOn(Date, "now").mockReturnValue(observation);
  try {
    expect(await send(1)).toBe(204);
    clock.mockReturnValue(deadline - 1);
    expect(await send(2)).toBe(204);
    expect(pull).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(deadline + 1);
    put.mockImplementation((key, watermarks) => {
      const result = storage.set(key, watermarks);
      if (watermarks.minimum === 4) overlappingDeltaSeen.resolve();
      return result;
    });
    // Checkpointing the newer gap proves both deltas reached the hub before the reply.
    const first = send(3);
    expect(await Promise.race([pullStarted.promise, first])).toBeUndefined();
    const second = send(4);
    expect(await Promise.race([overlappingDeltaSeen.promise, second])).toBeUndefined();
    outageReply.resolve(unavailable());
    expect(await Promise.all([first, second])).toEqual([409, 409]);
    expect(pull).toHaveBeenCalledTimes(2);

    expect(await send(5)).toBe(409);
    expect(pull).toHaveBeenCalledTimes(3);
    expect(await send(6)).toBe(409);
    expect(pull).toHaveBeenCalledTimes(4);
    expect([...storage.values()]).toEqual([{ applied: 2, minimum: 6 }]);

    pull.mockResolvedValueOnce(snapshot(6, new Date(Date.now()).toISOString()));
    expect(await send(6)).toBe(204);
    expect(pull).toHaveBeenCalledTimes(5);
    expect(await send(7)).toBe(204);
    expect(pull).toHaveBeenCalledTimes(5);
    expect([...storage.values()]).toEqual([{ applied: 7, minimum: 7 }]);
  } finally {
    outageReply.resolve(unavailable());
    clock.mockRestore();
    vi.useRealTimers();
  }
});

it.each([1, 2])(
  "recovers a guest subscription after a failed public alarm at ingress cursor %i",
  async (seq) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const observation = now - 1_000;
    const deadline = observation + 30_000;
    const observedAt = new Date(observation).toISOString();
    const pull = vi.fn(async () => snapshot(1, observedAt));
    vi.stubGlobal("fetch", pull);
    const guest = guestSocket(now + 60_000);
    const requester = guestSocket(now + 60_000);
    const { env, message, setAlarm, waitUntil, alarm, storage } = fixture(publicConfig, [
      guest,
      requester,
    ]);
    const unavailable = '{"v":1,"type":"unavailable","topic":"voice"}';
    const baseline = '{"v":1,"type":"snapshot","topic":"voice","seq":1,"value":{"count":null}}';
    try {
      setAlarm.mockRejectedValueOnce(new Error("alarm write unavailable"));
      const send = async (cursor: number) => (await handleLiveIngress(signed(cursor), env))?.status;
      expect(await send(1)).toBe(204);
      expect(setAlarm).not.toHaveBeenCalled();

      // Establish a subscription while its independent browser pull is unavailable.
      pull.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await message(guest, "subscribe");
      expect(guest.send).toHaveBeenCalledExactlyOnceWith(unavailable);

      clock.mockReturnValue(now + 5_001);
      await message(requester, "subscribe");
      expect(requester.close).toHaveBeenCalledWith(1011);
      expect(requester.send).toHaveBeenCalledExactlyOnceWith(unavailable);
      expect(await send(seq)).toBe(204);
      expect([...storage.values()]).toContainEqual({ applied: seq, minimum: seq });
      expect(waitUntil).not.toHaveBeenCalled();
      expect(setAlarm).toHaveBeenCalledExactlyOnceWith(deadline);
      expect(pull).toHaveBeenCalledTimes(3);
      expect(guest.send).toHaveBeenCalledExactlyOnceWith(unavailable);

      clock.mockReturnValue(now + 10_002);
      pull.mockResolvedValueOnce(snapshot(seq, observedAt));
      await message(guest, "resync");
      expect(waitUntil).toHaveBeenCalledOnce();
      await waitUntil.mock.calls[0]?.[0];
      expect(pull).toHaveBeenCalledTimes(4);
      expect(setAlarm).toHaveBeenCalledTimes(2);
      expect(setAlarm.mock.calls[1]).toEqual(setAlarm.mock.calls[0]);
      const recovered = [[unavailable], [unavailable], [baseline]];
      expect(vi.mocked(guest.send).mock.calls).toEqual(recovered);

      clock.mockReturnValue(deadline - 1);
      await alarm();
      expect(vi.mocked(guest.send).mock.calls).toEqual(recovered);
      clock.mockReturnValue(deadline);
      await alarm();
      expect(vi.mocked(guest.send).mock.calls).toEqual([...recovered, [unavailable]]);
      expect(guest.close).not.toHaveBeenCalled();
      expect(await send(seq + 1)).toBe(409);
      expect(pull).toHaveBeenCalledTimes(5);
      expect(storage.get("live-watermarks-v1")).toEqual({ applied: seq, minimum: seq + 1 });
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

it("shares the browser pull cooldown across sockets and hub reconstruction", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const pull = vi.fn(async () => snapshot(1, new Date(now).toISOString()));
  vi.stubGlobal("fetch", pull);
  const { message, evict } = fixture(publicConfig);
  const first = guestSocket(now + 60_000);
  const second = guestSocket(now + 60_000);
  const unavailable = '{"v":1,"type":"unavailable","topic":"voice"}';
  try {
    await message(first, "subscribe");
    expect(pull).toHaveBeenCalledOnce();
    evict();
    clock.mockReturnValue(now + 4_999);
    const waiting = [message(second, "subscribe"), message(first, "resync")];
    await Promise.resolve(); // Both guest commands have reached the shared pull.
    expect(pull).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledExactlyOnceWith(unavailable);

    clock.mockReturnValue(now + 5_000);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(waiting);
    expect(pull).toHaveBeenCalledTimes(2);
    const snapshotFrame =
      '{"v":1,"type":"snapshot","topic":"voice","seq":1,"value":{"count":null}}';
    expect(first.send).toHaveBeenLastCalledWith(snapshotFrame);
    expect(second.send).toHaveBeenLastCalledWith(snapshotFrame);
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
});

it("withdraws a passive viewer on a warm gap after a shorter resync lease expires", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const pull = vi.fn(async () => snapshot(1, new Date(now).toISOString()));
  vi.stubGlobal("fetch", pull);
  const active = guestSocket(now + 60_000);
  const passive = guestSocket(now + 60_000);
  const { env, message, alarm } = fixture(publicConfig, [active, passive]);
  const unavailable = '{"v":1,"type":"unavailable","topic":"voice"}';
  try {
    await message(active, "subscribe");
    await message(passive, "subscribe");
    vi.mocked(passive.send).mockClear();
    clock.mockReturnValue(now + 6_000);
    pull.mockResolvedValueOnce(snapshot(1, new Date(now - 15_000).toISOString()));
    await message(active, "resync");

    clock.mockReturnValue(now + 15_001);
    await alarm();
    expect(active.send).toHaveBeenLastCalledWith(unavailable);
    expect(await handleLiveIngress(signed(1), env)).toHaveProperty("status", 204);
    expect(passive.send).not.toHaveBeenCalled();

    expect(await handleLiveIngress(signed(3), env)).toHaveProperty("status", 409);
    expect(passive.send).toHaveBeenCalledExactlyOnceWith(unavailable);
  } finally {
    clock.mockRestore();
  }
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
