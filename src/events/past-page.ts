import { PAST_EVENTS_PAGE_SIZE } from "../islands/contracts-past-events";

/** Invalid HTML archive pages/offsets retain the page-one fallback. */
export function normalizePastPage(page: number): number {
  return Number.isSafeInteger(page) &&
    page > 0 &&
    Number.isSafeInteger((page - 1) * PAST_EVENTS_PAGE_SIZE)
    ? page
    : 1;
}
