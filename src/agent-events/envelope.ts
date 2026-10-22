// One machine error vocabulary for the agent-event ingress: every denial
// carries `code` (primary), `reason` (deprecated alias, kept byte-identical
// for the J1 contract), a human `message`, a server-minted `request_id` and
// a `next` naming one safe action. Strictly additive: no reason renamed,
// no success body touched. See docs/machine-errors.md, the single source.

/** The one safe next action per ingress reason. Static strings, so agents can match on them. */
export const INGRESS_ERROR_NEXT: Record<string, string> = {
  event_not_found: "Check the event key and retry.",
  event_not_open: "Read the event and use a move it is open for.",
  foreign_event: "Use an event this grant owns.",
  forbidden_action: "Use one of create, read, update, publish or cancel.",
  grant_disabled: "Ask the provisioning owner to re-enable the grant.",
  grant_expired: "Ask the provisioning owner for a fresh grant.",
  idempotency_conflict: "Use a fresh idempotency key for the new payload.",
  ingress_disabled: "Enable the ingress or use another environment.",
  ingress_unavailable: "Retry shortly.",
  internal_error: "Retry shortly; report if it persists.",
  operation_busy: "Retry with the same idempotency key.",
  payload_too_deep: "Send a shallower payload and retry.",
  production_guild: "Use a staging-guild grant; production is never served here.",
  quota_exceeded: "Reuse the grant's proof event for updates.",
  rate_limited: "Wait for Retry-After, then retry with the same key.",
  stale_version: "Re-read the event and retry with the fresh version.",
  unauthenticated: "Present a valid machine credential and retry.",
  validation_failed: "Fix the request fields and retry.",
  wrong_audience: "Use a grant bound to the staging guild.",
  wrong_caller: "Use the admitted caller's grant.",
  wrong_guild: "Omit guild_id or match the grant guild.",
};

/** Fallback for a reason added without a mapped action: never an empty next. */
export const INGRESS_FALLBACK_NEXT = "Fix the request and retry.";

/**
 * One denial body for every ingress refusal: `code` mirrors `reason`, and
 * `extra` carries refusal-specific fields (retry_after, errors, event_key)
 * without changing the shared keys.
 */
export function ingressDenial(
  reason: string,
  message: string,
  requestId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: reason,
    reason,
    message,
    ...extra,
    request_id: requestId,
    next: INGRESS_ERROR_NEXT[reason] ?? INGRESS_FALLBACK_NEXT,
  };
}
