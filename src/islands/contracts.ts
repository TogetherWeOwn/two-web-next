/**
 * W10 island contracts (TOG-9689): Livewire → islands re-spec.
 *
 * There is no Livewire protocol on Workers. Each island is SSR HTML plus a
 * progressive-enhancement binder in `public/islands/*` with an explicit
 * request budget. This module is the single source of truth for mount
 * attributes, testids, endpoints and polling budgets — the SSR slices
 * (W7 member journeys, W8 events, W9 RSVP) and the binders MUST build from
 * here. The drift tests (`test/islands-*.test.ts`) pin it.
 *
 * Legacy sources (two-web, maintenance-only): `app/Livewire/*.php`,
 * `resources/views/livewire/*.blade.php`, `tests/Feature/Livewire/*`.
 */

/** SSR marks hydratable regions with this attribute, e.g. data-island="going-count". */
export const MOUNT_ATTR = "data-island";

export const ISLANDS = [
  "events-calendar",
  "past-events",
  "going-count",
  "rsvp-button",
  "member-profile",
] as const;

export type IslandName = (typeof ISLANDS)[number];

/**
 * Explicit polling contract per island. `pollMs: null` means NO polling, with
 * the reason recorded — "explicit polling contracts" includes pinning where
 * polling was deliberately not built.
 */
export const POLLING: Record<IslandName, { pollMs: number | null; reason: string }> = {
  "events-calendar": {
    pollMs: null,
    reason:
      "User-driven fetches only (month step, settled search, past drawer, retry); " +
      "at most one request in flight, abort the previous. Events change slowly; Discord is the live channel.",
  },
  "past-events": {
    pollMs: null,
    reason: "Append-only archive; page-turn fetches only, no read loop.",
  },
  "going-count": {
    pollMs: null,
    reason:
      "Event-driven refresh on the going-count-updated CustomEvent; one GET /events.json " +
      "per answered event, non-matching keys fire no request.",
  },
  "rsvp-button": {
    pollMs: null,
    reason: "Writes only against the singular RSVP resource; optimistic states, no read loop.",
  },
  "member-profile": {
    pollMs: null,
    reason: "Edit/save/cancel PATCH flow; no read loop.",
  },
};

/* ------------------------------------------------------------------ endpoints
 * Frozen URLs from the TOG-9671 URL freeze. Query-surface additions (q, month,
 * page) are proposed in the W10 spec doc; W8 finalizes them there.
 */

/** Collection JSON. Carries `going_count` per row (EventResource contract). */
export const EVENTS_JSON_URL = "/events.json";

export const pastEventsUrl = (page: number): string =>
  page > 1 ? `/events/past?page=${page}` : "/events/past";

/** Singular RSVP resource: one answer per member per event (PUT + DELETE). */
export const rsvpUrl = (eventKey: string): string =>
  `/events/${encodeURIComponent(eventKey)}/rsvp`;

export const eventPageUrl = (eventKey: string): string =>
  `/e/${encodeURIComponent(eventKey)}`;

/* --------------------------------------------------------------- going-count
 * Legacy: app/Livewire/GoingCount.php + going-count.blade.php (TOG-7966).
 * The badge lives outside the RSVP control, so a write must refresh it.
 * Re-spec: the button island broadcasts a DOM CustomEvent; this island
 * re-reads the aggregate from the frozen collection — never trusts the
 * writer's copy.
 */

export const GOING_COUNT_ISLAND = "going-count";
export const GOING_COUNT_TESTID = "event-going-count";
export const SPOTS_LEFT_TESTID = "event-spots-left";
/** DOM CustomEvent replacing the Livewire `going-count-updated` broadcast. */
export const GOING_UPDATED_EVENT = "going-count-updated";

export type GoingViewerState = "going" | "waitlisted" | "none" | "other";

export interface GoingCountState {
  going: number;
  capacity: number | null;
  showSpotsLeft: boolean;
  announcement: GoingViewerState | null;
}

export function goingAnnouncementText(a: GoingViewerState | null): string {
  switch (a) {
    case "going":
      return "You're going.";
    case "waitlisted":
      return "You're on the waitlist.";
    case "none":
      return "RSVP removed.";
    default:
      return "";
  }
}

/** "N of M going" with a cap, "N going" without — never invents a number. */
export function goingCountText(going: number, capacity: number | null): string {
  return capacity !== null ? `${going} of ${capacity} going` : `${going} going`;
}

export function spotsLeftText(going: number, capacity: number): string {
  const left = Math.max(0, capacity - going);
  return left <= 0 ? "Full" : `${left} of ${capacity} spots left`;
}

