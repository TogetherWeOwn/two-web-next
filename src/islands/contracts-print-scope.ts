/**
 * Print scope stamp for the /events list view and the /events/past archive.
 * Screen-hidden, revealed by the schedule sheet's print block; both renderers
 * (Hono JSX, Kit Svelte) share this copy so the twins cannot drift.
 */

export const EVENTS_PRINT_SCOPE_TESTID = "events-print-scope";
export const PAST_EVENTS_PRINT_SCOPE_TESTID = "past-events-print-scope";

/**
 * One line naming the committed scope of the printed page: the surface, the
 * committed search text and game, and the page position when the schedule has
 * pages. It describes only what is on this page; it never claims a total.
 * With no upcoming pages the stamp must still name what renders instead of
 * reading "nothing listed" over event cards: `past` for a past-only page
 * ("past matches only" under a search or game filter, "past events only" in
 * the unfiltered gap), `page1` for unpaged upcoming cards (Discord
 * transients render without any upcoming page).
 */
export function printScopeCopy(
  surface: string,
  q: string,
  game: string | null,
  page: number,
  totalPages: number,
  zeroPage: false | "past" | "page1" = false,
): string {
  const position =
    totalPages > 0
      ? `page ${page} of ${totalPages}`
      : zeroPage === "past"
        ? q || game
          ? "past matches only"
          : "past events only"
        : zeroPage === "page1"
          ? "page 1"
          : "nothing listed";
  return `${surface}${q ? ` · search “${q}”` : ""}${game ? ` · game ${game}` : ""} · ${position}. Only the events on this page are listed.`;
}
