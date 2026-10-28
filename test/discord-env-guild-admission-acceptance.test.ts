// Acceptance: the env-configured Discord guild id (`DISCORD_GUILD_ID`) is
// charset-admitted before it can shape the bot-credentialed
// guild-scheduled-events request in the live transient reader.
//
// Contract pinned here (derived from the feature spec, not from any
// implementation):
// - `admitDiscordGuildId(value)` and `DiscordGuildIdConfigError` are
//   exported from `src/events/discord-transients-live` (the module that
//   builds the credentialed URL; re-exports from elsewhere are fine).
// - Admission accepts ASCII digits only, bounded at 20 characters (the
//   snowflake bound already used for Discord ids elsewhere in this repo:
//   20 digits pass, 21 refuse). The value is tested as-is: no trimming,
//   coercion or percent-decoding, so padded, whitespace-bearing, newline-
//   bearing, empty, overlong, non-digit and non-string values all refuse.
//   Leading-zero handling is deliberately unpinned.
// - Refusal throws the named configuration error: an instance of
//   `DiscordGuildIdConfigError` whose `name` is that string and whose
//   message names `DISCORD_GUILD_ID`. The message must not echo the
//   refused value or any credential, so a hostile value cannot ride the
//   error into a log line.
// - Through `liveDiscordEventsSource`, a bad guild id surfaces that same
//   named error (at source construction or on the first `upcoming()`
//   call — either seam is acceptable) and fires zero fetches: no
//   `Bot`-credentialed request is ever emitted. Swallowing the refusal
//   into the generic failed-read empty list does not satisfy this.
// - A good guild id fetches exactly
//   `https://discord.com/api/v10/guilds/<encodeURIComponent(id)>/scheduled-events`
//   with the bot authorization header. Admitted ids are digits, which
//   path-encode to themselves, so the exact-URL assertion is the encoding
//   pin available at this seam.
// - Existing valid-id behaviour is unchanged: a 2xx payload maps to
//   transients with `lastReadFailed()` false, and a non-2xx answer stays
//   the failed-read fallback (empty list, `lastReadFailed()` true).
//
// Hermetic: stubbed fetch only — no live Discord calls, no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import * as live from "../src/events/discord-transients-live";
import { liveDiscordEventsSource } from "../src/events/discord-transients-live";

type AdmitGuildId = (value: unknown) => string;
type GuildConfigErrorCtor = new (...args: never[]) => Error;

// Accessed through the module namespace so this suite compiles and each
// case fails individually while the helper does not exist yet, instead of
// collapsing into a single import error.
const moduleExports = live as unknown as Record<string, unknown>;
const admitDiscordGuildId = moduleExports.admitDiscordGuildId as AdmitGuildId | undefined;
const DiscordGuildIdConfigError = moduleExports.DiscordGuildIdConfigError as
  | GuildConfigErrorCtor
  | undefined;

const NOW = new Date("2030-01-01T00:00:00Z");
const GUILD = "326474832151838730";
const AT_CAP = "9".repeat(20);
const BOT_TOKEN = "fixture-only-bot-token";

function envWithGuild(guildId: unknown): Env {
  return {
    APP_URL: "https://calendar.example.test",
    DISCORD_GUILD_ID: guildId,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
  } as unknown as Env;
}

function expectNamedConfigError(thrown: unknown): Error {
  expect(DiscordGuildIdConfigError).toBeTypeOf("function");
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toBeInstanceOf(DiscordGuildIdConfigError!);
  const err = thrown as Error;
  expect(err.name).toBe("DiscordGuildIdConfigError");
  expect(err.message).toContain("DISCORD_GUILD_ID");
  expect(err.message).not.toContain(BOT_TOKEN);
  return err;
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

type Call = { url: string; authorization: string | null };

function recordingFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
      });
      return answer();
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return calls;
}

