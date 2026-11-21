import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLiveSocketSession } from "../src/live/socket-route";
import { LiveSockets } from "../src/live/sockets";

vi.mock(import("../src/live/socket-route"), async (actual) => ({
  ...(await actual()),
  readLiveSocketSession: vi.fn(),
}));

const readSession = vi.mocked(readLiveSocketSession);
const sessionRef = "a".repeat(64);
const liveRow = { userId: "101", member: true, validUntil: 1_300_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const start = 1_000_000;
const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
const resync = (topic: string) => JSON.stringify({ v: 1, type: "resync", topics: [topic] });
const unavailable = JSON.stringify({ v: 1, type: "unavailable", topic: "voice" });

function connectedSocket(
  project: () => { value: string; until: number } | null = () => null,
  ref: string | null = null,
) {
  let meta: unknown = {
    v: 1,
    ref,
    until: start + 300_000,
    topics: null,
    nextResync: 0,
    voiceSeq: 0,
    voiceUntil: 0,
    voicePrevious: null,
  };
  const server = {
    readyState: WebSocket.OPEN,
    serializeAttachment: (next: unknown) => {
      meta = structuredClone(next);
    },
    deserializeAttachment: () => structuredClone(meta),
    send: vi.fn(),
    close: vi.fn(),
  };
  const ctx = { getWebSockets: () => [server] } as unknown as DurableObjectState;
  const instance = () => new LiveSockets(ctx, { DISCORD_LIVE_SOCKET_ENABLED: "true" }, project);
  let sockets = instance();
  return {
    server,
    message: (text: string, refresh = async () => false) =>
      sockets.message(server as unknown as WebSocket, text, refresh),
    publish: () => sockets.publish(),
    wake: () => {
      sockets = instance();
    },
  };
}

beforeEach(() => {
  readSession.mockReset().mockResolvedValue(liveRow);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

describe("live WebSocket message bounds", () => {
  it("accepts valid text at 512 bytes and refuses the same message at 513", async () => {
    const edge = subscribe.padEnd(512);
    const accepted = connectedSocket();
    await accepted.message(edge);
    expect(accepted.server.send.mock.calls).toEqual([[unavailable]]);
    expect(accepted.server.close).not.toHaveBeenCalled();

    const refused = connectedSocket();
    await refused.message(`${edge} `);
    expect(refused.server.close.mock.calls).toEqual([[1008]]);
    expect(refused.server.send).not.toHaveBeenCalled();
  });

  it("rejects a resync one millisecond early without another frame", async () => {
    const { message, server } = connectedSocket();
    await message(subscribe);
    vi.setSystemTime(start + 1_999);
    await message(resync("voice"));
    expect(server.close.mock.calls).toEqual([[1008]]);
    expect(server.send.mock.calls).toEqual([[unavailable]]);
  });

  it("accepts a subscribed resync at the cooldown boundary", async () => {
    const { message, server } = connectedSocket();
    await message(subscribe);
    vi.setSystemTime(start + 2_000);
    await message(resync("voice"));
    expect(server.close).not.toHaveBeenCalled();
    expect(server.send.mock.calls).toEqual([[unavailable], [unavailable]]);
  });

  it.each([false, true])(
    "resync uses fresh proof and preserves the count revision (wake=%s)",
    async (wake) => {
      const value = '{"count":5}';
      let proof: { value: string; until: number } | null = { value, until: start + 30_000 };
      const guest = connectedSocket(() => proof);
      await guest.message(subscribe);
      vi.setSystemTime(start + 5_000);
      if (wake) {
        guest.wake();
        proof = null;
      }
      const refresh = vi.fn(async () => {
        proof = { value, until: start + 35_000 };
        return true;
      });
      await guest.message(resync("voice"), refresh);
      expect(refresh).toHaveBeenCalledOnce();
      const baseline = `{"v":1,"type":"snapshot","topic":"voice","seq":1,"value":${value}}`;
      expect(guest.server.send.mock.calls).toEqual([[baseline], [baseline]]);

      vi.setSystemTime(start + 10_000);
      await guest.message(resync("voice"));
      expect(guest.server.send.mock.calls).toEqual([[baseline], [baseline], [unavailable]]);
    },
  );

  it("publishes voice while a members-only resync awaits its session lookup", async () => {
    let value = '{"count":5}';
    const { message, publish, server } = connectedSocket(
      () => ({ value, until: start + 30_000 }),
      sessionRef,
    );
    await message(JSON.stringify({ v: 1, type: "subscribe", topics: ["voice", "members"] }));
    server.send.mockClear();
    vi.setSystemTime(start + 2_000);
    const lookup = deferred<typeof liveRow>();
    readSession.mockReturnValueOnce(lookup.promise);
    const command = message(resync("members"));
    value = '{"count":6}';
    try {
      await publish();
      expect(server.send.mock.calls).toEqual([
        ['{"v":1,"type":"patch","topic":"voice","seq":2,"value":{"count":6}}'],
      ]);
    } finally {
      lookup.resolve(liveRow);
      await command;
    }
    expect(server.send).toHaveBeenLastCalledWith('{"v":1,"type":"unavailable","topic":"members"}');
    expect(server.close).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked", 1008],
    ["lookup failed", 1011],
  ])("closes without a fresh snapshot when post-pull authorization is %s", async (state, code) => {
    const { message, server } = connectedSocket(
      () => ({ value: '{"count":5}', until: start + 30_000 }),
      sessionRef,
    );
    await message(subscribe);
    server.send.mockClear();
    readSession.mockClear();
    vi.setSystemTime(start + 2_000);
    const entered = deferred<void>();
    const pull = deferred<boolean>();
    const resyncing = message(resync("voice"), () => {
      entered.resolve();
      return pull.promise;
    });
    await entered.promise;
    if (state === "revoked") readSession.mockResolvedValueOnce(null);
    else readSession.mockRejectedValueOnce(new Error("session lookup failed"));
    pull.resolve(true);
    await resyncing;
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(server.close.mock.calls).toEqual([[code]]);
    expect(server.send).not.toHaveBeenCalled();
  });

  it("rejects a resync for an unsubscribed topic even after the cooldown", async () => {
    const { message, server } = connectedSocket();
    await message(subscribe);
    vi.setSystemTime(start + 2_001);
    await message(resync("members"));
    expect(server.close.mock.calls).toEqual([[1008]]);
    expect(server.send.mock.calls).toEqual([[unavailable]]);
  });
});
