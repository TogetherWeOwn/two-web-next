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
 */
export function printScopeCopy(
  surface: string,
  q: string,
  game: string | null,
  page: number,
  totalPages: number,
): string {
  return `${surface}${q ? ` · search “${q}”` : ""}${game ? ` · game ${game}` : ""} · ${
    totalPages > 0 ? `page ${page} of ${totalPages}` : "nothing listed"
  }. Only the events on this page are listed.`;
}
