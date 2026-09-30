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

/* ---------------------------------------------------------------- past-events */

export const PAST_EVENTS_ISLAND = "past-events";
export const PAST_EVENTS_PAGE_SIZE = 20;
export const PAST_EVENTS_TESTID = "past-events";
export const PAST_EVENTS_LIST_TESTID = "past-events-list";
export const PAST_EVENTS_EMPTY_TESTID = "past-events-empty";
export const PAST_EVENTS_OUT_OF_RANGE_TESTID = "past-events-out-of-range";
export const PAST_EVENTS_COPY = {
  empty: "No past events yet.",
  join: "Join the community and help make the next one happen.",
  failed: "Could not load that page. Your current events are still here — try the page link again.",
} as const;

export function pastEventsOutOfRangeCopy(page: number, totalPages: number): string {
  return `Page ${page} is outside the archive. There ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}.`;
}

/** Page turns read SSR HTML; the archive never fetches viewer answers. */
export function pastEventsRequest(page: number): { method: "GET"; url: string } {
  return { method: "GET", url: pastEventsUrl(page) };
}

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

/**
 * Trap verdict: true when the honeypot value is filled. A present non-string
 * value counts as filled (fail-closed); absent/empty inputs are genuine
 * clicks and never trip. Honeypot half of profileTrapTripped, without the
 * profile form's opened-at floor (the RSVP click island carries no trap).
 */
export function rsvpHoneyFilled(value: unknown): boolean {
  return typeof value === "string" ? value !== "" : value !== undefined && value !== null;
}

/** True when a PUT body carries a filled honeypot and the write must be swallowed. */
export function rsvpTrapTripped(input: Record<string, unknown>): boolean {
  return rsvpHoneyFilled(input[RSVP_HONEY_FIELD]);
}

/* ------------------------------------------------------------ member-profile
 * Legacy: app/Livewire/MemberProfile.php + member-profile.blade.php +
 * MemberProfileTest.php (TOG-8137 session-first ordering, TOG-6957 focus
 * moves, TOG-8715/TOG-9361 oracle-free trap). Server: src/profiles/routes.tsx
 * (W7, TOG-9686). Re-spec §5.
 *
 * Deviations from the legacy row list, recorded so nobody hunts for them:
 * - Rank has no W7 source yet; the view renders it only when SSR is handed
 *   one (`MemberView.rank`), never a placeholder. Joined month comes from
 *   users.created_at.
 * - The save is one PATCH /members/{id} sent as JSON with `accept:
 *   application/json`; the no-JS form posts `_method=PATCH` and gets the same
 *   outcome as a 303.
 */

export const MEMBER_PROFILE_ISLAND = "member-profile";

export const PROFILE_VIEW_TESTID = "profile-view";
export const PROFILE_AVATAR_TESTID = "profile-avatar";
export const PROFILE_NAME_TESTID = "profile-name";
export const PROFILE_RANK_TESTID = "profile-rank";
export const PROFILE_JOINED_TESTID = "profile-joined";
export const PROFILE_EDIT_TESTID = "profile-edit";
export const PROFILE_FORM_TESTID = "profile-form";
export const PROFILE_SAVE_TESTID = "profile-save";
export const PROFILE_CANCEL_TESTID = "profile-cancel";
export const PROFILE_SAVED_TESTID = "profile-saved";
export const PROFILE_ERROR_TESTID = "profile-error";
export const PROFILE_SAVE_FAILED_TESTID = "profile-save-failed";
export const PROFILE_SESSION_EXPIRED_TESTID = "profile-session-expired";

export const PROFILE_LIMITS = { bio: 1000, gamesMax: 20, gameChars: 80 } as const;

export const PROFILE_COPY = {
  saved: "Profile saved.",
  saveFailed: "Could not save your profile. Your changes are still here — try again.",
  sessionExpired: "Your session expired. Your changes are still here.",
  logIn: "Log in with Discord",
  edit: "Edit profile",
  save: "Save",
  cancel: "Cancel",
} as const;

