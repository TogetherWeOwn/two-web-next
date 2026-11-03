/**
 * event-echoes island contract: cream-band testids and record labels.
 * Part of the island contract family; re-exported from `./contracts` so
 * existing import paths keep working. No island mount: Echoes are frozen
 * server-rendered records, never live-refreshed.
 */

/** Home cream band section ("Last time, as the bot recorded it"). */
export const ECHO_BAND_TESTID = "event-echoes-band";
/** One frozen record card inside the band, archive and detail alike. */
export const ECHO_CARD_TESTID = "event-echo-card";
/** Record-label line: "attendance record" on Echo events, "sign-up record" before. */
export const ECHO_RECORD_TESTID = "event-record-label";
/** Detail-page Echo section. */
export const ECHO_DETAIL_TESTID = "event-echo";
/** Own-profile played-minutes line (F20: the member's own minutes only). */
export const ECHO_OWN_MINUTES_TESTID = "event-echo-own-minutes";

/** Record label, binding the backfill policy: an event WITH an Echo is the
 * attendance record; anything earlier is the sign-up record, forever.
 * Pure copy in the island-contract leaf (no DB graph) so the Kit card can
 * bundle it for browsers without the server rendering graph. */
export const ECHO_RECORD_LABEL = "attendance record" as const;
export const SIGNUP_RECORD_LABEL = "sign-up record" as const;

export function recordLabel(
  hasEcho: boolean,
): typeof ECHO_RECORD_LABEL | typeof SIGNUP_RECORD_LABEL {
  return hasEcho ? ECHO_RECORD_LABEL : SIGNUP_RECORD_LABEL;
}

/** Minimal counts shape the one-line copy reads: raw rows and the public
 * projection both satisfy it (only the room count renders). */
export type EchoCounts = {
  attendedCount: number;
  peakConcurrent: number;
  rooms: readonly unknown[];
};

/** One-line counts copy shared by the cream band, the detail section and the
 * archive cards on both renderers — one Echo reads identically everywhere
 * (acceptance). */
export function echoShortLine(echo: EchoCounts): string {
  const count = echo.rooms.length;
  const rooms = count > 0 ? ` across ${count} room${count === 1 ? "" : "s"}` : "";
  return `${echo.attendedCount} showed up${rooms} · peak ${echo.peakConcurrent} in voice`;
}
