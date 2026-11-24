import type { Context, Hono } from "hono";
import { requestBodyLimit } from "./body-limit";
import { send } from "./bot/client-transport";
import type { Env } from "./env";
import { jsonRefusal } from "./json-refusal";
import { isJsonMediaType } from "./media-type";
import { isQaFixtureId, STAGING_APP_URL } from "./qa";
import { safeRequestId } from "./request-log";
import { crossOriginRefusal } from "./same-origin";
import { readContextSession } from "./session-hono";
import { AUTH_THROTTLE_PER_MINUTE, throttle } from "./throttle";

const STAGING_BOT_ORIGIN = "https://two-bot-next-staging.5150.workers.dev";
type Web = { Bindings: Env };
type Receipt = Awaited<ReturnType<typeof send>>;
const OUTCOMES: ReadonlySet<unknown> = new Set([
  "moved",
  "already_in_room",
  "not_connected",
  "not_permitted",
  "room_full",
  "room_gone",
  "bot_not_permitted",
]);

function isMoveId(value: string | undefined): value is string {
  return (
    typeof value === "string" && /^[1-9][0-9]{16,19}$/.test(value) && BigInt(value) < 2n ** 64n
  );
}

const unconfirmed = (c: Context<Web>): Response => c.json({ error: "bot_unavailable" }, 502);

function moveResponse(c: Context<Web>, answer: Receipt, fixtureSource: string): Response {
  const requestId = safeRequestId(answer.ok ? answer.requestId : answer.failure.requestId);
  if (requestId?.length !== 26) return unconfirmed(c);
  if (answer.ok) {
    const { outcome, from_channel_id: fromChannelId } = answer.result;
    if (
      answer.replayed ||
      !OUTCOMES.has(outcome) ||
      (outcome === "moved" && fromChannelId !== fixtureSource)
    ) {
      return unconfirmed(c);
    }
    const result = outcome === "moved" ? { outcome, from_channel_id: fixtureSource } : { outcome };
    return c.json({ ok: true, request_id: requestId, result });
  }

  const { code, status, retryable, retryAfterSeconds } = answer.failure;
  if (
    !(status === 403 && code === "action_not_allowed" && !retryable) &&
    !(status === 502 && code === "discord_unavailable" && retryable) &&
    !(status === 429 && code === "rate_limited" && retryable)
  )
    return unconfirmed(c);
  if (status === 429 && retryAfterSeconds !== null)
    c.header("retry-after", String(retryAfterSeconds));
  const error = { code, message: "request refused", retryable };
  return c.json({ ok: false, request_id: requestId, error }, status);
}

export function registerStagingVoiceMove(app: Hono<Web>): void {
  app.post(
    "/__probe/voice-move",
    async (c, next) => {
      c.header("cache-control", "no-store, private");
      if (
        c.env.STAGING_VOICE_MOVE_ENABLED !== "true" ||
        c.env.APP_URL !== STAGING_APP_URL ||
        new URL(c.req.url).origin !== STAGING_APP_URL
      )
        return jsonRefusal(c, "not_found", 404);
      if (c.req.header("origin") !== STAGING_APP_URL) return crossOriginRefusal(c);
      await next();
    },
    requestBodyLimit("action"),
    throttle("staging-voice-move", AUTH_THROTTLE_PER_MINUTE),
    async (c) => {
      const {
        STAGING_VOICE_MOVE_MEMBER_ID: memberId,
        BOT_ENDPOINT_URL: url,
        BOT_SHARED_SECRET: secret,
        BOT_KEY_ID: keyId,
      } = c.env;
      const channelIds = c.env.STAGING_VOICE_MOVE_CHANNEL_IDS;
      // Two snowflakes (up to 20 digits each) and one comma.
      const channels = channelIds && channelIds.length <= 41 ? channelIds.split(",") : [];
      const [first, second] = channels;
      if (
        !isMoveId(memberId) ||
        isQaFixtureId(memberId) ||
        channels.length !== 2 ||
        !isMoveId(first) ||
        !isMoveId(second) ||
        first === second ||
        (url !== STAGING_BOT_ORIGIN && url !== `${STAGING_BOT_ORIGIN}/`) ||
        !secret?.trim() ||
        !keyId?.trim()
      )
        return jsonRefusal(c, "not_found", 404);

      if (new URL(c.req.url).search) return jsonRefusal(c, "invalid", 400);
      if (!isJsonMediaType(c.req.header("content-type")))
        return jsonRefusal(c, "unsupported_media_type", 415);
      const body = await c.req.json<{ channel_id?: unknown }>().catch(() => null);
      if (!body || typeof body.channel_id !== "string" || Object.keys(body).length !== 1)
        return jsonRefusal(c, "invalid", 400);
      if (body.channel_id !== first && body.channel_id !== second)
        return jsonRefusal(c, "forbidden", 403);

      const session = await readContextSession(c, { currentMemberId: memberId });
      if (!session) return jsonRefusal(c, "forbidden", 403);

      try {
        const answer = await send(
          { url, secret, keyId, timeoutSeconds: 5, fetchFn: fetch, strictReceipt: true },
          { action: "voice.move_member", discord_id: session.id, channel_id: body.channel_id },
          null,
        );
        return moveResponse(c, answer, body.channel_id === first ? second : first);
      } catch {
        // The move may have reached the receiver. Return an unconfirmed result.
        return unconfirmed(c);
      }
    },
  );
}
