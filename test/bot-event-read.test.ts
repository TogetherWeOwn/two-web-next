import { describe, expect, it, vi } from "vitest";
import { observeDiscordEvent, signedEventReader } from "../src/bot/event-read";
import { encodeCanonicalJson, signInternalAction } from "../src/bot/signer";

const cfg = {
  baseUrl: "https://bot.fixture.test",
  keyId: "fixture-key",
  secret: "fixture-secret-not-a-credential",
};
const local = { event_key: "01FIXTURE000000000000000000", discord_event_id: "1545644954272137000" };
const observation = {
  event_id: local.discord_event_id,
  name: "Independent bot name",
  starts_at: "2030-07-01T19:00:00Z",
  location: "Voice",
  status: "scheduled",
  observed_at: "2030-07-01T18:00:00Z",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Every fetcher is a local stub, never the staging bot or a live guild.
describe("signed bot event.read observation", () => {
  it("never calls a bot for a row that was never mirrored", async () => {
    const read = vi.fn();
    expect(await observeDiscordEvent({ ...local, discord_event_id: null }, read)).toEqual({
      unavailable: "verification_unavailable",
      reason: "never_mirrored",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("signs the exact canonical body, with a UUID header and one bounded nonredirecting attempt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ ok: true, result: observation }));
    const reader = signedEventReader(cfg, fetcher);
    expect(await observeDiscordEvent(local, reader)).toEqual(observation);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://bot.fixture.test/internal/actions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: encodeCanonicalJson({ action: "event.read", event_key: local.event_key }),
    });
    const h = init!.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init!.body).not.toContain("idempotency");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(h).toMatchObject(
      await signInternalAction(
        cfg.keyId,
        cfg.secret,
        init!.body as string,
        Number(h["X-TWO-Timestamp"]),
        h["X-TWO-Nonce"]!,
      ),
    );
  });

  it("returns typed bot failure codes, not messages or local mirror claims", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(
          { ok: false, error: { code: "action_not_allowed", message: "private bot detail" } },
          403,
        ),
      );
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "action_not_allowed",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed on a mismatched ID even when every other field looks right", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ ok: true, result: { ...observation, event_id: "other" } }));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "mirror_mismatch",
    });
  });

  it("a redirect is unreachable, never parsed as an observation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: observation }), {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      }),
    );
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("transport failure has no retry or alternate credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture transport detail"));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { ...cfg, secret: "" },
    { ...cfg, keyId: "" },
    { ...cfg, baseUrl: "http://bot.fixture.test" },
    { ...cfg, baseUrl: "https://user:password@bot.fixture.test" },
  ])("unconfigured/unsafe endpoint is unavailable without any request: %j", async (config) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await observeDiscordEvent(local, signedEventReader(config, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { result: observation },
    { ok: true, result: { ...observation, observed_at: null } },
    { ok: true, result: { ...observation, event_id: {} } },
    { ok: false, error: { message: "no code" } },
    { error: { code: "missing_ok" } },
    { ok: false, error: { code: "unsafe code with message" } },
  ])("malformed reply is unavailable: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("normalizes the legacy optional location and scalar fields without inventing values", async () => {
    const { location: _location, ...result } = observation;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ ok: true, result: { ...result, name: 123 } }));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      ...result,
      name: "123",
      location: null,
    });
  });

  it("is unavailable without a reader and without leaking", async () => {
    expect(await observeDiscordEvent(local)).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("a throwing reader fails closed without leaking", async () => {
    const read = vi.fn().mockRejectedValue(new Error("fixture read detail"));
    expect(await observeDiscordEvent(local, read)).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("an unusable endpoint fails closed without any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await observeDiscordEvent(local, signedEventReader({ ...cfg, baseUrl: "notaurl" }, fetcher)),
    ).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const encoder = new TextEncoder();
const nullBody = (text: () => Promise<string>, status = 200) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    body: null,
    text,
  }) as unknown as Response;

// Fallback paths the streaming suite never exercises: transports without a
// byte stream, cleanup hooks that throw, and abort races that resolve late.
describe("signed bot event.read fallback coverage", () => {
  it("reads a null-body response via text()", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(nullBody(async () => JSON.stringify({ ok: true, result: observation })));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual(observation);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed when null-body text() rejects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(nullBody(() => Promise.reject(new Error("fixture text failure"))));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("refuses a null-body response over the byte ceiling before parsing", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(nullBody(async () => "x".repeat(262_145)));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("fails closed on malformed null-body JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(nullBody(async () => "not json"));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("throws on text that outlives the budget instead of parsing late bytes", async () => {
    vi.useFakeTimers();
    try {
      let resolveText!: (value: string) => void;
      const textGate = new Promise<string>((resolve) => {
        resolveText = resolve;
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(nullBody(() => textGate));
      const pending = observeDiscordEvent(local, signedEventReader(cfg, fetcher));
      for (let i = 0; i < 50 && fetcher.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await pending).toEqual({
        unavailable: "verification_unavailable",
        reason: "bot_unreachable",
      });
      resolveText(JSON.stringify({ ok: true, result: observation }));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a throwing cancel hook on a redirect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
      status: 302,
      ok: false,
      body: {
        cancel: () => {
          throw new Error("fixture cancel throw");
        },
      },
    } as unknown as Response);
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("fails closed when the stream errors without an abort", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("fixture read failure"));
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });

  it("throws on stream data that arrives after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;
      const readGate = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        resolveRead = resolve;
      });
      let calls = 0;
      const fakeBody = {
        getReader: () => ({
          read: () => {
            calls += 1;
            if (calls === 1)
              return Promise.resolve({
                done: false,
                value: encoder.encode('{"ok":true,'),
              });
            return readGate;
          },
          cancel: () => {},
          releaseLock: () => {},
        }),
      } as unknown as ReadableStream<Uint8Array>;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue({ status: 200, ok: true, body: fakeBody } as unknown as Response);
      const pending = observeDiscordEvent(local, signedEventReader(cfg, fetcher));
      for (let i = 0; i < 50 && fetcher.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await pending).toEqual({
        unavailable: "verification_unavailable",
        reason: "bot_unreachable",
      });
      resolveRead({ done: false, value: encoder.encode("]}") });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when decoding throws", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode").mockImplementationOnce(() => {
      throw new Error("fixture decode failure");
    });
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ ok: true, result: observation }));
      expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
        unavailable: "verification_unavailable",
        reason: "bot_unreachable",
      });
    } finally {
      decode.mockRestore();
    }
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
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable",
      reason: "bot_unreachable",
    });
  });
});
