import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSockets } from "../src/live/sockets";

const start = 1_000_000;
const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
const resync = (topic: string) => JSON.stringify({ v: 1, type: "resync", topics: [topic] });
const unavailable = JSON.stringify({ v: 1, type: "unavailable", topic: "voice" });

function connectedGuest() {
  let meta: unknown = {
    v: 1,
    ref: null,
    until: start + 300_000,
    topics: null,
    nextResync: 0,
    voiceSeq: 0,
    voiceLive: false,
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
  const sockets = new LiveSockets(ctx, { DISCORD_LIVE_SOCKET_ENABLED: "true" }, () => null);
  return {
    server,
    message: (text: string) => sockets.message(server as unknown as WebSocket, text),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

describe("live WebSocket message bounds", () => {
  it("accepts valid text at 512 bytes and refuses the same message at 513", async () => {
    const edge = subscribe.padEnd(512);
    const accepted = connectedGuest();
    await accepted.message(edge);
    expect(accepted.server.send.mock.calls).toEqual([[unavailable]]);
    expect(accepted.server.close).not.toHaveBeenCalled();

    const refused = connectedGuest();
    await refused.message(`${edge} `);
    expect(refused.server.close.mock.calls).toEqual([[1008]]);
    expect(refused.server.send).not.toHaveBeenCalled();
  });

  it("rejects a resync one millisecond early without another frame", async () => {
    const { message, server } = connectedGuest();
    await message(subscribe);
    vi.setSystemTime(start + 1_999);
    await message(resync("voice"));
    expect(server.close.mock.calls).toEqual([[1008]]);
    expect(server.send.mock.calls).toEqual([[unavailable]]);
  });

  it("accepts a subscribed resync at the cooldown boundary", async () => {
    const { message, server } = connectedGuest();
    await message(subscribe);
    vi.setSystemTime(start + 2_000);
    await message(resync("voice"));
    expect(server.close).not.toHaveBeenCalled();
    expect(server.send.mock.calls).toEqual([[unavailable], [unavailable]]);
  });

  it("rejects a resync for an unsubscribed topic even after the cooldown", async () => {
    const { message, server } = connectedGuest();
    await message(subscribe);
    vi.setSystemTime(start + 2_001);
    await message(resync("members"));
    expect(server.close.mock.calls).toEqual([[1008]]);
    expect(server.send.mock.calls).toEqual([[unavailable]]);
  });
});
