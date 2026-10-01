import { and, asc, eq, gte, sql } from "drizzle-orm";
import { dbFor } from "../admin/db";
import { events } from "../db/admin-schema";
import type { Env } from "../env";

export type SuggestedEvent = {
  key: string;
  title: string;
  startsAt: Date;
  location: string | null;
};

export const SUGGESTIONS_DEADLINE_MS = 500;
const DB_TIMEOUT_MS = 400;

// Like the optional search widget: cap SQL on the server and the entire read
// (including DB acquisition) at the response boundary. Never read a session.
export async function notFoundSuggestions(env: Env, now = new Date()): Promise<SuggestedEvent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<SuggestedEvent[]> => {
    try {
      const db = await dbFor({ env });
      if (!db) return [];
      const suggestions = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${DB_TIMEOUT_MS}ms`}, true)`,
        );
        // Upcoming means not ended, matching listUpcoming and the legacy scope.
        // Drizzle select/where/orderBy/limit: https://orm.drizzle.team/docs/select
        return tx
          .select({ key: events.eventKey, title: events.title, startsAt: events.startsAt, location: events.location })
          .from(events)
          .where(and(eq(events.status, "published"), gte(events.endsAt, now), sql`isfinite(${events.startsAt})`))
          .orderBy(asc(events.startsAt), asc(events.id))
          .limit(3);
      });
      // PostgreSQL infinity timestamps decode to invalid Dates; keep them out
      // of the renderer so optional recovery links cannot turn a 404 into 500.
      return suggestions.filter((event) => Number.isFinite(event.startsAt.getTime()));
    } catch {
      return [];
    }
  })();
  const deadline = new Promise<SuggestedEvent[]>((resolve) => {
    timer = setTimeout(() => resolve([]), SUGGESTIONS_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
