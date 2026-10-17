// Live staging acceptance for the bot HTTP adapter (the signed internal-action
// client in src/bot/client, driven the same way bin/internal-action-smoke.mjs
// drives it): the staging bot must answer one canned announcement.post by
// posting to live Discord and returning that message's Discord snowflake id.
//
// Staging-only: the whole suite is skipped unless
// BOT_HTTP_ADAPTER_LIVE_STAGING_TESTS=true, so the ordinary offline `check`
// never touches the network or a real bot. With the gate on, a missing target
// is a FAILURE, not a skip: that is the point of the proof. Required env
// (names only; values are never printed):
//   BOT_ENDPOINT_URL        staging bot base URL (secret)
//   BOT_PRODUCTION_URL      production bot URL, whose host is refused
//   BOT_SHARED_SECRET       HMAC secret the staging bot holds for our key id
//   BOT_KEY_ID              which shared secret signs the call
//   BOT_STAGING_CHANNEL_KEY key from the bot channel map naming a throwaway
//                           staging channel (a real message is posted there)
// Optional:
//   BOT_HTTP_ADAPTER_PROOF_LOG  path the one-line JSON proof is appended to
//
// The proof line carries the Discord message id and timestamps only — no
// secret, no signature, no announcement body, no Discord bot token. The
// message timestamp is decoded from the snowflake itself
// (Discord epoch 1420070400000, id >> 22), so it is Discord's own record of
// when the message was created, not this process's clock.

import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import type { AnnouncementResult } from "../src/bot/client";
import { BotTerminalError } from "../src/jobs/types";
import type { BotFailure } from "../src/jobs/types";
import { stagingEndpoint } from "../src/probes/bot-smoke";

const live = process.env.BOT_HTTP_ADAPTER_LIVE_STAGING_TESTS === "true";

const REQUIRED_ENV = [
  "BOT_ENDPOINT_URL",
  "BOT_PRODUCTION_URL",
  "BOT_SHARED_SECRET",
  "BOT_KEY_ID",
  "BOT_STAGING_CHANNEL_KEY",
] as const;

// Values that must never appear in any captured output or proof line. Names
// are read from the environment; only lengths gate the check, so an absent
// optional token simply drops out.
const secretValues = (): string[] =>
  ["BOT_SHARED_SECRET", "DISCORD_STAGING_BOT_TOKEN", "DISCORD_BOT_TOKEN"]
    .map((name) => process.env[name])
    .filter((v): v is string => typeof v === "string" && v.length >= 8);