/** Spam trap (TOG-8715/TOG-9361): decoy field + server-side open-time floor. */
export const PROFILE_HONEY_FIELD = "website";
export const PROFILE_OPENED_AT_FIELD = "formOpenedAt";
export const PROFILE_MIN_FILL_MS = 1000;

/** The one exposure rule: only the owner is ever handed an edit control. */
export function profileEditVisible(viewerId: string, memberId: string): boolean {
  return viewerId === memberId;
}

export interface ProfileWriteBody {
  bio: string;
  games_text: string;
  timezone: string;
  website: string;
  formOpenedAt: number;
}

export interface ProfileWriteRequest {
  method: "PATCH";
  url: string;
  body: ProfileWriteBody;
}

/** Exactly one PATCH per save; cancel fires nothing. */
export function profileWriteRequest(memberId: string, body: ProfileWriteBody): ProfileWriteRequest {
  return { method: "PATCH", url: `/members/${encodeURIComponent(memberId)}`, body };
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Client-side mirror of the server rules; the server stays authoritative. */
export function profileClientErrors(input: {
  bio: string;
  games_text: string;
  timezone: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (CONTROL_CHARS.test(input.bio) || CONTROL_CHARS.test(input.games_text) || CONTROL_CHARS.test(input.timezone)) {
    errors.control = "Remove control characters.";
  }
  if ([...input.bio].length > PROFILE_LIMITS.bio) errors.bio = "Keep your bio to 1000 characters or fewer.";
  const games: string[] = [];
  for (const line of input.games_text.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if ([...t].length > PROFILE_LIMITS.gameChars) errors.games ??= "Keep each game name to 80 characters or fewer.";
    if (t !== "" && !games.includes(t)) games.push(t);
  }
  if (games.length > PROFILE_LIMITS.gamesMax) errors.games ??= "Add no more than 20 games.";
  if (input.timezone !== "") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      errors.timezone = "Choose a valid IANA timezone, e.g. Europe/London.";
    }
  }
  return errors;
}

export type ProfileOutcome = "saved" | "invalid" | "failed" | "session-expired" | "cancelled";

/** Focus after each outcome: heading, alert, or saved confirmation (TOG-6957). */
export function profileFocusTarget(outcome: ProfileOutcome): string | null {
  switch (outcome) {
    case "saved":
      return PROFILE_SAVED_TESTID;
    case "invalid":
      return PROFILE_ERROR_TESTID;
    case "failed":
      return PROFILE_SAVE_FAILED_TESTID;
    case "session-expired":
      return PROFILE_SESSION_EXPIRED_TESTID;
    case "cancelled":
      return PROFILE_NAME_TESTID;
  }
}

/**
 * Trap verdict: true when a VALID save should be silently swallowed. Missing
 * `formOpenedAt` is no signal (API clients), a future/garbled one counts as
 * bot-fast. Called only after validation passed — errors always surface first.
 */
export function profileTrapTripped(input: Record<string, unknown>, nowMs: number): boolean {
  const honey = input[PROFILE_HONEY_FIELD];
  if (typeof honey === "string" ? honey !== "" : honey !== undefined && honey !== null) return true;
  const opened = input[PROFILE_OPENED_AT_FIELD];
  if (opened === undefined || opened === null || opened === "") return false;
  const n = Number(opened);
  return !Number.isFinite(n) || nowMs - n < PROFILE_MIN_FILL_MS;
}

/** Discord CDN avatar with srcset, or null so SSR renders the initial fallback. */
export function profileAvatarSrcset(id: string, avatar: string | null): { src: string; srcset: string } | null {
  if (!avatar || !/^[a-z0-9_]{1,64}$/i.test(avatar)) return null;
  const base = `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`;
  return { src: `${base}?size=128`, srcset: `${base}?size=64 1x, ${base}?size=128 2x, ${base}?size=256 3x` };
}

export function profileJoinedMonth(joinedAt: Date | null): string | null {
  return joinedAt
    ? joinedAt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    : null;
}
