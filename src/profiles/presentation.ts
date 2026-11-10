// Dependency-free profile presentation shared by Hono and Svelte. Importing
// display values must not evaluate the server renderer or its database reads.

// Stable field/error ids for profile validation association.
// The server `games` key maps to the `games_text` control; any other key is
// global and stays in the summary without a fabricated control link.
export const PROFILE_FIELD_IDS = {
  bio: "profile-bio",
  games_text: "profile-games-text",
  timezone: "profile-timezone",
  leaderboard_opt_out: "profile-leaderboard-opt-out",
} as const;
type ProfileField = keyof typeof PROFILE_FIELD_IDS;
export const PROFILE_ERROR_IDS: Record<ProfileField, string> = {
  bio: "profile-bio-error",
  games_text: "profile-games-text-error",
  timezone: "profile-timezone-error",
  leaderboard_opt_out: "profile-leaderboard-opt-out-error",
};
// The timezone help text stays associated in both valid and error states.
export const PROFILE_TIMEZONE_HELP_ID = "profile-timezone-help";
export const profileFieldForErrorKey = (key: string): ProfileField | null =>
  key === "bio"
    ? "bio"
    : key === "games" || key === "games_text"
      ? "games_text"
      : key === "timezone"
        ? "timezone"
        : key === "leaderboard_opt_out"
          ? "leaderboard_opt_out"
          : null;
export const statsLabel = (key: string) =>
  key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
// Legacy parity: the avatar fallback is the first two code points, uppercased.
export const profileInitials = (username: string) =>
  [...username].slice(0, 2).join("").toUpperCase() || "?";
export const statsDate = (date: Date) =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

// The description stays generic: the only member data in share tags is the
// name already in the title. Guests are bounced before any profile renders.
export const PROFILE_SHARE_DESCRIPTION = "A member of Together We Own.";

// Failed-save re-render shape shared by both renderers.
export type ProfileFormValues = {
  bio: string;
  games_text: string;
  timezone: string;
  leaderboard_opt_out: boolean;
};
