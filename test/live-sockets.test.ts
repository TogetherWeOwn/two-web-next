import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readLiveSocketSession } from "../src/live/socket-route";
import { LiveSockets } from "../src/live/sockets";

vi.mock(import("../src/live/socket-route"), async (actual) => ({
  ...(await actual()),
  readLiveSocketSession: vi.fn(),
}));

const start = 1_000_000;
const readSession = vi.mocked(readLiveSocketSession);
const row = { userId: "101", member: true, remainingMs: 50 };
const resync = JSON.stringify({ v: 1, type: "resync", topics: ["voice"] });
const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
const unavailable = JSON.stringify({ v: 1, type: "unavailable", topic: "voice" });

function connectedSocket(alarm: number, signedIn = true) {
  let meta = {
    v: 1,
    ref: signedIn ? "a".repeat(64) : null,
    until: start + 300_000,
    topics: signedIn ? ["voice"] : null,
    nextResync: 0,
    voiceSeq: signedIn ? 1 : 0,
    voiceLive: signedIn,
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
  const storage = { getAlarm, setAlarm };
  const ctx = {
    getWebSockets: () => [socket],
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    storage: { transaction: <T>(fn: (txn: typeof storage) => Promise<T>) => fn(storage) },
  } as unknown as DurableObjectState;
  const projectVoice = () => (signedIn ? '{"count":2}' : null);
  const wake = () => new LiveSockets(ctx, { DISCORD_LIVE_SOCKET_ENABLED: "true" }, projectVoice);
  const sockets = wake();
  const send = (text: string) => sockets.message(socket as unknown as WebSocket, text);
  return { socket, getAlarm, setAlarm, wake, sockets, send };
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
  const { socket, getAlarm, setAlarm, sockets } = connectedSocket(start + 300_000);
  getAlarm.mockImplementationOnce(async () => {
    vi.setSystemTime(start + row.remainingMs);
    return start + 300_000;
  });
  if (publish) await sockets.publish();
  else await sockets.message(socket as unknown as WebSocket, resync);
  expect(setAlarm).toHaveBeenCalledWith(start + row.remainingMs);
  expect(socket.close).toHaveBeenCalledWith(1008);
  expect(socket.send).not.toHaveBeenCalled();
});

it("preserves earlier alarms and concurrent attachment changes without extending the lease", async () => {
  const { socket, wake, sockets, setAlarm } = connectedSocket(start + 10);
  readSession.mockImplementationOnce(async () => {
    socket.serializeAttachment({ ...socket.deserializeAttachment(), voiceSeq: 4 });
    return row;
  });
  await sockets.publish();
  expect(socket.deserializeAttachment()).toMatchObject({ until: start + 50, voiceSeq: 5 });
  expect(setAlarm).not.toHaveBeenCalled();
  readSession.mockResolvedValueOnce({ ...row, remainingMs: 300_000 });
  await wake().publish();
  expect(socket.deserializeAttachment().until).toBe(start + 50);
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
