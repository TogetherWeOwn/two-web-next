// Acceptance: one shared Retry-After parser across transports.
//
// Three call sites read a provider 429's `retry-after` header today, each
// with its own spelling:
//   - the Discord OAuth error path (`src/discord.ts`, surfaced as
//     `DiscordError.retryAfter`),
//   - the live Discord scheduled-events reader
//     (`src/events/discord-transients-live.ts`, surfaced as
//     `ReadFailure.retryAfter` via `lastReadFailure()`),
//   - the signed bot transport (`src/bot/client-transport.ts`, surfaced as
//     `BotFailure.retryAfterSeconds`, `null` where the others use
//     `undefined`).
//
// The contract under test: all three return ONE shared mapping —
// numeric-only delta-seconds (no HTTP dates, signs, units or markup),
// fractions rounded UP so no caller retries sooner than the provider
// asked, values that ceil below 1 second are unusable, and
// representable-but-absurd values cap at MAX_RETRY_DELAY_SECONDS instead
// of echoing raw. Anything unusable is undefined (bot seam: null) so the
// caller keeps its existing headerless/fallback behavior. Only a 429
// carries backoff; every non-429 and headerless behavior is unchanged.
//
// Hermetic: stubbed fetch only, no live Discord or bot calls, no DB.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { DiscordError, exchangeCode } from "../src/discord";
import type { Env } from "../src/env";
import { liveDiscordEventsSource } from "../src/events/discord-transients-live";
import { MAX_RETRY_DELAY_SECONDS } from "../src/jobs/retry-delay";

/** `null` header = the header is absent from the stubbed response. */
type HeaderValue = string | null;

/**
 * The shared mapping, normalized to `number | undefined` at every seam
 * (the bot driver converts its `null` fallback to `undefined`).
 * `999999999` is representable (well under the millisecond-safe bound)
 * but far past the cap, so it must clamp, not echo.
 */
const MATRIX: { label: string; header: HeaderValue; expected: number | undefined }[] = [
  { label: "fraction 1.2 ceils to 2", header: "1.2", expected: 2 },
  { label: "zero is unusable", header: "0", expected: undefined },
  { label: "non-numeric abc is unusable", header: "abc", expected: undefined },
  { label: "huge value caps at MAX", header: "999999999", expected: MAX_RETRY_DELAY_SECONDS },
  { label: "absent header is unusable", header: null, expected: undefined },
  { label: "whole seconds pass through", header: "42", expected: 42 },
  { label: "sub-second fraction ceils to 1", header: "0.5", expected: 1 },
  { label: "exactly MAX stays MAX", header: "86400", expected: MAX_RETRY_DELAY_SECONDS },
  { label: "one past MAX caps at MAX", header: "86401", expected: MAX_RETRY_DELAY_SECONDS },
  {
    label: "HTTP date is unusable",
    header: "Wed, 21 Oct 2015 07:28:00 GMT",
    expected: undefined,
  },
  { label: "negative value is unusable", header: "-1", expected: undefined },
  { label: "empty header is unusable", header: "", expected: undefined },
];

function retryAfterHeaders(header: HeaderValue): Record<string, string> {
  return header === null ? {} : { "retry-after": header };
}

const NOW = new Date("2030-01-01T00:00:00Z");
const eventsEnv = {
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot-token",
} as Env;
const botOpts = {
  url: "https://bot.example.test",
  secret: "fixture-secret",
  keyId: "web-fixture",
};
const uuid = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";

/** Discord OAuth seam: a 429 token exchange throws DiscordError. */
async function discordRetryAfter(
  header: HeaderValue,
  status = 429,
  body = "{}",
): Promise<{ retryAfter: number | undefined; kind: string; status: number }> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: retryAfterHeaders(header) })),
  );
  const err = await exchangeCode(
    "fixture-code",
    "fixture-client",
    "fixture-secret",
    "https://example.test/auth/discord/callback",
  ).catch((e: unknown) => e);
  if (!(err instanceof DiscordError)) throw new Error("expected a DiscordError");
  return { retryAfter: err.retryAfter, kind: err.kind, status: err.status };
}

/** Events seam: a failed live read records its failure for the caller. */
async function eventsRetryAfter(
  header: HeaderValue,
  status = 429,
): Promise<{ retryAfter: number | undefined; status: number | undefined }> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status, headers: retryAfterHeaders(header) })),
  );
  const source = liveDiscordEventsSource(eventsEnv);
  expect(await source.upcoming(NOW)).toEqual([]);
  expect(source.lastReadFailed()).toBe(true);
  const failure = source.lastReadFailure?.();
  if (!failure) throw new Error("expected a recorded read failure");
  return { retryAfter: failure.retryAfter, status: failure.status };
}

