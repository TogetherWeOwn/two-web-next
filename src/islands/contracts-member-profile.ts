/**
 * member-profile island contract: testids, save budget, validation mirror
 * and trap helpers. Part of the island contract family; re-exported from
 * `./contracts` so existing import paths keep working.
 */

/* ------------------------------------------------------------ member-profile
 * Legacy: app/Livewire/MemberProfile.php + member-profile.blade.php +
 * MemberProfileTest.php (TOG-8137 session-first ordering, TOG-6957 focus
 * moves, TOG-8715/TOG-9361 oracle-free trap). Server: src/profiles/routes.tsx
 * (W7, TOG-9686). Re-spec §5.
 *
 * Deviations from the legacy row list, recorded so nobody hunts for them:
 * - Rank has no profile-row source; the view renders it only from member
 *   stats (`stats.rankKey`), never a placeholder. Joined month comes from
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
export const PROFILE_UNCERTAIN_TESTID = "profile-uncertain";

/**
 * Owned client deadline for a profile save, covering fetch plus
 * response-body completion (TOG-11625). Finite and wall-clock: when it passes
 * before the single in-flight PATCH settles, the binder aborts the owned
 * fetch where AbortController exists, shows the uncertain notice with the
 * draft intact, and releases the controls. Timeout ownership ends there — a
 * late completion can never replace newer feedback or mutate the accepted
 * baseline, cancel disposes the timer/abort, and the timeout is never
 * represented as a server rollback (no automatic resend, no second PATCH
 * while the earlier write remains unsettled). The unsettled-write admission
 * gate itself is owned elsewhere; this deadline only bounds the feedback.
 */
export const PROFILE_SAVE_DEADLINE_MS = 10_000;

export const PROFILE_LIMITS = { bio: 1000, gamesMax: 20, gameChars: 80 } as const;

export const PROFILE_COPY = {
  saved: "Profile saved.",
  saveFailed: "Could not save your profile. Your changes are still here — try again.",
  sessionExpired: "Your session expired. Your changes are still here.",
  uncertain:
    "Still saving — this is taking longer than expected. It may still have gone through; wait a moment, then save again if nothing changed.",
  logIn: "Log in with Discord",
  edit: "Edit profile",
  save: "Save",
  cancel: "Cancel",
} as const;

/**
 * Empty-state copy, owner-aware: the owner is told what to add,
 * visitors are told what is missing, and a profile with nothing filled in
 * reads as new rather than neglected. The binder only ever runs for the
 * owner, so it mirrors the `*Owner`/`bioNew` strings verbatim.
 */
export const PROFILE_EMPTY_COPY = {
  bioOwner: "You have not added a bio yet.",
  bioOther: (name: string) => `${name} has not added a bio yet.`,
  bioNew: "New here. More soon.",
  gamesOwner: "Add the games you keep coming back to.",
  gamesOther: "No games listed yet.",
  timezoneOwner: "Add yours so people know when you are around.",
  timezoneOther: "Not listed yet.",
} as const;

export const PROFILE_NEW_MEMBER_TESTID = "profile-new-member";
export const PROFILE_NEW_MEMBER_CTA_TESTID = "profile-new-member-cta";
export const PROFILE_NEW_MEMBER_COPY = {
  heading: "Your profile has room to grow.",
  body: "Add a bio, a few games and your timezone so people know when to find you.",
  cta: "Add profile details",
} as const;

/** New member: nothing the member can edit has been filled in yet. */
export function profileIsNewMember(profile: {
  bio: string | null;
  games: readonly string[];
  timezone: string | null;
}): boolean {
  return !profile.bio && profile.games.length === 0 && !profile.timezone;
}

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
  if (
    CONTROL_CHARS.test(input.bio) ||
    CONTROL_CHARS.test(input.games_text) ||
    CONTROL_CHARS.test(input.timezone)
  ) {
    errors.control = "Remove control characters.";
  }
  if ([...input.bio].length > PROFILE_LIMITS.bio)
    errors.bio = "Keep your bio to 1000 characters or fewer.";
  const games: string[] = [];
  for (const line of input.games_text.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if ([...t].length > PROFILE_LIMITS.gameChars)
      errors.games ??= "Keep each game name to 80 characters or fewer.";
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

/**
 * Admin event/featured editor session-expiry notice (TOG-12399): the island
 * vetoes the probe reload so the unsaved draft stays reachable, releases the
 * dirty guard for the recovery trip, and shows this durable notice with the
 * recovery link from the event detail.
 */
export const ADMIN_SESSION_EXPIRED_TESTID = "admin-session-expired";
export const ADMIN_SESSION_EXPIRED_COPY = "Your session expired. Your changes are still here.";

export type ProfileOutcome =
  | "saved"
  | "invalid"
  | "failed"
  | "session-expired"
  | "uncertain"
  | "cancelled";

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
    case "uncertain":
      return PROFILE_UNCERTAIN_TESTID;
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
export function profileAvatarSrcset(
  id: string,
  avatar: string | null,
): { src: string; srcset: string } | null {
  if (!avatar || !/^[a-z0-9_]{1,64}$/i.test(avatar)) return null;
  const base = `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`;
  return {
    src: `${base}?size=128`,
    srcset: `${base}?size=64 1x, ${base}?size=128 2x, ${base}?size=256 3x`,
  };
}

export function profileJoinedMonth(joinedAt: Date | null): string | null {
  return joinedAt
    ? joinedAt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    : null;
}
