import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveTopic, type TopicFrame } from "../src/live/client-topic";

class FakeSocket extends EventTarget {
  close() {
    this.dispatchEvent(new Event("close"));
  }

  send = vi.fn<(data: string) => void>();

  receive(frame: TopicFrame<number>) {
    this.dispatchEvent(new MessageEvent("message", { data: frame }));
  }

  snapshot(value: number, stream = "first") {
    this.receive({ kind: "snapshot", value, stream, seq: 0 });
  }

  patch(seq: number, value: number, stream = "first") {
    this.receive({ kind: "patch", value, stream, seq });
  }
}

function fixture(
  read = vi.fn<(signal: AbortSignal) => Promise<number | null>>().mockResolvedValue(10),
) {
  const sockets: FakeSocket[] = [];
  const store = createLiveTopic(2, {
    open() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    decode: (data) => data as TopicFrame<number>,
    resync: (socket) => socket.send("resync"),
    poll: read,
  });
  const seen = vi.fn();
  store.subscribe(seen);
  function socket(index: number) {
    const result = sockets[index];
    if (!result) throw new Error(`Expected socket ${index}`);
    return result;
  }
  return { ...store, read, seen, socket, sockets };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Kit live topic", () => {
  it("renders the SSR snapshot without I/O, then applies only ordered patches", () => {
    const { socket, sockets, seen, read, start } = fixture();
    expect(seen).toHaveBeenLastCalledWith({ value: 2, source: "ssr" });
    expect(sockets).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    const stop = start();
    socket(0).snapshot(4);
    socket(0).patch(1, 7);
    socket(0).patch(2, 8);
    socket(0).patch(2, 100);
    socket(0).patch(1, 100);
    expect(seen).toHaveBeenLastCalledWith({ value: 8, source: "live" });
    expect(seen).toHaveBeenCalledTimes(4);
    stop();
  });

  it("discards the skipped patch and the old projection, then resyncs before accepting new patches", async () => {
    const { socket, sockets, seen, read, start } = fixture();
    const stop = start();
    socket(0).snapshot(4);
    socket(0).patch(2, 100);
    expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
    socket(0).patch(1, 100);
    socket(0).snapshot(100);
    expect(socket(0).send.mock.calls).toEqual([["resync"]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(seen).toHaveBeenLastCalledWith({ value: 10, source: "poll" });
    socket(0).snapshot(5, "second");
    socket(0).patch(1, 6, "second");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveBeenLastCalledWith({ value: 6, source: "live" });
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps one 10-second poll while reconnecting and labels failed reads stale", async () => {
    const { socket, sockets, seen, read, start } = fixture();
    read.mockResolvedValueOnce(10).mockRejectedValueOnce(new Error("unavailable"));
    const stop = start();
    // An open socket without a snapshot must not claim live or stall fallback.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toHaveBeenLastCalledWith({ value: 10, source: "poll" });
    await vi.advanceTimersByTimeAsync(800);
    socket(1).close();
    await vi.advanceTimersByTimeAsync(1_599);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(7_600);
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled poll even when the transport ignores abort", async () => {
    const { socket, seen, read, start } = fixture();
    read.mockImplementationOnce(() => new Promise(() => undefined));
    const stop = start();
    socket(0).close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.mock.lastCall?.[0].aborted).toBe(true);
    expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith({ value: 10, source: "poll" });
    stop();
  });

  it("requests a baseline for an unknown stream and reconnects when it times out", async () => {
    const { socket, seen, start } = fixture();
    const stop = start();
    socket(0).snapshot(4);
    socket(0).patch(1, 99, "unknown");
    expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
    expect(socket(0).send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_800);
    socket(1).snapshot(8, "second");
    expect(seen).toHaveBeenLastCalledWith({ value: 8, source: "live" });
    stop();
  });

  it("aborts an in-flight poll on recovery and ignores its late result", async () => {
    let resolve!: (value: number) => void;
    const pending = new Promise<number>((done) => {
      resolve = done;
    });
    const { socket, seen, read, start } = fixture();
    read.mockReturnValueOnce(pending);
    const stop = start();
    socket(0).snapshot(4);
    socket(0).receive({ kind: "reset" });
    expect(seen).toHaveBeenLastCalledWith({ value: null, source: "stale" });
    await vi.advanceTimersByTimeAsync(800);
    const signal = read.mock.lastCall?.[0];
    expect(signal?.aborted).toBe(false);
    socket(1).snapshot(9, "second");
    expect(signal?.aborted).toBe(true);
    resolve(99);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveBeenLastCalledWith({ value: 9, source: "live" });
    stop();
  });
});
