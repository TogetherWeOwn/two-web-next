import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserLiveTopic } from "../src/live/browser-topic";

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  send = vi.fn<(data: string) => void>();
  constructor(readonly url: URL) {
    super();
    sockets.push(this);
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  receive(frame: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  data(type: "snapshot" | "patch", seq: number, value: number) {
    this.receive({ v: 1, type, topic: "voice", seq, value });
  }
}

function fixture(read?: (signal: AbortSignal) => Promise<number | null>) {
  const store = createBrowserLiveTopic(
    "voice",
    2,
    (value) => {
      if (typeof value !== "number") throw new Error("Invalid fixture value");
      return value;
    },
    read,
  );
  const seen = vi.fn();
  store.subscribe(seen);
  return { ...store, seen };
}

function openSocket(index = 0) {
  const socket = sockets[index];
  if (!socket) throw new Error(`Expected socket ${index}`);
  socket.readyState = FakeSocket.OPEN;
  socket.dispatchEvent(new Event("open"));
  return socket;
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

it("seeds SSR without I/O and subscribes to the draft v1 endpoint on mount", () => {
  const { seen, start } = fixture();
  expect(seen).toHaveBeenLastCalledWith({ value: 2, source: "ssr" });
  expect(sockets).toHaveLength(0);
  const stop = start();
  const socket = openSocket();
  expect(socket.url.href).toBe("wss://example.test/api/discord-live/v1");
  expect(socket.send.mock.calls).toEqual([['{"v":1,"type":"subscribe","topics":["voice"]}']]);
  socket.data("snapshot", 2, 100);
  socket.data("snapshot", 1, 4);
  socket.data("patch", 2, 7);
  socket.data("patch", 2, 100);
  expect(seen).toHaveBeenLastCalledWith({ value: 7, source: "live" });
  expect(seen).toHaveBeenCalledTimes(3);
  stop();
});

it("drops the projection on a gap and only resumes from a complete forward snapshot", () => {
  const { seen, start } = fixture();
  const stop = start();
  const socket = openSocket();
  socket.data("snapshot", 1, 4);
  socket.data("patch", 4, 100);
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  socket.data("patch", 2, 100);
  socket.data("snapshot", 3, 100);
  expect(seen).toHaveBeenCalledTimes(3);
  expect(socket.send.mock.lastCall).toEqual(['{"v":1,"type":"resync","topics":["voice"]}']);
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.data("snapshot", 5, 8);
  socket.data("patch", 6, 9);
  expect(seen).toHaveBeenLastCalledWith({ value: 9, source: "live" });
  stop();
});

it.each([
  { type: "snapshot", seq: 0, stream: "obsolete", value: 99 },
  { type: "snapshot", seq: 0, value: 99 },
  { type: "unavailable", value: 99 },
  { type: "patch", seq: 2, value: "invalid" },
])("fails closed on invalid wire data: %j", (frame) => {
  const { seen, start } = fixture();
  const stop = start();
  const socket = openSocket();
  socket.data("snapshot", 1, 4);
  socket.receive({ v: 1, topic: "voice", ...frame });
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  stop();
});

it("expires a quiet projection even when duplicate frames arrive", async () => {
  const { seen, start } = fixture();
  const stop = start();
  const first = openSocket();
  first.data("snapshot", 1, 4);
  await vi.advanceTimersByTimeAsync(29_999);
  first.data("snapshot", 1, 99);
  expect(seen).toHaveBeenLastCalledWith({ value: 4, source: "live" });
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  await vi.advanceTimersByTimeAsync(800);
  openSocket(1).data("snapshot", 1, 8);
  first.data("patch", 2, 99);
  first.close();
  expect(seen).toHaveBeenLastCalledWith({ value: 8, source: "live" });
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears unavailable data and does not let an old poll overwrite recovery", async () => {
  let resolve!: (value: number) => void;
  const read = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  const { seen, start } = fixture(read);
  const stop = start();
  const first = openSocket();
  first.data("snapshot", 1, 4);
  first.receive({ v: 1, type: "unavailable", topic: "voice" });
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  await vi.advanceTimersByTimeAsync(800);
  const signal = read.mock.lastCall?.[0];
  expect(signal?.aborted).toBe(false);
  openSocket(1).data("snapshot", 1, 9);
  expect(signal?.aborted).toBe(true);
  resolve(99);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(seen).toHaveBeenLastCalledWith({ value: 9, source: "live" });
  expect(read).toHaveBeenCalledOnce();
  stop();
});

it("bounds the first frame and polls every ten seconds without calling fallback live", async () => {
  const read = vi.fn().mockResolvedValueOnce(10).mockRejectedValueOnce(new Error("offline"));
  const { seen, start } = fixture(read);
  const stop = start();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(seen).toHaveBeenLastCalledWith({ value: 10, source: "poll" });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});
