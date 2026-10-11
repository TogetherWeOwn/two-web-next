// Single source for the session cookie name. Every reader/writer of the
// signed session bearer imports this instead of declaring its own literal,
// so a rename can never silently split cookie identity across sign-in,
// status checks and profile reads.
export const SESSION_COOKIE = "__Host-two_session";
