import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveSockets } from "../src/live/sockets";
import type { SessionStore } from "../src/sessions";

const start = 1_000_000;
const readSession = vi.fn<SessionStore["getLive"]>();
const row = { userId: "101", member: true, remainingMs: 50 };
const resyncTopics = (...topics: string[]) => JSON.stringify({ v: 1, type: "resync", topics });
const resync = resyncTopics("voice");
const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
const unavailable = JSON.stringify({ v: 1, type: "unavailable", topic: "voice" });

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
  projectVoice = () => (signedIn ? { value: '{"count":5}', until: start + 30_000 } : null),
) {
  let meta = {
    v: 1,
    ref: signedIn ? "a".repeat(64) : null,
    until: start + 300_000,
    topics: signedIn ? ["voice"] : null,
    nextResync: 0,
    voiceSeq: signedIn ? 1 : 0,
    voiceUntil: signedIn ? start + 30_000 : 0,
    voicePrevious: signedIn ? '{"count":6}' : null,
  };
  const socket = {
    readyState: WebSocket.OPEN as number,
    serializeAttachment: (next: typeof meta) => {
      meta = structuredClone(next);
    },
    deserializeAttachment: () => structuredClone(meta),
    send: vi.fn(),
    close: vi.fn(() => {
      socket.readyState = WebSocket.CLOSED;
    }),
  };
  const getAlarm = vi.fn(async () => alarm);
  const setAlarm = vi.fn<(until: number) => Promise<void>>().mockResolvedValue(undefined);
  const storage = { getAlarm, setAlarm };
  const ctx = {
    getWebSockets: () => [socket],
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    storage: { transaction: <T>(fn: (txn: typeof storage) => Promise<T>) => fn(storage) },
  } as unknown as DurableObjectState;
  const wake = () =>
    new LiveSockets(ctx, { DISCORD_LIVE_SOCKET_ENABLED: "true" }, projectVoice, readSession);
  let sockets = wake();
  return {
    socket,
    getAlarm,
    setAlarm,
    send: (text: string, refresh = async () => false) =>
      sockets.message(socket as unknown as WebSocket, text, refresh),
    publish: () => sockets.publish(),
    expire: () => wake().expire(0),
    wake: () => {
      sockets = wake();
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
  else await fixture.send(resync);
  expect(setAlarm).toHaveBeenCalledWith(start + row.remainingMs);
  expect(socket.close).toHaveBeenCalledWith(1008);
  expect(socket.send).not.toHaveBeenCalled();
});

it("preserves earlier alarms and concurrent attachment changes without extending the lease", async () => {
  let value = '{"count":5}';
  let until = start + 30_000;
  const { socket, wake, publish, setAlarm } = connectedSocket(start + 10, true, () => ({
    value,
    until,
  }));
  readSession.mockImplementationOnce(async () => {
    socket.serializeAttachment({ ...socket.deserializeAttachment(), voiceSeq: 4 });
    return row;
  });
  await publish();
  expect(socket.deserializeAttachment()).toMatchObject({ until: start + 50, voiceSeq: 5 });
  expect(setAlarm).not.toHaveBeenCalled();
  readSession.mockResolvedValueOnce({ ...row, remainingMs: 300_000 });
  value = '{"count":7}';
  until = start + 35_000;
  wake();
  await publish();
  expect(socket.deserializeAttachment()).toMatchObject({
    until: start + 50,
    voiceUntil: start + 30_000,
    voiceSeq: 6,
  });
  expect(readSession).toHaveBeenCalledTimes(2);
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame).type)).toEqual([
    "patch",
    "patch",
  ]);
});

it("publishes voice while a members-only resync awaits its session lookup", async () => {
  const { socket, send, publish } = connectedSocket(start + 300_000);
  socket.serializeAttachment({ ...socket.deserializeAttachment(), topics: ["voice", "members"] });
  const lookup = deferred<typeof row>();
  readSession.mockReturnValueOnce(lookup.promise);
  const resyncing = send(resyncTopics("members"));
  try {
    await publish();
    expect(socket.send.mock.calls).toEqual([
      ['{"v":1,"type":"patch","topic":"voice","seq":2,"value":{"count":5}}'],
    ]);
  } finally {
    lookup.resolve(row);
    await resyncing;
  }
  expect(socket.send).toHaveBeenLastCalledWith('{"v":1,"type":"unavailable","topic":"members"}');
  expect(socket.deserializeAttachment()).toMatchObject({
    voiceSeq: 2,
    voicePrevious: '{"count":5}',
  });
  expect(socket.close).not.toHaveBeenCalled();
});

