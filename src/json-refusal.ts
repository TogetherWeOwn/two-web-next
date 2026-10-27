import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { safeRequestId } from "./request-log";

// The one JSON refusal envelope for write surfaces (RSVP, event writes,
// profile saves, expired-write recovery, same-origin guard):
//   { error, request_id?, ...extra }
// `error` is a fixed lowercase code from REFUSAL_CODES (documented in
// docs/machine-errors.md; ci/check-refusal-vocabulary.mjs keeps the two in
// step). `request_id` is the validated log id requestLog put on the context,
// never raw client header bytes, and is omitted only when there is no
// requestLog context (a bare mount has no correlation id to carry).
export const REFUSAL_CODES = [
  "cross_origin",
  "forbidden",
  "invalid",
  "method_not_allowed",
  "not_found",
  "unauthenticated",
  "unsupported_media_type",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function jsonRefusal(
  c: Context<any>,
  error: RefusalCode,
  status: ContentfulStatusCode,
  extra: Record<string, unknown> = {},
): Response {
  const requestId = safeRequestId(c.get("requestId"));
  return c.json({ error, ...(requestId ? { request_id: requestId } : {}), ...extra }, status);
}
