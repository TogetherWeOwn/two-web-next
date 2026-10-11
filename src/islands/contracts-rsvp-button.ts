/**
 * rsvp-button island contract: testids, write requests, status codes, copy
 * and abuse-trap helpers. Part of the island contract family; re-exported
 * from `./contracts` so existing import paths keep working.
 */

import { GOING_UPDATED_EVENT, type GoingViewerState } from "./contracts-going-count";

/** Singular RSVP resource: one answer per member per event (PUT + DELETE). */
export const rsvpUrl = (eventKey: string): string => `/events/${encodeURIComponent(eventKey)}/rsvp`;

/* --------------------------------------------------------------- rsvp-button
 * Legacy: app/Livewire/RsvpButton.php + rsvp-button.blade.php +
 * tests/Feature/Livewire/RsvpButtonTest.php, pinned at two-web main.
 * Row origins: TOG-8135 session-expiry, TOG-7976 throttle copy (CM-frozen),
 * TOG-6956 focus moves, TOG-6990 syncing-vs-failed, TOG-8715 honeypot
 * swallow, TOG-9354 419 interceptor, TOG-8725 moderator pause. Abuse
 * surface: two-web PR #431 (TOG-7297 all-clear) with the clock-ended hole
 * tracked as TOG-7419.
 *
 * Slice 2 adds the SSR form and shipped binder. Drift tests execute both.
 * Writes serialize until the response body settles; an abort cannot undo a
 * transaction, so repeated activations during saving fire no replacement.
 *
 * NOTE on re-spec §2: it lists PUT statuses as "going / waitlisted / none".
 * Legacy accepts the full RsvpStatus enum and "none" is the withdraw
 * viewerState, never a PUT body. Contract wins: the island PUT accepts the
 * full enum; TOG-9839 resolves the doc line against W9.
 */

export const RSVP_BUTTON_ISLAND = "rsvp-button";

/** Frozen testids (legacy blade `data-testid`, W8/W15 selector port targets). */
export const RSVP_GOING_TESTID = "rsvp-going";
export const RSVP_WITHDRAW_TESTID = "rsvp-withdraw";
export const RSVP_CONFIRMED_TESTID = "rsvp-confirmed";
export const RSVP_CHECK_TESTID = "rsvp-check";
export const RSVP_CLOSED_TESTID = "rsvp-closed";
export const RSVP_PAUSED_TESTID = "rsvp-paused";
export const EVENT_FULL_TESTID = "event-full";
export const WAITLIST_JOIN_TESTID = "waitlist-join";
export const WAITLIST_POSITION_TESTID = "waitlist-position";
export const WAITLIST_CLAIM_TESTID = "waitlist-claim";
export const WAITLIST_LEAVE_TESTID = "waitlist-leave";
export const WAITLIST_SEAT_TAKEN_TESTID = "waitlist-seat-taken";
export const RSVP_SYNCING_TESTID = "rsvp-syncing";
export const RSVP_SYNC_FAILED_TESTID = "rsvp-sync-failed";
export const RSVP_SYNCED_TESTID = "rsvp-synced";
export const RSVP_RATE_LIMITED_TESTID = "rsvp-rate-limited";
export const RSVP_FAILED_TESTID = "rsvp-failed";
export const RSVP_UNKNOWN_TESTID = "rsvp-unknown";
export const RSVP_REFRESH_TESTID = "rsvp-refresh";
export const RSVP_SESSION_EXPIRED_TESTID = "rsvp-session-expired";

/** Full legacy RsvpStatus enum: the PUT body accepts every value. */
export const RSVP_STATUSES = ["going", "maybe", "not_going", "waitlisted"] as const;

export type RsvpWriteStatus = (typeof RSVP_STATUSES)[number];

/** One request per click against the singular resource (re-spec §2). */
export interface RsvpWriteRequest {
  method: "PUT";
  url: string;
  eventKey: string;
  body: { status: RsvpWriteStatus };
}

