import { afterEach, beforeEach, expect, it, vi } from "vitest";
import frames from "../ci/fixtures/kit-live-frames.json";
import { createBrowserLiveTopic } from "../src/live/browser-topic";

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  send = vi.fn<(command: string) => void>();
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }
  open() {
    this.dispatchEvent(new Event("open"));
    return this;
  }
  receive(...frames: object[]) {
    for (const frame of frames)
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

function fixture(poll?: (signal: AbortSignal) => Promise<unknown>) {
  const store = createBrowserLiveTopic({ count: null }, poll);
  const seen = vi.fn();
  store.subscribe(seen);
  return { ...store, seen };
}

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("location", { origin: "https://example.test" });
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("applies the hub's public revisions and retains a quiet baseline until server withdrawal", () => {
  const { seen, start } = fixture();
  expect(seen).toHaveBeenLastCalledWith({ value: { count: null }, source: "ssr" });
  expect(sockets).toHaveLength(0);
  const stop = start();
  const socket = sockets[0]!.open();
  expect(socket.url).toBe("wss://example.test/api/discord-live/v1");
  expect(socket.send.mock.calls).toEqual([['{"v":1,"type":"subscribe","topics":["voice"]}']]);
  socket.receive(frames.covering, frames.initial, frames.five, frames.five, frames.suppressed);
  vi.advanceTimersByTime(31_000);
  expect(seen.mock.calls.slice(1)).toEqual([
    [{ value: { count: null }, source: "live" }],
    [{ value: { count: 5 }, source: "live" }],
    [{ value: { count: null }, source: "live" }],
  ]);
  expect(socket.close).not.toHaveBeenCalled();
  stop();
});

it("accepts higher recovery snapshots after withdrawal on the original socket", async () => {
  const poll = vi.fn(
    (_signal: AbortSignal) => new Promise((resolve) => setTimeout(() => resolve({ count: 99 }), 1)),
  );
  const { seen, start } = fixture(poll);
  const stop = start();
  const socket = sockets[0]!.open();
  socket.receive(frames.initial, frames.five, { ...frames.five, seq: 4 });
  await vi.advanceTimersByTimeAsync(0);
  socket.receive(frames.withdrawal);
  socket.receive({ ...frames.covering, seq: 2 });
  socket.receive({ ...frames.covering, seq: 3 });
  socket.receive({ ...frames.five, seq: 5 });
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  socket.receive(frames.covering);
  expect(poll.mock.lastCall?.[0].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toHaveBeenLastCalledWith({ value: { count: 5 }, source: "live" });
  socket.receive(frames.withdrawal);
  await vi.advanceTimersByTimeAsync(1_998);
  expect(socket.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(socket.send.mock.lastCall).toEqual(['{"v":1,"type":"resync","topics":["voice"]}']);
  socket.receive(frames.withdrawal, frames.withdrawal, frames.cold);
  expect(seen).toHaveBeenLastCalledWith({ value: { count: 6 }, source: "live" });
  expect(socket.close).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(1);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("retires a timed-out command and ignores its late frames and poll", async () => {
  const poll = vi
    .fn()
    .mockResolvedValueOnce({ count: null })
    .mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ count: 99 }), 8_000)),
    );
  const { seen, start } = fixture(poll);
  const stop = start();
  const first = sockets[0]!.open();
  first.receive(frames.initial);
  first.receive(frames.withdrawal);
  await vi.advanceTimersByTimeAsync(2_000);
  first.receive(frames.withdrawal);
  expect(seen).toHaveBeenLastCalledWith({ value: { count: null }, source: "poll" });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(poll).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6_999);
  expect(first.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(801);
  expect(first.close).toHaveBeenCalledOnce();
  expect(first.send).toHaveBeenCalledTimes(2);
  const second = sockets[1]!.open();
  second.receive(frames.initial);
  first.receive(frames.warm);
  first.dispatchEvent(new Event("close"));
  await vi.advanceTimersByTimeAsync(200);
  expect(seen).toHaveBeenLastCalledWith({ value: { count: null }, source: "live" });
  second.close();
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  stop();
});

it.each([
  { seq: 0 },
  { seq: 1025 },
  { stream: "obsolete" },
  { value: { count: 4 } },
  { value: { count: 5, rooms: [] } },
])("fails closed on invalid public data %j", (overrides) => {
  const { seen, start } = fixture();
  const stop = start();
  const socket = sockets[0]!.open();
  socket.receive(frames.initial);
  socket.receive({ ...frames.five, ...overrides });
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  expect(socket.close).toHaveBeenCalledOnce();
  stop();
});
