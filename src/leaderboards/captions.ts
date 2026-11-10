// Board caption copy: the single source for the scope + window line both
// twins render. Pure (no store, no db): the Kit twin imports this module
// directly, so the Hono and Kit captions stay byte-identical and the window
// math lives in exactly one place.
import type { MemberScope } from "./members";

/** Neighbors shown above and below the viewer in the relative scope. */
export const RELATIVE_NEIGHBORS = 5;
/** Members shown on the overall board: ranks 1..100. */
export const OVERALL_CAP = 100;

export type BoardCaptionQuery = {
  season: string;
  scope: MemberScope;
  activity: string | null;
};

/**
 * One line naming the scope, the window and the filters: the overall scope
 * names the 1..OVERALL_CAP cap, the relative scope the neighbor window, and
 * both keep the season and game labels (including the every-game fallback).
 */
export function boardCaption({ season, scope, activity }: BoardCaptionQuery): string {
  const label = activity === null ? "every game" : activity;
  const base = `Going counts, season ${season}, ${label}`;
  return scope === "overall"
    ? `Overall (ranks 1–${OVERALL_CAP}): ${base}`
    : `Around you (${RELATIVE_NEIGHBORS} above and below): ${base}`;
}
