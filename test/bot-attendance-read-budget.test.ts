import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedAttendanceReader } from "../src/bot/attendance-read";
import { encodeCanonicalJson } from "../src/bot/signer";

// Acceptance contract for the signed event.attendance.read transport: the
// reader must settle inside its 2.5-second observation budget and refuse
// oversized bodies before parsing, even when the injected transport ignores
// the abort signal or its cleanup never settles. The byte ceiling is the
// existing 256 KiB provider-buffer convention (src/discord-http.ts). Wire
// discipline mirrors event.read (test/bot-event-read-budget.test.ts).
const BUDGET_MS = 2_500;
const MAX_BYTES = 262_144;
const MARKER = "provider-body-marker-must-not-leak";
const KEY = "01KTESTEVENTKEY000000000001";

const cfg = {
  baseUrl: "https://bot.fixture.test",
  keyId: "fixture-key",
  secret: "fixture-secret-not-a-credential",
};
const unreachable = { ok: false, code: "bot_unreachable" };

function goodDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    event_key: KEY,
    window: { starts_at: "2026-10-20T18:00:00Z", ends_at: "2026-10-20T21:00:00Z" },
    threshold_minutes: 10,
    peak_concurrent: 24,
    rooms: [{ channel_id: "111111111111111111", name_at_close: "Tavern" }],
    members: [
      {
        discord_id: "900000000000000001",
        minutes: 95,
        sessions: 2,
        first_joined_at: "2026-10-20T18:05:00Z",
      },
    ],
    final: true,
    ...overrides,
  };
}

const relayed = (result: unknown) => ({ ok: true, result });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const encoder = new TextEncoder();
const jsonBytes = (body: unknown) => encoder.encode(JSON.stringify(body));

function outcome<T>(promise: Promise<T>) {
  let result: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => {
      result = { value };
    },
    (error) => {
      result = { error };
    },
  );
  return () => result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CancelHook = () => void | Promise<void>;

function streamBody(
  chunks: Uint8Array[],
  { close = true, cancel = vi.fn<CancelHook>() }: { close?: boolean; cancel?: unknown } = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(chunk);
      if (close) c.close();
    },
    cancel: cancel as CancelHook,
  });
  return { body, cancel: cancel as ReturnType<typeof vi.fn>, controller: () => controller };
}

function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

const read = (fetcher: typeof fetch) => signedAttendanceReader(cfg, fetcher)(KEY);

// Signing the request is real async crypto: under fake timers a bare
// advanceTimersByTimeAsync(BUDGET) can fire before the fetcher is ever
// invoked, and zero-millisecond advances do not give the crypto work
// wall-clock time. Wait (real time, zero fake milliseconds) until the
// single attempt is on the wire, so the budget advances below measure
// transport time only.
async function untilFetcherCalled(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  const deadline = vi.getRealSystemTime() + 2_000;
  while (fetcher.mock.calls.length === 0 && vi.getRealSystemTime() < deadline) {
    await realDelay(1);
  }
  expect(fetcher.mock.calls.length).toBe(1);
}

// Wait (real time, zero fake milliseconds) for microtask-driven settlement;
// on timeout the caller's own assertion reports the unsettled state.
async function flushUntil(condition: () => boolean) {
  await vi
    .waitFor(() => expect(condition()).toBe(true), { timeout: 2_000, interval: 1 })
    .catch(() => {});
}

// Yield a few event-loop turns under the fake clock so late handlers and
// unhandled-rejection checkpoints can run, without consuming fake budget.
async function flushRounds(rounds = 5) {
  for (let round = 0; round < rounds; round++) await vi.advanceTimersByTimeAsync(0);
}

// A transport gate that owns its in-flight observation, so a test that fails
// before settlement cannot leak a stray budget timer onto a later test's
// fresh fake clock (precedent: test/bot-event-read-budget.test.ts).
function startGatedObservation() {
  const gate = deferred<Response>();
  void gate.promise.catch(() => {});
  const fetcher = vi.fn<typeof fetch>(() => gate.promise);
  const pending = read(fetcher);
  const result = outcome(pending);
  return {
    gate,
    fetcher,
    result,
    settle: async () => {
      gate.reject(new Error("test teardown settles abandoned observation"));
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await pending;
    },
  };
}

