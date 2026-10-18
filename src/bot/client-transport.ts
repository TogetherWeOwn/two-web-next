// One signed attempt per call, no retries here: the queued job owns the policy
// (src/jobs/call-internal-action.ts). Three outcomes, mirroring legacy:
// a result object (it worked), a BotFailure-shaped refusal (the bot said no —
// branch on `retryable`, never on the status), or a throw (could not ask, or
// got back nothing usable).
//
// Nothing here logs the secret, the signature, or a request body: the
// announcement body in particular is never logged (legacy §4 rule).

import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";
import { BotTerminalError, BotTransportError } from "../jobs/types";
import type { BotClientOptions } from "./client-types";
import { parseEnvelope, type ParsedEnvelope } from "./client-serialization";

export function assertBotConfigured(o: Pick<BotClientOptions, "url" | "secret" | "keyId">): void {
  if (!o.url) throw new BotTerminalError("Bot is not configured: BOT_ENDPOINT_URL is missing.");
  if (!o.secret) throw new BotTerminalError("Bot is not configured: BOT_SHARED_SECRET is missing.");
  if (!o.keyId) throw new BotTerminalError("Bot is not configured: BOT_KEY_ID is missing.");
}

function endpointOf(url: string): string {
  return `${url.replace(/\/+$/, "")}${INTERNAL_ACTIONS_PATH}`;
}

/** A caller-supplied UUID for one logical operation (announcement/event only). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Closed vocabulary for the `code` field on transport diagnostics
 * (two-bot docs/INTERNAL_ACTIONS.md §2, per InternalActionClientTest.php:303-315).
 * The wire `code` is untrusted provider input and must never reach a log line
 * raw: an exact allowlist match logs the code, anything else logs `unknown`.
 * Length/alphabet filtering is not a confidentiality proof, so no cleaned
 * substring of the wire value is ever logged. The returned `BotFailure.code`
 * keeps the raw wire value; only the diagnostic projection is classified.
 */
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "malformed",
  "unauthorized",
  "stale_request",
  "action_not_allowed",
  "replayed",
  "in_progress",
  "discord_rejected",
  "rate_limited",
  "internal",
  "discord_unavailable",
  "upstream_timeout",
]);

export function diagnosticCode(code: string): string {
  return DIAGNOSTIC_CODES.has(code) ? code : "unknown";
}

/**
 * One signed attempt. Builds the JSON once and sends those exact bytes —
 * re-serializing between signing and sending breaks the signature.
 */
// Resolved after assertBotConfigured: plain strings, never undefined.
// (Required<Pick<...>> would lie here — the option fields are explicitly
// `string | undefined`, which Required does not strip.)
export type ResolvedBotConfig = {
  url: string;
  secret: string;
  keyId: string;
  timeoutSeconds: number;
  fetchFn: typeof fetch;
};

export async function send(
  o: ResolvedBotConfig,
  payload: Record<string, string>,
  idempotencyKey: string | null,
): Promise<ParsedEnvelope> {
  if (idempotencyKey !== null && !UUID.test(idempotencyKey))
    throw new BotTerminalError(
      "An Idempotency-Key must be a UUID; the bot answers a malformed one with a non-retryable `malformed`.",
    );
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
      // Never follow: a redirect would forward signed bodies/headers to an unvalidated origin.
      // Workers fetch rejects redirect "error" outright, so take the 3xx back and refuse it below.
      redirect: "manual",
      headers: out,
      body,
      signal: AbortSignal.timeout(o.timeoutSeconds * 1000),
    });
  } catch (e) {
    throw new BotTransportError(`bot unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 300 && res.status < 400)
    throw new BotTransportError(`bot answered with a redirect (${res.status}); not followed`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new BotTransportError("bot answered with a body that is not JSON");
  }
  const parsed = parseEnvelope(res.status, res.headers.get("Idempotent-Replay") === "true", json);
  if (!parsed.ok && parsed.failure.code === "rate_limited" && res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    parsed.failure.retryAfterSeconds =
      retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  }
  const durationMs = Date.now() - startedAt;
  const actionName = payload["action"] ?? "(unknown)";
  // Diagnostics never carry the provider's `request_id`/`error.code` raw:
  // both are untrusted envelope fields that can echo outgoing material.
  // Correlation uses the caller-supplied idempotency key (a validated UUID,
  // never provider input); the code is projected through the closed
  // vocabulary above with a fixed `unknown` fallback.
  const correlation = idempotencyKey !== null ? { idempotency_key: idempotencyKey } : {};
  if (parsed.ok) {
    console.info("bot internal action succeeded", {
      ...correlation,
      action: actionName,
      status: res.status,
      replayed: parsed.replayed,
      duration_ms: durationMs,
    });
  } else {
    console.warn("bot internal action refused", {
      ...correlation,
      action: actionName,
      status: res.status,
      code: diagnosticCode(parsed.failure.code),
      retryable: parsed.failure.retryable,
      duration_ms: durationMs,
    });
  }
  return parsed;
}