/**
 * Server-rendered badge HTML (the W8 slice renders this; the binder only
 * patches the [data-count]/[data-announcement] nodes in place).
 * `role="status"`: updates announce politely, never as an alert. The
 * announcement node is always rendered (empty before any write) so the
 * binder has a stable target; an empty node announces nothing, so page
 * load stays quiet — same observable behavior the legacy test pins.
 */
export function renderGoingCount(eventKey: string, s: GoingCountState): string {
  const announcement = goingAnnouncementText(s.announcement);
  const safeKey = eventKey.replace(/"/g, "&quot;");
  const spots =
    s.showSpotsLeft && s.capacity !== null
      ? `<span data-testid="${SPOTS_LEFT_TESTID}">${spotsLeftText(s.going, s.capacity)}</span>`
      : "";
  return (
    `<span role="status" data-testid="${GOING_COUNT_TESTID}" ` +
    `${MOUNT_ATTR}="${GOING_COUNT_ISLAND}" data-event-key="${safeKey}" data-capacity="${s.capacity ?? ""}">` +
    `<span class="sr-only" data-announcement>${announcement}${announcement ? " " : ""}</span>` +
    `<span data-count>${goingCountText(s.going, s.capacity)}</span></span>${spots}`
  );
}

/* -------------------------------------------------------- going-count fetch */

export interface GoingRefreshRequest {
  method: "GET";
  url: string;
  eventKey: string;
}

/** One request per answered event, against the frozen collection URL. */
export function goingRefreshRequest(eventKey: string): GoingRefreshRequest {
  return { method: "GET", url: EVENTS_JSON_URL, eventKey };
}

export interface EventJsonRow {
  event_key: string;
  going_count: number;
}

/** Pick this island's aggregate out of the collection; null when absent. */
export function applyGoingRefresh(rows: EventJsonRow[], eventKey: string): number | null {
  const row = rows.find((r) => r.event_key === eventKey);
  return row ? row.going_count : null;
}

/** Listener-side skip: another card's answer fires no request here. */
export function shouldRefreshGoing(detailKey: string, islandKey: string): boolean {
  return detailKey === islandKey;
}

/* --------------------------------------------------------------- rsvp-button
 * Legacy: app/Livewire/RsvpButton.php + rsvp-button.blade.php +
 * tests/Feature/Livewire/RsvpButtonTest.php, pinned at two-web main.
 * Row origins: TOG-8135 session-expiry, TOG-7976 throttle copy (CM-frozen),
 * TOG-6956 focus moves, TOG-6990 syncing-vs-failed, TOG-8715 honeypot
 * swallow, TOG-9354 419 interceptor, TOG-8725 moderator pause. Abuse
 * surface: two-web PR #431 (TOG-7297 all-clear) with the clock-ended hole
 * tracked as TOG-7419.
 *
 * Slice state: no binder and no SSR exist yet (TOG-9839, gated on W9 routes
 * TOG-9688). This section is the build-from contract; the drift tests
 * (test/islands-rsvp-button.test.ts) pin it and skip the binder/SSR/server
 * rows with the blocker named.
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
export const RSVP_SYNCING_TESTID = "rsvp-syncing";
export const RSVP_SYNC_FAILED_TESTID = "rsvp-sync-failed";
export const RSVP_SYNCED_TESTID = "rsvp-synced";
export const RSVP_RATE_LIMITED_TESTID = "rsvp-rate-limited";
export const RSVP_FAILED_TESTID = "rsvp-failed";
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
  syncing: "Saved. Syncing to Discord.",
  syncFailed: "Saved. Discord sync didn't go through — your spot is still held.",
  synced: "Synced to Discord.",
  failedTitle: "That RSVP didn't save.",
  failedAction: "Try once more.",
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
  return returnTo ? `/auth/discord?next=${encodeURIComponent(returnTo)}` : "/auth/discord";
}

/** Shared write budget, both verbs, per member (legacy RsvpRateLimit). */
export const RSVP_RATE_LIMIT = { maxAttempts: 12, decaySeconds: 60 } as const;

/**
 * Abuse decoy (TOG-8715): field no real form renders visibly, one-second
 * floor. A filled decoy on PUT answers the byte-identical first-write
 * success shape (201, null mirror stamp) without touching limiter/auth/DB,
 * and on DELETE the same empty 204 — nothing attacker-shaped logged. The
 * click island itself carries no trap: a bare click with no inputs and a
 * human-speed tap must never trip it.
 */
export const RSVP_HONEY_FIELD = "website";
export const RSVP_MIN_FILL_MS = 1000;