// Every fetcher is a local stub, never the staging bot or a live guild.
describe("signed bot event.attendance.read budget and byte ceiling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("positive controls: existing behaviour is unchanged", () => {
    it("signs the exact canonical body, with a UUID header and one bounded nonredirecting attempt", async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(relayed(goodDoc())));
      const pending = read(fetcher);
      await untilFetcherCalled(fetcher);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://bot.fixture.test/internal/actions");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "manual",
        body: encodeCanonicalJson({ action: "event.attendance.read", event_key: KEY }),
      });
      const h = init!.headers as Record<string, string>;
      expect(h["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      expect(await pending).toEqual({ ok: true, attendance: goodDoc() });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns a valid chunked payload under the ceiling byte-for-byte", async () => {
      const doc = goodDoc({
        rooms: [{ channel_id: "111111111111111111", name_at_close: "Café Night" }],
      });
      const bytes = jsonBytes(relayed(doc));
      // Split inside the two-byte "é" so only true byte buffering survives.
      const split = bytes.indexOf(0xc3) + 1;
      const { body } = streamBody([
        bytes.slice(0, split),
        bytes.slice(split, split + 3),
        bytes.slice(split + 3),
      ]);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      expect(await read(fetcher)).toEqual({ ok: true, attendance: doc });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the typed bot error code and never leaks the provider body", async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "action_not_allowed", message: MARKER },
            extra: MARKER,
          }),
          { status: 403 },
        ),
      );
      const answer = await read(fetcher);
      expect(answer).toEqual({ ok: false, code: "action_not_allowed" });
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe("owned deadline settlement", () => {
    it("settles a never-resolving fetch that ignores the abort signal at the budget", async () => {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof fetch>((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const result = outcome(read(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
      expect(result()).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(result()).toEqual({ value: unreachable });
      expect(signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("settles a transport that honours the abort signal by the same budget", async () => {
      const fetcher = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("fixture abort")), {
              once: true,
            });
          }),
      );
      const result = outcome(read(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      expect(result()).toEqual({ value: unreachable });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a body that stalls after headers and settles at the budget", async () => {
      const { body, cancel } = streamBody([], { close: false });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(read(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
      expect(result()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not reset the deadline at headers or after partial body progress", async () => {
      const { body, cancel, controller } = streamBody([], { close: false });
      const gated = startGatedObservation();
      const { gate, fetcher, result } = gated;
      try {
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS - 100);
        gate.resolve(new Response(body, { status: 200 }));
        await vi.advanceTimersByTimeAsync(0);
        controller().enqueue(encoder.encode("{"));
        await vi.advanceTimersByTimeAsync(99);
        expect(result()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(result()).toEqual({ value: unreachable });
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await gated.settle();
      }
    });

    it("settles even when body cancellation itself never resolves", async () => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const { body } = streamBody([], { close: false, cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(read(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("fixture cancel rejection"))],
      [
        "throws",
        () => {
          throw new Error("fixture cancel throw");
        },
      ],
    ])("settles without an unhandled rejection when cancellation %s", async (_name, hook) => {
      const unhandled = trackUnhandledRejections();
      try {
        const cancel = vi.fn(hook);
        const { body } = streamBody([], { close: false, cancel });
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body, { status: 200 }));
        const result = outcome(read(fetcher));
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        expect(cancel).toHaveBeenCalledOnce();
        await flushRounds();
        expect(unhandled.seen).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unhandled.stop();
      }
    });

    it("cancels headers that arrive after the deadline and keeps the settled answer", async () => {
      const unhandled = trackUnhandledRejections();
      const gated = startGatedObservation();
      const { gate, fetcher, result } = gated;
      try {
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        const { body, cancel } = streamBody([jsonBytes(relayed(goodDoc()))], {
          close: false,
        });
        gate.resolve(new Response(body, { status: 200 }));
        await flushUntil(() => cancel.mock.calls.length > 0);
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(result()).toEqual({ value: unreachable });
        expect(unhandled.seen).toEqual([]);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await gated.settle();
        unhandled.stop();
      }
    });

    it("a late transport rejection cannot change the settled answer or escape unhandled", async () => {
      const unhandled = trackUnhandledRejections();
      const gated = startGatedObservation();
      const { gate, fetcher, result } = gated;
      try {
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        gate.reject(new Error(`late transport failure ${MARKER}`));
        await flushRounds();
        expect(result()).toEqual({ value: unreachable });
        expect(JSON.stringify(result())).not.toContain(MARKER);
        expect(unhandled.seen).toEqual([]);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await gated.settle();
        unhandled.stop();
      }
    });
  });

  describe("response-byte ceiling before parsing", () => {
    it("refuses chunked JSON whose chunks cross the ceiling cumulatively", async () => {
      const bytes = jsonBytes(relayed(goodDoc()));
      const chunks: Uint8Array[] = [];
      const filler = new Uint8Array(65_536);
      let total = bytes.byteLength;
      chunks.push(bytes);
      while (total <= MAX_BYTES) {
        chunks.push(filler);
        total += filler.byteLength;
      }
      // Leave the stream open: settlement here can only come from the byte
      // ceiling, never from end-of-body or the 2.5-second deadline.
      const { body, cancel } = streamBody(chunks, { close: false });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(read(fetcher));
      await untilFetcherCalled(fetcher);
      await flushUntil(() => result() !== undefined);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      await flushRounds();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never leaks an oversized provider body into the answer", async () => {
      const poisoned = { ...relayed(goodDoc()), padding: `${MARKER}${"x".repeat(MAX_BYTES)}` };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(poisoned), { status: 200 }));
      const answer = await read(fetcher);
      expect(answer).toEqual(unreachable);
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe("fail-closed body handling", () => {
    it("fails closed when decoding throws", async () => {
      const decode = vi.spyOn(TextDecoder.prototype, "decode").mockImplementationOnce(() => {
        throw new Error("fixture decode failure");
      });
      try {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(relayed(goodDoc())));
        expect(await read(fetcher)).toEqual(unreachable);
      } finally {
        decode.mockRestore();
      }
    });

    it("fails closed when the stream read throws", async () => {
      const fakeBody = {
        getReader: () => ({
          read: async () => {
            throw new Error("fixture read failure");
          },
          cancel: () => {},
          releaseLock: () => {},
        }),
      } as unknown as ReadableStream<Uint8Array>;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue({ status: 200, ok: true, body: fakeBody } as unknown as Response);
      expect(await read(fetcher)).toEqual(unreachable);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("tolerates a throwing releaseLock", async () => {
      const fakeBody = {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: () => {},
          releaseLock: () => {
            throw new Error("fixture release failure");
          },
        }),
      } as unknown as ReadableStream<Uint8Array>;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue({ status: 200, ok: true, body: fakeBody } as unknown as Response);
      expect(await read(fetcher)).toEqual(unreachable);
    });
  });
});
