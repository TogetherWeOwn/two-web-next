// Shared versioned schema for auth browser evidence receipts.
//
// Both producers (ci/auth-browser.mjs, ci/session-recovery-browser.mjs) and
// verifiers (ci/require-auth-browser-evidence.mjs,
// ci/require-session-recovery-evidence.mjs) consume these definitions, so a
// receipt is valid only when its checks are exactly the stable IDs the suite
// records after each assertion succeeds. Numeric placeholders, duplicates,
// missing entries and substituted strings all fail closed at the verifier.
//
// Adding a suite assertion means appending its ID here AND recording that ID
// in the producer after the new assertion passes; the verifier rejects any
// receipt whose check set differs. Producers reference IDs individually
// (never a whole-array copy), so a schema addition forces a matching
// producer assertion instead of silently passing.
export const AUTH_EVIDENCE_SCHEMA_VERSION = 1;

export const AUTH_BROWSER_CHECK_IDS = Object.freeze([
  "Real browser sign-in CTA completes mocked OAuth and renders an authenticated landing",
  "auth: fresh signed-in re-entry revokes the supplied prior browser session",
  "auth: ORIGINAL signed-cookie replay makes no exchange/join and cannot authenticate",
  "join: fresh signed-in re-entry revokes the supplied prior browser session",
  "join: ORIGINAL signed-cookie replay makes no exchange/join and cannot authenticate",
  "Join consent denial renders recovery without an upstream exchange",
]);

export const SESSION_RECOVERY_CHECK_IDS = Object.freeze([
  "non-authoritative errors",
  "rotation-cookie race",
  "refused/network logout draft retention and accessible retry at 360/1280",
  "hung logout deadline, duplicate activation, early confirmation, late success and late refusal under fake clocks",
  "no duplicate logout or failure notification to other tabs",
  "successful editor logout retry and broadcast logout",
  "expired draft and explicit reset",
  "keyboard recovery and one-shot banner",
  "focus/visibility revocation",
  "storage fallback",
]);
