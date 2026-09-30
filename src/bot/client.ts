// Live HTTP client for the bot's POST /internal/actions. Ports two-web
// app/Services/Bot/InternalActionClient.php (wire format: two-bot
// docs/INTERNAL_ACTIONS.md) against the ported signer in ./signer.
//
// One attempt per call, no retries here: the queued job owns the policy
// (src/jobs/call-internal-action.ts). Three outcomes, mirroring legacy:
// a result object (it worked), a BotFailure-shaped refusal (the bot said no —
// branch on `retryable`, never on the status), or a throw (could not ask, or
// got back nothing usable).
//
// Nothing here logs the secret, the signature, or a request body: the
// announcement body in particular is never logged (legacy §4 rule).

import {
  encodeCanonicalJson,
  INTERNAL_ACTIONS_PATH,
  newNonce,
  signInternalAction,
} from "./signer";
import { BotTerminalError, BotTransportError } from "../jobs/types";
import type { Announcement, BotFailure, BotSuccess, EventUpsert, RoleAssignment } from "../jobs/types";

export type RoleAssignResult = BotSuccess<{ outcome: "assigned" | "already_held" }>;
export type AnnouncementResult = BotSuccess<{ messageId: string; replayed: boolean }>;
export type EventUpsertResult = BotSuccess<{
  outcome: "created" | "updated";
  discordEventId: string;
  replayed: boolean;
}>;

export type InternalActionResult = RoleAssignResult | AnnouncementResult | EventUpsertResult;
export type InternalActionAnswer = InternalActionResult | BotFailure;

/** A caller-supplied UUID for one logical operation (announcement/event only). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bot's error codes (two-bot docs/INTERNAL_ACTIONS.md §2). The `retryable`
 * flag on the wire is authoritative; this table is only the fallback when the
 * flag is missing — and false for a code we do not know. Never branch on HTTP
 * status: `in_progress` and `replayed` are both 409 with opposite answers.
 */
export function retryableFallback(code: string): boolean {
  switch (code) {
    case "in_progress":
    case "rate_limited":
    case "internal":
    case "discord_unavailable":
    case "upstream_timeout":
      return true;
    default:
      return false;
  }
}

const charLen = (s: string): number => [...s].length;

/** `role.assign`: discord_id is a snowflake (digits, ≤20); role_key is a key, never an ID. */
export function validateRoleAssign(a: RoleAssignment): void {
  if (!/^\d{1,20}$/.test(a.userId))
    throw new BotTerminalError("A role.assign needs a Discord snowflake for discord_id: decimal digits, at most 20 of them.");
  if (a.roleKey.trim() === "")
    throw new BotTerminalError("A role.assign needs a role_key. It is a key from the bot role map, not a Discord role id.");
}

/** `announcement.post`: needs an idempotency key on every call (a repeat without one posts twice). */
export function validateAnnouncement(a: Announcement): void {
  if (a.channelKey.trim() === "")
    throw new BotTerminalError("An announcement.post needs a channel_key. It is a key from the bot channel map, not a Discord channel id.");
  if (a.body.trim() === "")
    throw new BotTerminalError("An announcement.post needs a body.");
  if (charLen(a.body) > 2000)
    throw new BotTerminalError(`An announcement body is at most 2000 characters; this one is ${charLen(a.body)}.`);
}

/** `event.upsert`: external events only (location, exactly one of channel_key/location — this client only sends location). */
export function validateEventUpsert(e: EventUpsert): void {
  if (e.eventKey.trim() === "")
    throw new BotTerminalError("An event.upsert needs an event_key: it is how the bot finds the event to update.");
  if (e.name.trim() === "")
    throw new BotTerminalError("An event.upsert needs a name.");
  if (charLen(e.name) > 100)
    throw new BotTerminalError(`An event name is at most 100 characters; this one is ${charLen(e.name)}.`);
  if (e.description !== null && charLen(e.description) > 1000)
    throw new BotTerminalError(`An event description is at most 1000 characters; this one is ${charLen(e.description)}.`);
  if (e.location.trim() === "")
    throw new BotTerminalError("An event.upsert needs a location. The bot takes exactly one of channel_key or location, and this client only ever sends location.");
  if (!(e.endsAt !== null && e.endsAt > e.startsAt))
    throw new BotTerminalError("An event must end after it starts.");
}

