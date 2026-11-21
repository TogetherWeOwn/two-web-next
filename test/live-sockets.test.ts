import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLiveSocketSession } from "../src/live/socket-route";
import { LiveSockets } from "../src/live/sockets";

vi.mock(import("../src/live/socket-route"), async (actual) => ({
  ...(await actual()),
  readLiveSocketSession: vi.fn(),
}));

const start = 1_000_000;
const readSession = vi.mocked(readLiveSocketSession);
const row = { userId: "101", member: true, remainingMs: 50 };
const command = (type: string, topic = "voice") => JSON.stringify({ v: 1, type, topics: [topic] });
const subscribe = command("subscribe");
const resync = command("resync");
const unavailable = [JSON.stringify({ v: 1, type: "unavailable", topic: "voice" })];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connectedSocket(
  alarm: number,
  signedIn = true,
  project = () => (signedIn ? { value: '{"count":2}', until: start + 30_000 } : null),
) {
  let meta = {
    v: 1,
    ref: signedIn ? "a".repeat(64) : null,
    until: start + 300_000,
    topics: signedIn ? ["voice"] : null,
    nextResync: 0,
    voiceSeq: signedIn ? 1 : 0,
    voiceUntil: signedIn ? start + 30_000 : 0,
    voicePrevious: signedIn ? '{"count":1}' : null,
  };
  const socket = {
    readyState: WebSocket.OPEN,
    serializeAttachment: (next: typeof meta) => {
      meta = structuredClone(next);
    },
    deserializeAttachment: () => structuredClone(meta),
    send: vi.fn(),
    close: vi.fn(),
  };
  const getAlarm = vi.fn(async () => alarm);
  const setAlarm = vi.fn<(until: number) => Promise<void>>().mockResolvedValue(undefined);
  const ctx = {
    getWebSockets: () => [socket],
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    storage: { getAlarm, setAlarm },
  } as unknown as DurableObjectState;
  const instance = () => new LiveSockets(ctx, { DISCORD_LIVE_SOCKET_ENABLED: "true" }, project);
  let sockets = instance();
  return {
    socket,
    getAlarm,
    setAlarm,
    message: (text: string, refresh = async () => false) =>
      sockets.message(socket as unknown as WebSocket, text, refresh),
    publish: () => sockets.publish(),
    wake: () => {
      sockets = instance();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(start);
  readSession.mockReset().mockResolvedValue(row);
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([true, false])("checks expiry after alarm I/O (publish=%s)", async (publish) => {
  const fixture = connectedSocket(start + 300_000);
  const { socket, getAlarm, setAlarm } = fixture;
  getAlarm.mockImplementationOnce(async () => {
    vi.setSystemTime(start + row.remainingMs);
    return start + 300_000;
  });
  if (publish) await fixture.publish();
  else await fixture.message(resync);
  expect(setAlarm).toHaveBeenCalledWith(start + row.remainingMs);
  expect(socket.close).toHaveBeenCalledWith(1008);
  expect(socket.send).not.toHaveBeenCalled();
});

it("preserves earlier alarms and concurrent attachment changes without extending the lease", async () => {
  let value = '{"count":2}';
  const { socket, wake, publish, setAlarm } = connectedSocket(start + 10, true, () => ({
    value,
    until: start + 30_000,
  }));
  readSession.mockImplementationOnce(async () => {
    socket.serializeAttachment({ ...socket.deserializeAttachment(), voiceSeq: 4 });
    return row;
  });
  await publish();
  expect(socket.deserializeAttachment()).toMatchObject({ until: start + 50, voiceSeq: 5 });
  expect(setAlarm).not.toHaveBeenCalled();
  readSession.mockResolvedValueOnce({ ...row, remainingMs: 300_000 });
  value = '{"count":3}'; // A new projection exercises authorization after reconstruction.
  wake();
  await publish();
  expect(socket.deserializeAttachment()).toMatchObject({ until: start + 50, voiceSeq: 6 });
  expect(readSession).toHaveBeenCalledTimes(2);
});

it("publishes voice while a members-only resync awaits its session lookup", async () => {
  const { socket, message, publish } = connectedSocket(start + 300_000);
  socket.serializeAttachment({ ...socket.deserializeAttachment(), topics: ["voice", "members"] });
  const lookup = deferred<typeof row>();
  readSession.mockReturnValueOnce(lookup.promise);
  const resyncing = message(command("resync", "members"));
  try {
    await publish();
    expect(socket.send.mock.calls).toEqual([
      ['{"v":1,"type":"patch","topic":"voice","seq":2,"value":{"count":2}}'],
    ]);
  } finally {
    lookup.resolve(row);
    await resyncing;
  }
  expect(socket.send).toHaveBeenLastCalledWith('{"v":1,"type":"unavailable","topic":"members"}');
  expect(socket.close).not.toHaveBeenCalled();
});

it.each([
  ["revoked", 1008],
  ["lookup failed", 1011],
  ["lookup consumed the remaining lifetime", 1008],
])("closes without a fresh snapshot when the post-pull session is %s", async (state, code) => {
  const { socket, message } = connectedSocket(start + 300_000);
  // The original attachment is still live when the second lookup exhausts its row lifetime.
  readSession.mockResolvedValueOnce({ ...row, remainingMs: 300_000 });
  const entered = deferred<void>();
  const pull = deferred<boolean>();
  const refresh = vi.fn(() => {
    entered.resolve();
    return pull.promise;
  });
  const resyncing = message(resync, refresh);
  await entered.promise;
  if (state === "revoked") readSession.mockResolvedValueOnce(null);
  else if (state === "lookup failed") {
    readSession.mockRejectedValueOnce(new Error("session lookup failed"));
  } else {
    readSession.mockImplementationOnce(async () => {
      vi.setSystemTime(start + row.remainingMs);
      return row;
    });
  }
  pull.resolve(true);
  await resyncing;
  expect(refresh).toHaveBeenCalledOnce();
  expect(readSession).toHaveBeenCalledTimes(2);
  expect(socket.close.mock.calls).toEqual([[code]]);
  expect(socket.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  "resync uses fresh proof and preserves the count revision (wake=%s)",
  async (wake) => {
    const value = '{"count":5}';
    let proof: { value: string; until: number } | null = { value, until: start + 30_000 };
    const guest = connectedSocket(start + 300_000, false, () => proof);
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
    await guest.message(resync, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    const baseline = [`{"v":1,"type":"snapshot","topic":"voice","seq":1,"value":${value}}`];
    expect(guest.socket.send.mock.calls).toEqual([baseline, baseline]);

    vi.setSystemTime(start + 10_000);
    await guest.message(resync);
    expect(guest.socket.send.mock.calls).toEqual([baseline, baseline, unavailable]);
  },
);

describe("live WebSocket message bounds", () => {
  const guest = () => connectedSocket(start + 300_000, false);

  it.each([512, 513])("enforces the text byte cap at %i bytes", async (bytes) => {
    const { socket, message } = guest();
    await message(subscribe.padEnd(bytes));
    expect(socket.send.mock.calls).toEqual(bytes === 512 ? [unavailable] : []);
    expect(socket.close.mock.calls).toEqual(bytes === 512 ? [] : [[1008]]);
  });

  it.each([
    { topic: "voice", elapsed: 1_999, accepted: false },
    { topic: "voice", elapsed: 2_000, accepted: true },
    { topic: "members", elapsed: 2_001, accepted: false },
  ])(
    "resync $topic after $elapsed ms (accepted=$accepted)",
    async ({ topic, elapsed, accepted }) => {
      const { socket, message } = guest();
      await message(subscribe);
      vi.setSystemTime(start + elapsed);
      await message(command("resync", topic));
      expect(socket.close.mock.calls).toEqual(accepted ? [] : [[1008]]);
      expect(socket.send.mock.calls).toEqual(accepted ? [unavailable, unavailable] : [unavailable]);
    },
  );
});
