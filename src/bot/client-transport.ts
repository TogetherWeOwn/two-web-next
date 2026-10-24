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
import { diagnosticCode } from "./diagnostic-code";
import { parseRetryAfterSeconds } from "../jobs/retry-delay";

export function assertBotConfigured(o: Pick<BotClientOptions, "url" | "secret" | "keyId">): void {
  if (!o.url) throw new BotTerminalError("Bot is not configured: BOT_ENDPOINT_URL is missing.");
  if (!o.secret) throw new BotTerminalError("Bot is not configured: BOT_SHARED_SECRET is missing.");
  if (!o.keyId) throw new BotTerminalError("Bot is not configured: BOT_KEY_ID is missing.");
}

/**
 * The exact URL a signed mutation is POSTed to, admitted only when it is bare
 * https:, as the read client requires (./event-read.ts). http: would put the
 * signed body on the wire in cleartext, and URL credentials would ride into
 * fetch errors. Validate both the configured URL (so appending cannot create
 * a host) and the exact fetched string (so even an empty query/fragment cannot
 * swallow the actions path). Path derivation is unchanged. A refusal is the
 * rejecting-fetch message with no cause: a URL parser error carries its input.
 */
function endpointOf(url: string): string {
  const endpoint = `${url.replace(/\/+$/, "")}${INTERNAL_ACTIONS_PATH}`;
  for (const candidate of [url, endpoint]) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch (error) {
      void error;
      throw new BotTransportError("bot unreachable");
    }
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new BotTransportError("bot unreachable");
  }
  return endpoint;
}

/** Maximum buffered mutation response body before parsing (256 KiB
 * provider-buffer convention, src/discord-http.ts:9). Bytes are counted as
 * they stream in — a small, missing, or at-cap Content-Length never excuses
 * a larger actual body. Exactly the ceiling is accepted; one byte over is
 * refused before any JSON parsing. */
const MUTATION_MAX_RESPONSE_BYTES = 262_144;

/** Attempt cleanup of a refused body (over the limit, or a 3xx) without
 * awaiting it: a stalled, rejecting, or throwing cancel must neither delay
 * nor poison the throw. Rejections are swallowed so a late cleanup failure
 * can never surface as an unhandled rejection. */
function cancelBodyWithoutWaiting(target: { cancel?: () => unknown } | null | undefined): void {
  try {
    const pending = target?.cancel?.() as Promise<void> | void;
    void (pending as Promise<void>)?.catch?.(() => {});
  } catch (error) {
    void error;
  }
}

/**
 * Buffer a signed mutation response body up to the byte ceiling, then parse
 * it as JSON. Over-limit or malformed bodies throw one fixed, redacted
 * BotTransportError — provider text never reaches the message. Concatenated
 * bytes are decoded once so a chunk split inside a multibyte character still
 * parses.
 */
async function readCappedJson(res: Response): Promise<unknown> {
  if (!res.body) {
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      void error;
      throw new BotTransportError("bot answered with a body that is not JSON");
    }
    if (new TextEncoder().encode(text).byteLength > MUTATION_MAX_RESPONSE_BYTES)
      throw new BotTransportError("bot answered with a body that is too large");
    try {
      return JSON.parse(text);
    } catch (error) {
      void error;
      throw new BotTransportError("bot answered with a body that is not JSON");
    }
  }
  const reader = res.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      let done: boolean;
      // DOM lib types read() chunks as `Uint8Array | undefined` (undefined on
      // done); workers types omit the undefined. A non-done read always
      // carries a chunk, so the non-null assertions below hold on both.
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (error) {
        void error;
        throw new BotTransportError("bot answered with a body that is not JSON");
      }
      if (done) break;
      size += value!.byteLength;
      // Cap buffered bytes before parsing: overflow fails closed without
      // waiting for close.
      if (size > MUTATION_MAX_RESPONSE_BYTES) {
        cancelBodyWithoutWaiting(reader);
        throw new BotTransportError("bot answered with a body that is too large");
      }
      chunks.push(value!);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      void error;
      throw new BotTransportError("bot answered with a body that is not JSON");
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      void error;
    }
  }
}

/** A caller-supplied UUID for one logical operation (announcement/event only). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  stderrDiagnostics: boolean;
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
  // Before signing: a refused endpoint never gets a signed body built for it.
  const endpoint = endpointOf(o.url);
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
    res = await o.fetchFn(endpoint, {
      method: "POST",
      // Never follow: a redirect would forward signed bodies/headers to an unvalidated origin.
      // Workers fetch rejects redirect "error" outright, so take the 3xx back and refuse it below.
      redirect: "manual",
      headers: out,
      body,
      signal: AbortSignal.timeout(o.timeoutSeconds * 1000),
    });
  } catch (e) {
    // The rejection text is untrusted, input-derived material — runtimes echo
    // the endpoint URL, resolved addresses, redirect targets, and anything a
    // hostile endpoint gets echoed into the error — so it never reaches the
    // message. Fixed string; the original rides structurally as `cause`.
    throw new BotTransportError("bot unreachable", { cause: e });
  }
  if (res.status >= 300 && res.status < 400) {
    // Refused, never read: release the body as the over-limit path does.
    cancelBodyWithoutWaiting(res.body);
    throw new BotTransportError(`bot answered with a redirect (${res.status}); not followed`);
  }
  const json: unknown = await readCappedJson(res);
  const parsed = parseEnvelope(res.status, res.headers.get("Idempotent-Replay") === "true", json);
  if (!parsed.ok && parsed.failure.code === "rate_limited" && res.status === 429) {
    // The shared parser's `undefined` (unusable header) adapts to this seam's
    // `null` fallback so the caller keeps its existing fallback behavior.
    parsed.failure.retryAfterSeconds =
      parseRetryAfterSeconds(res.headers.get("Retry-After")) ?? null;
  }
  const durationMs = Date.now() - startedAt;
  const actionName = payload["action"] ?? "(unknown)";
  // Diagnostics never carry the provider's `request_id`/`error.code` raw:
  // both are untrusted envelope fields that can echo outgoing material.
  // Correlation uses the caller-supplied idempotency key (a validated UUID,
  // never provider input); the code uses the shared closed vocabulary
  // with a fixed `unknown` fallback, as do queue failure diagnostics.
  const correlation = idempotencyKey !== null ? { idempotency_key: idempotencyKey } : {};
  if (parsed.ok) {
    // Success is a diagnostic, not data: machine callers keep stdout for the
    // document and read this on stderr instead. Refusals already warn there.
    const log = o.stderrDiagnostics ? console.warn : console.info;
    log("bot internal action succeeded", {
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