/** Bot seam: a 429 `rate_limited` refusal carries `retryAfterSeconds`. */
async function botRetryAfter(
  header: HeaderValue,
  status = 429,
  code = "rate_limited",
): Promise<number | null> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code, message: "slow", retryable: true },
          request_id: "r1",
        }),
        {
          status,
          headers: { "content-type": "application/json", ...retryAfterHeaders(header) },
        },
      ),
  );
  const client = createBotClient({ ...botOpts, fetchFn: fetchFn as unknown as typeof fetch });
  const result = await client.postAnnouncement({ channelKey: "c", body: "b" }, uuid);
  if (result.ok) throw new Error("expected a bot refusal");
  return result.retryAfterSeconds;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared Retry-After parser acceptance", () => {
  it("pins MAX as the documented 24h ceiling the matrix clamps to", () => {
    expect(MAX_RETRY_DELAY_SECONDS).toBe(86400);
  });

  describe("Discord OAuth call site (DiscordError.retryAfter)", () => {
    it.each(MATRIX)("$label via header $header", async ({ header, expected }) => {
      const { retryAfter, kind, status } = await discordRetryAfter(header);
      expect(status).toBe(429);
      expect(kind).toBe("rate_limited");
      expect(retryAfter).toBe(expected);
    });

    it("non-429 outage never carries backoff, even with a usable header", async () => {
      const { retryAfter, kind } = await discordRetryAfter("42", 500);
      expect(kind).toBe("provider_outage");
      expect(retryAfter).toBeUndefined();
    });

    it("non-429 expired grant never carries backoff", async () => {
      const { retryAfter, kind } = await discordRetryAfter(
        "42",
        400,
        JSON.stringify({ error: "invalid_grant" }),
      );
      expect(kind).toBe("expired_grant");
      expect(retryAfter).toBeUndefined();
    });
  });

  describe("Discord scheduled-events call site (ReadFailure.retryAfter)", () => {
    it.each(MATRIX)("$label via header $header", async ({ header, expected }) => {
      const { retryAfter, status } = await eventsRetryAfter(header);
      expect(status).toBe(429);
      expect(retryAfter).toBe(expected);
    });

    it("non-429 statuses never carry backoff, even with a usable header", async () => {
      for (const status of [500, 403]) {
        const { retryAfter, status: recorded } = await eventsRetryAfter("42", status);
        expect(recorded).toBe(status);
        expect(retryAfter).toBeUndefined();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("a successful read is unchanged: no failure recorded", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json([], { headers: { "retry-after": "42" } })),
      );
      const source = liveDiscordEventsSource(eventsEnv);
      expect(await source.upcoming(NOW)).toEqual([]);
      expect(source.lastReadFailed()).toBe(false);
      expect(source.lastReadFailure?.() ?? null).toBeNull();
    });
  });

  describe("bot transport call site (BotFailure.retryAfterSeconds)", () => {
    it.each(MATRIX)("$label via header $header", async ({ header, expected }) => {
      // The bot seam adapts the shared undefined fallback to null.
      expect(await botRetryAfter(header)).toBe(expected ?? null);
    });

    it("a non-429 refusal never carries backoff, even with a usable header", async () => {
      expect(await botRetryAfter("42", 409, "in_progress")).toBeNull();
    });

    it("a 429 that is not rate_limited never carries backoff", async () => {
      expect(await botRetryAfter("42", 429, "in_progress")).toBeNull();
    });

    it("a successful call is unchanged by a stray header", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, result: { message_id: "m1" }, request_id: "r1" }),
            {
              status: 200,
              headers: { "content-type": "application/json", "retry-after": "42" },
            },
          ),
      );
      const client = createBotClient({ ...botOpts, fetchFn: fetchFn as unknown as typeof fetch });
      await expect(
        client.postAnnouncement({ channelKey: "c", body: "b" }, uuid),
      ).resolves.toMatchObject({ ok: true, messageId: "m1" });
    });
  });

  describe("one mapping across all three call sites", () => {
    it.each(MATRIX)(
      "all three seams agree: $label via header $header",
      async ({ header, expected }) => {
        const discord = (await discordRetryAfter(header)).retryAfter;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        const events = (await eventsRetryAfter(header)).retryAfter;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        const bot = (await botRetryAfter(header)) ?? undefined;
        expect(discord).toBe(expected);
        expect(events).toBe(expected);
        expect(bot).toBe(expected);
        expect(new Set([discord, events, bot]).size).toBe(1);
      },
    );
  });
});
