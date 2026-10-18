// Shared inbound bound for OAuth `code`/`state` query values.
//
// Both callbacks (`GET /auth/discord/callback` and `GET /join/callback`)
// read short opaque values: Discord authorization codes (~30 chars) and the
// UUID states this app issues (~36 chars). A multi-kilobyte value is never
// legitimate, and without a bound a valid-state holder can make every hit
// POST megabytes to Discord before failing as `invalid_grant`.
//
// The cap aligns with the existing inbound error-body cap (2048 chars): far
// above legitimate lengths, far below the pinned 8192-char refusal. Callers
// check before any journey consume, exchange, or session work so an oversized
// hit keeps the one-time journey intact and yields today's generic failure
// with zero provider calls. Values are never logged, echoed, or persisted —
// only `.length` is inspected.

export const OAUTH_CODE_STATE_MAX_LENGTH = 2048;

export function isOversizedOAuthValue(value: unknown): boolean {
  return typeof value === "string" && value.length > OAUTH_CODE_STATE_MAX_LENGTH;
}

export function hasOversizedOAuthParams(code: unknown, state: unknown): boolean {
  return isOversizedOAuthValue(code) || isOversizedOAuthValue(state);
}
