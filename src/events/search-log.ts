// Event search logging (W8 follow-up, ports legacy EventSearchLogger, TOG-8400).
// Normalized query + result count only: no user id, session, IP or raw input.
// Fail-open: a down table degrades to an unrecorded search, never a broken page.
import { count, desc, eq, max, asc, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { eventSearchLogs } from "../db/admin-schema";
import { nonSensitiveRead } from "../member-reads";

export const MAX_QUERY_LENGTH = 255;

/** NUL is rejected by PostgreSQL text parameters; drop it before matching or logging. */
const stripNul = (raw: string | null | undefined): string => (raw ?? "").replace(/\u0000/g, "");

/** Matching input: trimmed original text (no collapse/lowercase, as legacy). null = blank = not a search. */
export function matchQuery(raw: string | null | undefined): string | null {
  const t = stripNul(raw).trim();
  return t === "" ? null : t;
}

/** Analytics form: collapse whitespace runs, lowercase, cap at 255 chars. null = blank. */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const n = stripNul(raw).trim().replace(/\s+/gu, " ").toLowerCase();
  if (n === "") return null;
  return [...n].slice(0, MAX_QUERY_LENGTH).join("");
}

/** Write deadline: logging must never hold the response (a locked table would wait forever). */
export const LOG_WRITE_DEADLINE_MS = 500;
/** DB-side cap, shorter than the response deadline, so a blocked INSERT is cancelled server-side rather than left queued. */
export const LOG_DB_TIMEOUT_MS = 400;

/** Never throws, never waits past the deadline. Logs the error class only (a driver message can carry the DSN). */
export async function recordSearch(
  db: Db,
  raw: string | null | undefined,
  resultCount: number,
  deadlineMs = LOG_WRITE_DEADLINE_MS,
): Promise<void> {
  const normalized = normalizeQuery(raw);
  if (normalized === null) return;
  const warn = (exception: string) =>
    console.warn("Event search unavailable for logging; serving results without recording.", { exception });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (async () => {
    try {
      await db.transaction(async (tx) => {
        // Transaction-scoped: lock waits and the statement itself are cancelled by Postgres, freeing the connection.
        await nonSensitiveRead("timeouts", () => tx.execute(
          sql`select set_config('lock_timeout', ${`${LOG_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${LOG_DB_TIMEOUT_MS}ms`}, true)`,
        ));
        await tx.insert(eventSearchLogs).values({ normalizedQuery: normalized, resultCount: Math.max(0, resultCount) });
      });
    } catch (err) {
      warn(err instanceof Error ? err.constructor.name : typeof err);
    }
  })();
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warn("LogWriteDeadline");
      resolve();
    }, deadlineMs);
  });
  try {
    await Promise.race([write, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type ZeroResultSearch = { query: string; searches: number; lastSearchedAt: Date };

/** Read deadline: never hold the dashboard; outlasts LOG_DB_TIMEOUT_MS (see FUNNEL_READ_DEADLINE_MS). */
export const LOG_READ_DEADLINE_MS = 1500;

/**
 * Content-gap read: zero-result queries by miss count, ties alphabetical.
 * Optional analytics: never throws, never waits past the deadline — a blocked
 * or failed read resolves undefined so the dashboard omits the widget.
 * The SELECT runs in a transaction with DB-side lock/statement timeouts so
 * Postgres cancels a lock-blocked read server-side (a client-side race alone
 * would leave the SELECT holding a connection).
 */
export async function topZeroResultSearches(
  db: Db,
  limit = 10,
  deadlineMs = LOG_READ_DEADLINE_MS,
): Promise<ZeroResultSearch[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<ZeroResultSearch[] | undefined> => {
    try {
      return await db.transaction(async (tx) => {
        // Transaction-scoped: lock waits and the statement itself are cancelled by Postgres, freeing the connection.
        await nonSensitiveRead("timeouts", () => tx.execute(
          sql`select set_config('lock_timeout', ${`${LOG_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${LOG_DB_TIMEOUT_MS}ms`}, true)`,
        ));
        const rows = await nonSensitiveRead("search-widget", () => tx
          .select({
            query: eventSearchLogs.normalizedQuery,
            searches: count(),
            lastSearchedAt: max(eventSearchLogs.occurredAt),
          })
          .from(eventSearchLogs)
          .where(eq(eventSearchLogs.resultCount, 0))
          .groupBy(eventSearchLogs.normalizedQuery)
          .orderBy(desc(count()), asc(eventSearchLogs.normalizedQuery))
          .limit(Math.max(1, limit)));
        return rows.map((r) => ({ query: r.query, searches: Number(r.searches), lastSearchedAt: r.lastSearchedAt! }));
      });
    } catch {
      return undefined;
    }
  })();
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deadlineMs);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