function healthyEvent() {
  return {
    id: "1545955994972987422",
    name: "Healthy raid",
    description: "Bring a squad",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    scheduled_end_time: "2030-01-02T21:00:00Z",
    status: 1,
    entity_metadata: { location: "Lobby" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admitDiscordGuildId", () => {
  it("is exported with its named configuration error", () => {
    expect(admitDiscordGuildId).toBeTypeOf("function");
    expect(DiscordGuildIdConfigError).toBeTypeOf("function");
  });

  it.each([
    ["a realistic 18-digit guild snowflake", GUILD],
    ["a 17-digit id", "1".repeat(17)],
    ["a 19-digit id", "1".repeat(19)],
    ["an id at exactly the 20-digit cap", AT_CAP],
  ])("admits %s unchanged", (_label, value) => {
    expect(admitDiscordGuildId!(value)).toBe(value);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading space", ` ${GUILD}`],
    ["trailing space", `${GUILD} `],
    ["inner space", "3264748321 51838730"],
    ["a tab", `${GUILD}\t`],
    ["an inner newline", "3264748321\n51838730"],
    ["a trailing newline", `${GUILD}\n`],
    ["a trailing carriage return", `${GUILD}\r`],
    ["a trailing CRLF", `${GUILD}\r\n`],
    ["21 digits (one over the cap)", "9".repeat(21)],
    ["100 digits", "9".repeat(100)],
    ["letters", "fixture-guild"],
    ["an alphanumeric mix", "123abc456"],
    ["a path separator", "111/222"],
    ["path traversal", "../111"],
    ["a query opener", "111?admin=1"],
    ["a fragment opener", "111#frag"],
    ["a percent-encoded slash", "111%2f222"],
    ["a backslash", "111\\222"],
    ["an authority separator", "111@222"],
    ["a minus sign", "-123"],
    ["a plus sign", "+123"],
    ["a decimal point", "123.5"],
    ["fullwidth digits", "１２３４５６"],
    ["Arabic-Indic digits", "١٢٣٤٥٦"],
  ])("refuses %s with the named configuration error", (_label, value) => {
    expectNamedConfigError(captureThrow(() => admitDiscordGuildId!(value)));
  });

  it.each([
    ["undefined (unset env)", undefined],
    ["null", null],
    ["a number, not a string", 326474832151838730],
    ["a boolean", true],
    ["an object", { id: GUILD }],
  ])("refuses %s with the named configuration error", (_label, value) => {
    expectNamedConfigError(captureThrow(() => admitDiscordGuildId!(value)));
  });

  it("never echoes the refused value in the error message", () => {
    const marker = "refused-guild-marker";
    const err = expectNamedConfigError(
      captureThrow(() => admitDiscordGuildId!(`${marker}\n${GUILD}`)),
    );
    expect(err.message).not.toContain(marker);
    expect(err.message).not.toContain(GUILD);
  });
});

describe("liveDiscordEventsSource guild admission", () => {
  it.each([
    ["empty", ""],
    ["whitespace-padded", ` ${GUILD} `],
    ["newline-bearing", `${GUILD}\n`],
    ["overlong", "9".repeat(21)],
    ["path-reshaping", "111/../../222"],
    ["query-reshaping", `${GUILD}?admin=1`],
  ])("fires no credentialed fetch for a %s guild id", async (_label, guildId) => {
    const calls = recordingFetch(async () => Response.json([healthyEvent()]));
    let thrown: unknown;
    try {
      const source = liveDiscordEventsSource(envWithGuild(guildId));
      await source.upcoming(NOW);
    } catch (err) {
      thrown = err;
    }
    expectNamedConfigError(thrown);
    // Zero requests: no Bot authorization header is ever emitted.
    expect(calls).toEqual([]);
  });

  it("fetches the exact path-encoded scheduled-events URL for a good guild id", async () => {
    const calls = recordingFetch(async () => Response.json([healthyEvent()]));
    const source = liveDiscordEventsSource(envWithGuild(GUILD));
    const rows = await source.upcoming(NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(GUILD)}/scheduled-events`,
    );
    expect(calls[0]!.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(rows.map((row) => row.title)).toEqual(["Healthy raid"]);
    expect(source.lastReadFailed()).toBe(false);
  });

  it("fetches for a guild id at exactly the 20-digit cap", async () => {
    const calls = recordingFetch(async () => Response.json([]));
    const source = liveDiscordEventsSource(envWithGuild(AT_CAP));
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://discord.com/api/v10/guilds/${AT_CAP}/scheduled-events`,
    ]);
    expect(source.lastReadFailed()).toBe(false);
  });

  it("keeps the non-2xx failed-read fallback for a good guild id", async () => {
    const calls = recordingFetch(async () => new Response("nope", { status: 503 }));
    const source = liveDiscordEventsSource(envWithGuild(GUILD));
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(source.lastReadFailed()).toBe(true);
  });
});
