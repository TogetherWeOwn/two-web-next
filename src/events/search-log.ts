// Event search logging (W8 follow-up, ports legacy EventSearchLogger, TOG-8400).
// Normalized query + result count only: no user id, session, IP or raw input.
// Fail-open: a down table degrades to an unrecorded search, never a broken page.
import { count, desc, eq, max, asc } from "drizzle-orm";
import type { Db } from "../db/index";
import { eventSearchLogs } from "../db/admin-schema";

export const MAX_QUERY_LENGTH = 255;

/** Collapse whitespace runs, lowercase, cap at 255 chars. null = blank = not a search. */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const n = (raw ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
  if (n === "") return null;
  return [...n].slice(0, MAX_QUERY_LENGTH).join("");
}

/** Never throws. Logs the error class only (a driver message can carry the DSN). */
export async function recordSearch(db: Db, raw: string | null | undefined, resultCount: number): Promise<void> {
  const normalized = normalizeQuery(raw);
  if (normalized === null) return;
  try {
    await db.insert(eventSearchLogs).values({ normalizedQuery: normalized, resultCount: Math.max(0, resultCount) });
  } catch (err) {
    console.warn("Event search unavailable for logging; serving results without recording.", {
      exception: err instanceof Error ? err.constructor.name : typeof err,
    });
  }
}

export type ZeroResultSearch = { query: string; searches: number; lastSearchedAt: Date };

/** Content-gap read: zero-result queries by miss count, ties alphabetical. */
export async function topZeroResultSearches(db: Db, limit = 10): Promise<ZeroResultSearch[]> {
  const rows = await db
    .select({ query: eventSearchLogs.normalizedQuery, searches: count(), lastSearchedAt: max(eventSearchLogs.occurredAt) })
    .from(eventSearchLogs)
    .where(eq(eventSearchLogs.resultCount, 0))
    .groupBy(eventSearchLogs.normalizedQuery)
    .orderBy(desc(count()), asc(eventSearchLogs.normalizedQuery))
    .limit(Math.max(1, limit));
  return rows.map((r) => ({ query: r.query, searches: Number(r.searches), lastSearchedAt: r.lastSearchedAt! }));
}