it("rejects an overlapping command while a members-only resync awaits authorization", async () => {
  const { socket, send } = connectedSocket(start + 300_000);
  socket.serializeAttachment({ ...socket.deserializeAttachment(), topics: ["voice", "members"] });
  const lookup = deferred<typeof row>();
  readSession.mockReturnValueOnce(lookup.promise);
  const resyncing = send(resyncTopics("members"));
  try {
    await send(resync);
    expect(socket.close.mock.calls).toEqual([[1008]]);
    expect(readSession).toHaveBeenCalledOnce();
  } finally {
    lookup.resolve(row);
    await resyncing;
  }
  expect(socket.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  "holds the voice baseline for the command across a concurrent publish read (mixed=%s)",
  async (mixed) => {
    const { socket, send, publish } = connectedSocket(start + 300_000);
    const topics = mixed ? ["members", "voice"] : ["voice"];
    socket.serializeAttachment({ ...socket.deserializeAttachment(), topics });
    const lookup = deferred<typeof row>();
    const entered = deferred<void>();
    const pull = deferred<boolean>();
    readSession.mockReturnValueOnce(lookup.promise);
    const publishing = publish();
    const resyncing = send(resyncTopics(...topics), () => {
      entered.resolve();
      return pull.promise;
    });
    await entered.promise;
    const expected = mixed ? [['{"v":1,"type":"unavailable","topic":"members"}']] : [];
    try {
      lookup.resolve(row);
      await publishing;
      await publish();
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(socket.send.mock.calls).toEqual(expected);
    } finally {
      pull.resolve(true);
      await resyncing;
    }
    expect(socket.send.mock.calls).toEqual([
      ...expected,
      ['{"v":1,"type":"snapshot","topic":"voice","seq":2,"value":{"count":5}}'],
    ]);
  },
);

it.each([
  ["revoked", 1008],
  ["attachment expired", 1008],
  ["expired during lookup", 1008],
  ["failed lookup", 1011],
  ["closed", undefined],
])("reauthorizes after the resync pull (%s)", async (state, code) => {
  const { socket, send } = connectedSocket(start + 300_000);
  readSession.mockResolvedValueOnce({ ...row, remainingMs: 300_000 });
  const refresh = vi.fn(async () => {
    if (state === "revoked") readSession.mockResolvedValueOnce(null);
    if (state === "attachment expired") vi.setSystemTime(start + 300_000);
    if (state === "expired during lookup") {
      readSession.mockImplementationOnce(async () => {
        vi.setSystemTime(start + row.remainingMs);
        return row;
      });
    }
    if (state === "failed lookup") readSession.mockRejectedValueOnce(new Error("session read"));
    if (state === "closed") socket.readyState = WebSocket.CLOSED;
    return true;
  });
  await send(resync, refresh);
  expect(refresh).toHaveBeenCalledOnce();
  expect(readSession.mock.calls).toEqual([["a".repeat(64)], ["a".repeat(64)]]);
  expect(socket.close.mock.calls).toEqual(code === undefined ? [] : [[code]]);
  expect(socket.send).not.toHaveBeenCalled();
});

it.each([false, true])("resync preserves an unchanged live revision (wake=%s)", async (cold) => {
  const value = '{"count":5}';
  let proof: { value: string; until: number } | null = { value, until: start + 30_000 };
  const { socket, send, wake } = connectedSocket(start + 300_000, false, () => proof);
  await send(subscribe);
  vi.setSystemTime(start + 5_000);
  if (cold) {
    wake();
    proof = null;
  }
  const refresh = vi.fn(async () => {
    proof = { value, until: start + 35_000 };
    return true;
  });
  await send(resync, refresh);
  expect(refresh).toHaveBeenCalledOnce();
  const baseline = [`{"v":1,"type":"snapshot","topic":"voice","seq":1,"value":${value}}`];
  expect(socket.send.mock.calls).toEqual([baseline, baseline]);

  vi.setSystemTime(start + 10_000);
  await send(resync);
  expect(socket.send.mock.calls).toEqual([baseline, baseline, [unavailable]]);
});

it("rearms a hibernated guest withdrawal after an earlier alarm", async () => {
  const { socket, expire, setAlarm } = connectedSocket(Infinity, false);
  socket.serializeAttachment({ ...socket.deserializeAttachment(), voiceUntil: start + 30_000 });
  await expire();
  expect(setAlarm).toHaveBeenLastCalledWith(start + 30_000);
  expect(socket.send).not.toHaveBeenCalled();

  vi.setSystemTime(start + 30_000);
  await expire();
  expect(socket.send.mock.calls).toEqual([[unavailable]]);
  expect(socket.deserializeAttachment().voiceUntil).toBe(0);
  expect(setAlarm).toHaveBeenLastCalledWith(start + 300_000);
});

it.each([512, 513])("enforces the UTF-8 cap at %i bytes", async (bytes) => {
  const { socket, send } = connectedSocket(start + 300_000, false);
  // JSON.parse keeps the final type, so the multibyte wire text still decodes to a valid command.
  const message = `{"type":"é",${subscribe.slice(1)}`.padEnd(bytes - 1);
  expect(Buffer.byteLength(message)).toBe(bytes);
  expect(message.length).toBeLessThanOrEqual(512);
  await send(message);
  expect(socket.send.mock.calls).toEqual(bytes === 512 ? [[unavailable]] : []);
  expect(socket.close.mock.calls).toEqual(bytes === 512 ? [] : [[1008]]);
});

it.each([
  { topic: "voice", elapsed: 1_999, accepted: false },
  { topic: "voice", elapsed: 2_000, accepted: true },
  { topic: "members", elapsed: 2_001, accepted: false },
])("resync $topic after $elapsed ms (accepted=$accepted)", async ({ topic, elapsed, accepted }) => {
  const { socket, send } = connectedSocket(start + 300_000, false);
  await send(subscribe);
  vi.setSystemTime(start + elapsed);
  await send(JSON.stringify({ v: 1, type: "resync", topics: [topic] }));
  expect(socket.close.mock.calls).toEqual(accepted ? [] : [[1008]]);
  expect(socket.send.mock.calls).toEqual(
    accepted ? [[unavailable], [unavailable]] : [[unavailable]],
  );
});