export function rsvpWriteRequest(eventKey: string, status: RsvpWriteStatus): RsvpWriteRequest {
  return { method: "PUT", url: rsvpUrl(eventKey), eventKey, body: { status } };
}

export interface RsvpWithdrawRequest {
  method: "DELETE";
  url: string;
  eventKey: string;
}

export function rsvpWithdrawRequest(eventKey: string): RsvpWithdrawRequest {
  return { method: "DELETE", url: rsvpUrl(eventKey), eventKey };
}

/**
 * Status-code shape (legacy controller + PR #431 abuse pins): first answer
 * creates the row (201), re-answer updates it (200), withdraw is a quiet
 * 204 — including withdraw-without-a-row and withdraw-from-cancelled.
 * Status-Past PUT refuses 403 with nothing written; off-verb hits 405.
 */
export const RSVP_FIRST_WRITE_STATUS = 201;
export const RSVP_REANSWER_STATUS = 200;
export const RSVP_WITHDRAW_STATUS = 204;
export const RSVP_CLOSED_WRITE_STATUS = 403;
export const RSVP_WRONG_METHOD_STATUS = 405;

export const RSVP_ABUSE_PINS = {
  doubleSubmit: [RSVP_FIRST_WRITE_STATUS, RSVP_REANSWER_STATUS],
  crossUserDeleteVictimRowKept: RSVP_WITHDRAW_STATUS,
  methodTampering: RSVP_WRONG_METHOD_STATUS,
  withdrawWithoutRow: RSVP_WITHDRAW_STATUS,
  statusPastPut: RSVP_CLOSED_WRITE_STATUS,
  withdrawFromCancelled: RSVP_WITHDRAW_STATUS,
} as const;

/**
 * Broadcast mapping for the going-count badge (legacy `going-count-updated`
 * dispatch): Going → going, Waitlisted → waitlisted, withdraw → none,
 * every other answer (maybe / not_going) → other. Fired on every
 * successful write, up and down.
 */
export function rsvpViewerState(status: RsvpWriteStatus | "withdraw"): GoingViewerState {
  if (status === "going") return "going";
  if (status === "waitlisted") return "waitlisted";
  if (status === "withdraw") return "none";
  return "other";
}

export interface RsvpBroadcast {
  event: typeof GOING_UPDATED_EVENT;
  eventKey: string;
  viewerState: GoingViewerState;
}

export function rsvpBroadcast(eventKey: string, viewerState: GoingViewerState): RsvpBroadcast {
  return { event: GOING_UPDATED_EVENT, eventKey, viewerState };
}

/** Member-visible copy, pinned verbatim (CM-frozen rows noted). */
export const RSVP_COPY = {
  cta: "I'm in",
  saving: "Saving…",
  confirmed: "You're in",
  withdraw: "Can't make it",
  removing: "Removing…",
  full: "This one's full.",
  waitlistJoin: "Join the waitlist",
  waitlistFallback: "You're on the waitlist",
  waitlistClaim: "A seat opened up — I'm in",
  waitlistLeave: "Leave the waitlist",
  waitlistSeatTaken: "Someone just took that seat.",
  syncing: "Saved. Syncing to Discord.",
  syncFailed: "Saved. Discord sync didn't go through — your spot is still held.",
  synced: "Synced to Discord.",
  failedTitle: "That RSVP didn't save.",
  failedAction: "Try once more.",
  unknown: "We couldn't confirm your RSVP. Check the event before trying again.",
  refresh: "Refresh the event",
  paused: "RSVPs are paused for this event — check back soon.",
  sessionExpired: "Your session expired.",
  guestCta: "Log in with Discord",
} as const;

/** Closed-event copy by reason (legacy closed branch, role=status). */
export type RsvpClosedReason = "cancelled" | "draft" | "past";