export type BotClientOptions = {
  url: string | undefined;
  secret: string | undefined;
  keyId: string | undefined;
  timeoutSeconds?: number;
  fetchFn?: typeof fetch;
};

export function assertBotConfigured(o: Pick<BotClientOptions, "url" | "secret" | "keyId">): void {
  if (!o.url) throw new BotTerminalError("Bot is not configured: BOT_ENDPOINT_URL is missing.");
  if (!o.secret) throw new BotTerminalError("Bot is not configured: BOT_SHARED_SECRET is missing.");
  if (!o.keyId) throw new BotTerminalError("Bot is not configured: BOT_KEY_ID is missing.");
}

function endpointOf(url: string): string {
  return `${url.replace(/\/+$/, "")}${INTERNAL_ACTIONS_PATH}`;
}

type ParsedEnvelope =
  | { ok: true; result: Record<string, unknown>; requestId: string; replayed: boolean }
  | { ok: false; failure: BotFailure };

function parseEnvelope(status: number, replayed: boolean, json: unknown): ParsedEnvelope {
  if (typeof json !== "object" || json === null || !("ok" in json))
    throw new BotTransportError("bot answered without an `ok` field");
  const body = json as { ok: unknown; result?: unknown; error?: unknown; request_id?: unknown };
  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  if (body.ok === true) {
    if (typeof body.result !== "object" || body.result === null)
      throw new BotTransportError("bot success has no result object");
    return { ok: true, result: body.result as Record<string, unknown>, requestId, replayed };
  }
  const error =
    typeof body.error === "object" && body.error !== null
      ? (body.error as { code?: unknown; message?: unknown; retryable?: unknown })
      : null;
  if (!error || typeof error.code !== "string")
    throw new BotTransportError("bot failure has no error code");
  const code = error.code;
  return {
    ok: false,
    failure: {
      ok: false,
      code,
      status,
      requestId: requestId || null,
      message: typeof error.message === "string" ? error.message : "",
      retryable:
        typeof error.retryable === "boolean" ? error.retryable : retryableFallback(code),
      retryAfterSeconds: null, // set by the caller on a 429
    },
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * One signed attempt. Builds the JSON once and sends those exact bytes —
 * re-serializing between signing and sending breaks the signature.
 */
// Resolved after assertBotConfigured: plain strings, never undefined.
// (Required<Pick<...>> would lie here — the option fields are explicitly
// `string | undefined`, which Required does not strip.)
type ResolvedBotConfig = {
  url: string;
  secret: string;
  keyId: string;
  timeoutSeconds: number;
  fetchFn: typeof fetch;
};

async function send(
  o: ResolvedBotConfig,
  payload: Record<string, string>,
  idempotencyKey: string | null,
): Promise<ParsedEnvelope> {
  if (idempotencyKey !== null && !UUID.test(idempotencyKey))
    throw new BotTerminalError("An Idempotency-Key must be a UUID; the bot answers a malformed one with a non-retryable `malformed`.");
  const body = encodeCanonicalJson(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = newNonce();
  const headers = await signInternalAction(o.keyId, o.secret, body, timestamp, nonce);
  const out: Record<string, string> = {
    "content-type": "application/json",
    "X-TWO-Key-Id": headers["X-TWO-Key-Id"]!,
    "X-TWO-Timestamp": headers["X-TWO-Timestamp"]!,
    "X-TWO-Nonce": headers["X-TWO-Nonce"]!,
    "X-TWO-Signature": headers["X-TWO-Signature"]!,
  };
  // Absent, not blank, for a natural-idempotency action.
  if (idempotencyKey !== null) out["Idempotency-Key"] = idempotencyKey;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await o.fetchFn(endpointOf(o.url), {
      method: "POST",
      headers: out,
      body,
      signal: AbortSignal.timeout(o.timeoutSeconds * 1000),
    });
  } catch (e) {
    throw new BotTransportError(`bot unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new BotTransportError("bot answered with a body that is not JSON");
  }
  const parsed = parseEnvelope(res.status, res.headers.get("Idempotent-Replay") === "true", json);
  if (!parsed.ok && parsed.failure.code === "rate_limited" && res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    parsed.failure.retryAfterSeconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  }
  const durationMs = Date.now() - startedAt;
  const actionName = payload["action"] ?? "(unknown)";
  if (parsed.ok) {
    console.info("bot internal action succeeded", {
      request_id: parsed.requestId,
      action: actionName,
      status: res.status,
      replayed: parsed.replayed,
      duration_ms: durationMs,
    });
  } else {
    console.warn("bot internal action refused", {
      request_id: parsed.failure.requestId,
      action: actionName,
      status: res.status,
      code: parsed.failure.code,
      retryable: parsed.failure.retryable,
      duration_ms: durationMs,
    });
  }
  return parsed;
}

/** Live client. Also satisfies the queue consumer's BotClient for the result shapes it returns. */
export function createBotClient(opts: BotClientOptions) {
  const timeoutSeconds = opts.timeoutSeconds ?? 5;
  const fetchFn = opts.fetchFn ?? fetch;
  const cfg = () => {
    assertBotConfigured(opts);
    return {
      url: opts.url as string,
      secret: opts.secret as string,
      keyId: opts.keyId as string,
      timeoutSeconds,
      fetchFn,
    };
  };

  return {
    assertConfigured(): void {
      assertBotConfigured(opts);
    },

    async assignRole(a: RoleAssignment): Promise<RoleAssignResult | BotFailure> {
      validateRoleAssign(a);
      const answer = await send(cfg(), { action: "role.assign", discord_id: a.userId, role_key: a.roleKey }, null);
      if (!answer.ok) return answer.failure;
      const outcome = str(answer.result["outcome"]);
      if (outcome !== "assigned" && outcome !== "already_held")
        throw new BotTransportError("a role.assign outcome this release does not know");
      return { ok: true, requestId: answer.requestId || null, outcome };
    },

    async postAnnouncement(a: Announcement, idempotencyKey: string): Promise<AnnouncementResult | BotFailure> {
      validateAnnouncement(a);
      const answer = await send(
        cfg(),
        { action: "announcement.post", channel_key: a.channelKey, body: a.body },
        idempotencyKey,
      );
      if (!answer.ok) return answer.failure;
      const messageId = str(answer.result["message_id"]);
      if (messageId === null) throw new BotTransportError("an announcement.post success with no message_id");
      return { ok: true, requestId: answer.requestId || null, messageId, replayed: answer.replayed };
    },

    async upsertEvent(e: EventUpsert, idempotencyKey: string): Promise<EventUpsertResult | BotFailure> {
      validateEventUpsert(e);
      // validateEventUpsert throws unless endsAt is set; this narrows it for the compiler.
      const endsAt = e.endsAt;
      if (endsAt === null) throw new BotTerminalError("An event must end after it starts.");
      // `description` omitted rather than null: absent and null are not the
      // same thing to a validator that checks types, and the bot's is one.
      const payload: Record<string, string> = {
        action: "event.upsert",
        event_key: e.eventKey,
        name: e.name,
        starts_at: e.startsAt,
        ends_at: endsAt,
        location: e.location,
      };
      if (e.description !== null) payload["description"] = e.description;
      const answer = await send(cfg(), payload, idempotencyKey);
      if (!answer.ok) return answer.failure;
      const outcome = str(answer.result["outcome"]);
      if (outcome !== "created" && outcome !== "updated")
        throw new BotTransportError("an event.upsert outcome this release does not know");
      const discordEventId = str(answer.result["event_id"]);
      if (discordEventId === null) throw new BotTransportError("an event.upsert success with no event_id");
      return { ok: true, requestId: answer.requestId || null, outcome, discordEventId, replayed: answer.replayed };
    },
  };
}

export type BotActionClient = ReturnType<typeof createBotClient>;
