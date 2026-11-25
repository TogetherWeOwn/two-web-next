import { BotTransportError } from "../jobs/types";
import type { BotFailure } from "../jobs/types";
import { retryableFallback } from "./client-retry";

export type ParsedEnvelope =
  | { ok: true; result: Record<string, unknown>; requestId: string; replayed: boolean }
  | { ok: false; failure: BotFailure };

export function parseEnvelope(
  status: number,
  replayed: boolean,
  json: unknown,
  strictReceipt = false,
): ParsedEnvelope {
  if (typeof json !== "object" || json === null || !("ok" in json))
    throw new BotTransportError("bot answered without an `ok` field");
  const body = json as { ok: unknown; result?: unknown; error?: unknown; request_id?: unknown };
  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  if (body.ok === true) {
    if (strictReceipt && status !== 200) throw new BotTransportError("invalid bot success status");
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
  if (
    strictReceipt &&
    (body.ok !== false || typeof error.retryable !== "boolean" || typeof error.message !== "string")
  )
    throw new BotTransportError("bot refusal did not match the action envelope");
  const code = error.code;
  return {
    ok: false,
    failure: {
      ok: false,
      code,
      status,
      requestId: requestId || null,
      message: typeof error.message === "string" ? error.message : "",
      retryable: typeof error.retryable === "boolean" ? error.retryable : retryableFallback(code),
      retryAfterSeconds: null, // set by the caller on a 429
    },
  };
}