export function rsvpClosedCopy(reason: RsvpClosedReason): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled";
    case "draft":
      return "Not published yet";
    case "past":
      return "This one has been and gone";
  }
}

/** "Cap is N." names the cap beside the full message. */
export function rsvpFullCapCopy(capacity: number): string {
  return `Cap is ${capacity}.`;
}

/** One-based place in line, in words and digits, never colour alone. */
export function waitlistPositionCopy(position: number | null): string {
  return position === null
    ? RSVP_COPY.waitlistFallback
    : `You're on the waitlist — #${position} in line`;
}

/**
 * Announced throttle wait (TOG-7976, CM-frozen — do not reword without CM
 * sign-off). {N} is the ceiling of Retry-After, min 1; an unusable header
 * selects the "in a moment" fallback instead of a number.
 */
export function throttleWaitCopy(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) {
    return "Slow down — try again in a moment. Nothing changed, just wait a bit.";
  }
  const s = retryAfterSeconds === 1 ? "1 second" : `${retryAfterSeconds} seconds`;
  return `Slow down — try again in ${s}. Nothing changed, just wait a moment.`;
}

/**
 * Focus targets after the re-render swap (TOG-6956). A successful write
 * replaces the focused control, so the binder moves focus to the new state;
 * on failure the button stays put and focus stays (null). Withdraw falls
 * back down the list to whichever join control rendered.
 */
export function rsvpFocusTargets(
  outcome: "confirmed" | "waitlisted" | "withdrawn" | "failed",
): string[] | null {
  switch (outcome) {
    case "confirmed":
      return [RSVP_CONFIRMED_TESTID];
    case "waitlisted":
      return [WAITLIST_POSITION_TESTID];
    case "withdrawn":
      return [RSVP_GOING_TESTID, WAITLIST_JOIN_TESTID];
    case "failed":
      return null;
  }
}

/**
 * Guest/session-expired return path (TOG-9254/TOG-8135): the login link
 * carries the page path captured at SSR — never the update endpoint — so
 * Discord sends the member back to the page. Null for a bare link.
 */
export function loginUrl(returnTo: string | null): string {
  return returnTo ? `/join/discord?next=${encodeURIComponent(returnTo)}` : "/join/discord";
}

/** Shared write budget, both verbs, per member (legacy RsvpRateLimit). */
export const RSVP_RATE_LIMIT = { maxAttempts: 12, decaySeconds: 60 } as const;

/**
 * Abuse decoy: field no real form renders visibly; no minimum-fill
 * floor — the click island sends no form-open timestamp, so
 * there is nothing to time. A filled decoy on PUT answers the
 * byte-identical first-write success shape (201, null mirror stamp) without
 * touching limiter/auth/DB, and on DELETE the same empty 204 — nothing
 * attacker-shaped logged. The click island itself carries no trap: a bare
 * click with no inputs and a human-speed tap must never trip it. The 1000 ms
 * timing floor belongs to the profile form only (PROFILE_MIN_FILL_MS).
 */
export const RSVP_HONEY_FIELD = "website";

/**
 * Trap verdict: true when the honeypot value is filled. A present non-string
 * value counts as filled (fail-closed); absent/empty inputs are genuine
 * clicks and never trip. Arrays — duplicate query/form keys, parsed with all
 * values preserved — trip when ANY element is filled, so a filled duplicate
 * can never hide behind an empty sibling. Honeypot half of
 * profileTrapTripped, without the profile form's opened-at floor (the RSVP
 * click island carries no trap).
 */
export function rsvpHoneyFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(rsvpHoneyFilled);
  return typeof value === "string" ? value !== "" : value !== undefined && value !== null;
}

/** True when a PUT body carries a filled honeypot and the write must be swallowed. */
export function rsvpTrapTripped(input: Record<string, unknown>): boolean {
  return rsvpHoneyFilled(input[RSVP_HONEY_FIELD]);
}