// Discord bot-token shape: three dot-separated base64url segments.
const DISCORD_TOKEN_SHAPE = /[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/;

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

function snowflakeTimestampMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

type LiveRun = {
  first: AnnouncementResult;
  replay: AnnouncementResult;
  firstAt: Date;
  replayAt: Date;
  proofLine: string;
  capturedOutput: string;
  bodyNonce: string;
};

let run: LiveRun;

/** Sanitized refusal detail: status/code/flags only, never the bot's message. */
function refusalDetail(label: string, a: BotFailure): string {
  return `${label} refused: status=${a.status} code=${a.code} retryable=${a.retryable} request_id=${a.requestId ?? "(none)"}`;
}

describe.skipIf(!live)("bot HTTP adapter against live Discord (staging only)", () => {
  beforeAll(async () => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(
        `staging bot cannot answer: live proof target is not configured (missing env: ${missing.join(", ")}; names only, no values read)`,
      );
    }

    // Refuses the production bot host (whole hostname, any port) before
    // anything is signed or sent.
    const url = stagingEndpoint(process.env.BOT_ENDPOINT_URL, process.env.BOT_PRODUCTION_URL);
    const client = createBotClient({
      url,
      secret: process.env.BOT_SHARED_SECRET,
      keyId: process.env.BOT_KEY_ID,
    });
    client.assertConfigured();

    const channelKey = process.env.BOT_STAGING_CHANNEL_KEY as string;
    const bodyNonce = crypto.randomUUID();
    const announcement = {
      channelKey,
      body: `staging bot http adapter proof ${bodyNonce} ${new Date().toISOString()} — ignore`,
    };
    const key = crypto.randomUUID();

    // Capture everything the adapter logs while it talks to the bot, so the
    // no-secret/no-body assertions below cover real output, not intentions.
    const captured: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        captured.push(
          `${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`,
        );
      };
    const spies = [
      vi.spyOn(console, "info").mockImplementation(record("info")),
      vi.spyOn(console, "warn").mockImplementation(record("warn")),
      vi.spyOn(console, "error").mockImplementation(record("error")),
      vi.spyOn(console, "log").mockImplementation(record("log")),
    ];

    let first: AnnouncementResult | BotFailure;
    let replay: AnnouncementResult | BotFailure;
    const firstAt = new Date();
    try {
      first = await client.postAnnouncement(announcement, key);
      replay = await client.postAnnouncement(announcement, key);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const replayAt = new Date();

    if (!first.ok) throw new Error(refusalDetail("announcement.post", first));
    if (!replay.ok) throw new Error(refusalDetail("announcement.post replay", replay));

    const proof = {
      kind: "bot-http-adapter-staging-proof",
      channel_key: channelKey,
      message_id: first.messageId,
      discord_timestamp: new Date(snowflakeTimestampMs(first.messageId)).toISOString(),
      first_at: firstAt.toISOString(),
      first_request_id: first.requestId,
      replay_at: replayAt.toISOString(),
      replay_request_id: replay.requestId,
      replay_message_id: replay.messageId,
      replayed: replay.replayed,
    };
    const proofLine = JSON.stringify(proof);
    console.log(`BOT_HTTP_ADAPTER_PROOF ${proofLine}`);
    const proofPath = process.env.BOT_HTTP_ADAPTER_PROOF_LOG;
    if (proofPath) appendFileSync(proofPath, `${proofLine}\n`);

    run = {
      first,
      replay,
      firstAt,
      replayAt,
      proofLine,
      capturedOutput: captured.join("\n"),
      bodyNonce,
    };
  }, 60_000);

  it("answers the canned announcement.post with a fresh Discord message id", () => {
    expect(run.first.ok).toBe(true);
    // A Discord snowflake: decimal digits, at most 20 of them.
    expect(run.first.messageId).toMatch(/^\d{17,20}$/);
    expect(run.first.replayed).toBe(false);
    // The snowflake's own timestamp must fall inside this run (a two-minute
    // allowance covers ordinary clock skew between here and Discord).
    const createdMs = snowflakeTimestampMs(run.first.messageId);
    expect(createdMs).toBeGreaterThanOrEqual(run.firstAt.getTime() - 120_000);
    expect(createdMs).toBeLessThanOrEqual(run.replayAt.getTime() + 120_000);
  });

  it("answers the same idempotency key with the same message, flagged replayed", () => {
    expect(run.replay.ok).toBe(true);
    expect(run.replay.replayed).toBe(true);
    expect(run.replay.messageId).toBe(run.first.messageId);
  });

  it("emits a proof line with message id and timestamps, and no secret anywhere", () => {
    const proof = JSON.parse(run.proofLine) as Record<string, unknown>;
    expect(proof.message_id).toBe(run.first.messageId);
    expect(proof.discord_timestamp).toBe(
      new Date(snowflakeTimestampMs(run.first.messageId)).toISOString(),
    );
    expect(proof.first_at).toBe(run.firstAt.toISOString());
    expect(proof.replay_at).toBe(run.replayAt.toISOString());

    const everything = `${run.proofLine}\n${run.capturedOutput}`;
    for (const secret of secretValues()) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(DISCORD_TOKEN_SHAPE);
    // The announcement body (here: its per-run nonce) is never logged.
    expect(run.capturedOutput).not.toContain(run.bodyNonce);
  });

  it("refuses the production bot host and a missing production exclusion", () => {
    expect(() =>
      stagingEndpoint("https://bot.internal.example:8443", "https://bot.internal.example"),
    ).toThrow(BotTerminalError);
    expect(() => stagingEndpoint("https://bot-staging.internal.example", undefined)).toThrow(
      BotTerminalError,
    );
    expect(() => stagingEndpoint(undefined, "https://bot.internal.example")).toThrow(
      BotTerminalError,
    );
  });
});
