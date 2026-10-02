import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  DISCORD_READ_DEADLINE_MS as DEADLINE_MS,
  liveDiscordEventsSource,
} from "../src/events/discord-transients";
const now = new Date("2030-01-01T00:00:00Z");
const env = { DISCORD_GUILD_ID: "test-guild", DISCORD_BOT_TOKEN: "test-token" } as Env;
const event = (overrides = {}) => ({
  id: "scheduled",
  name: "Game night",
  status: 1,
  scheduled_start_time: "2030-01-02T20:00:00Z",
  scheduled_end_time: "2030-01-02T22:00:00Z",
  ...overrides,
});

function mockFetch(response: Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stalledBody(cancel = vi.fn(), json = "[") {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json));
    },
    cancel,
  });
  return { response: new Response(body), cancel };
}

// Track completion without awaiting a hung regression or relying on real time.
function startRead(source = liveDiscordEventsSource(env)) {
  let settled = false;
  const result = source.upcoming(now).then((rows) => {
    settled = true;
    return rows;
  });
  return { source, result, settled: () => settled };
}

describe("Discord transient end-to-end deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("finishes and aborts a fetch that never resolves, even when fetch ignores abort", async () => {
    const fetchMock = mockFetch(new Promise<Response>(() => {}));
    const read = startRead();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(read.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    expect(await read.result).toEqual([]);
    expect(read.source.lastReadFailed()).toBe(true);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolves", "rejects", "never resolves"])(
    "cancels a stalled body when cancellation %s",
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === "rejects"
          ? Promise.reject(new Error("cancel failed"))
          : mode === "never resolves"
            ? new Promise<void>(() => {})
            : undefined,
      );
      const { response } = stalledBody(cancel);
      const fetchMock = mockFetch(response);
      const read = startRead();
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(read.settled()).toBe(false);
      expect(response.body!.locked).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(read.settled()).toBe(true);
      expect(await read.result).toEqual([]);
      expect(read.source.lastReadFailed()).toBe(true);
      expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["resolves", "rejects", "never resolves"])(
    "does not parse buffered JSON after timeout when cancellation %s",
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === "rejects"
          ? Promise.reject(new Error("cancel failed"))
          : mode === "never resolves"
            ? new Promise<void>(() => {})
            : undefined,
      );
      const json = JSON.stringify([event()]);
      const { response } = stalledBody(cancel, json);
      const fetchMock = mockFetch(response);
      const parse = vi.spyOn(JSON, "parse");
      const read = startRead();
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(read.settled()).toBe(false);
      expect(response.body!.locked).toBe(true);
      expect(parse).not.toHaveBeenCalledWith(json);
      await vi.advanceTimersByTimeAsync(1);
      expect(read.settled()).toBe(true);
      expect(await read.result).toEqual([]);
      expect(read.source.lastReadFailed()).toBe(true);
      expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(parse).not.toHaveBeenCalledWith(json);
    },
  );

  it("spends one budget across delayed headers and a stalled body, not a new body budget", async () => {
    let headers!: (response: Response) => void;
    mockFetch(
      new Promise<Response>((resolve) => {
        headers = resolve;
      }),
    );
    const { response, cancel } = stalledBody();
    const read = startRead();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 2);
    headers(response);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 2 - 1);
    expect(read.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    expect(await read.result).toEqual([]);
    expect(read.source.lastReadFailed()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it("cancels a response arriving after timeout without reading it or changing the failure flag", async () => {
    let headers!: (response: Response) => void;
    mockFetch(
      new Promise<Response>((resolve) => {
        headers = resolve;
      }),
    );
    const read = startRead();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(read.settled()).toBe(true);
    expect(await read.result).toEqual([]);
    const { response, cancel } = stalledBody();
    const getReader = vi.spyOn(response.body!, "getReader");
    headers(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(read.source.lastReadFailed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a body completed just before the deadline and disarms the timer", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
    const fetchMock = mockFetch(response);
    const read = startRead();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(read.settled()).toBe(false);
    body.enqueue(new TextEncoder().encode(JSON.stringify([event()])));
    body.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    expect(await read.result).toMatchObject([{ discordId: "scheduled" }]);
    expect(read.source.lastReadFailed()).toBe(false);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  });

  it("preserves the horizon/status filters and active events without an end", async () => {
    const horizon = now.getTime() + 90 * 86_400_000;
    const response = Response.json([
      event(),
      event({
        id: "active",
        status: 2,
        scheduled_start_time: "2029-12-31T20:00:00Z",
        scheduled_end_time: null,
      }),
      event({ id: "default-status", status: undefined, scheduled_end_time: undefined }),
      event({
        id: "horizon",
        scheduled_start_time: new Date(horizon).toISOString(),
        scheduled_end_time: null,
      }),
      event({ id: "too-far", scheduled_start_time: new Date(horizon + 1).toISOString() }),
      event({ id: "completed", status: 3 }),
      event({ id: "cancelled", status: 4 }),
      event({ id: "invalid-start", scheduled_start_time: "invalid" }),
      event({ id: "invalid-end", scheduled_end_time: "invalid" }),
      event({ id: "" }),
      event({ name: "" }),
    ]);
    const fetchMock = mockFetch(response);
    const source = liveDiscordEventsSource(env);
    const rows = await source.upcoming(now);
    expect(rows.map((row) => row.discordId)).toEqual([
      "scheduled",
      "active",
      "default-status",
      "horizon",
    ]);
    expect(rows[1]).toMatchObject({ status: "active", endsAt: null });
    expect(rows[2]).toMatchObject({ status: "scheduled", endsAt: null });
    expect(source.lastReadFailed()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/guilds/test-guild/scheduled-events",
      {
        headers: { authorization: "Bot test-token" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  });

  it("decodes streamed JSON with multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([event({ name: "Café 🎮" })]));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    mockFetch(response);
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(now)).toMatchObject([{ title: "Café 🎮" }]);
    expect(source.lastReadFailed()).toBe(false);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["{", "{}", "null"])(
    "retains failure semantics for malformed payload %s",
    async (body) => {
      const response = new Response(body);
      const fetchMock = mockFetch(response);
      const source = liveDiscordEventsSource(env);
      expect(await source.upcoming(now)).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      expect(response.body!.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("drops a malformed row alone without flagging a read failure", async () => {
    const fetchMock = mockFetch(new Response("[null]"));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(now)).toEqual([]);
    expect(source.lastReadFailed()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on non-2xx without consuming a stalled error body", async () => {
    const { response: stalled, cancel } = stalledBody();
    const response = new Response(stalled.body, { status: 503 });
    const getReader = vi.spyOn(response.body!, "getReader");
    const fetchMock = mockFetch(response);
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(now)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a successful response without a JSON body as a failed read", async () => {
    mockFetch(new Response(null, { status: 204 }));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(now)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains network and body error semantics and clears timers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network"));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("body"));
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const source = liveDiscordEventsSource(env);
    for (let i = 0; i < 2; i++) {
      expect(await source.upcoming(now)).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(response.body!.locked).toBe(false);
  });

  it("resets the failure flag after a later successful read", async () => {
    const fetchMock = mockFetch(new Promise<Response>(() => {}));
    const read = startRead();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(read.settled()).toBe(true);
    expect(await read.result).toEqual([]);
    expect(read.source.lastReadFailed()).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json([]));
    expect(await read.source.upcoming(now)).toEqual([]);
    expect(read.source.lastReadFailed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
