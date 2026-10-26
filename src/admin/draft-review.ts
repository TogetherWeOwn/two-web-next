// Optional drafts-awaiting-review dashboard signal: one bounded existence
// read over non-member event rows, shared by the Hono dashboard route
// (src/admin/routes.tsx) and the Kit dashboard load
// (web/src/routes/admin/+page.server.ts). Same bounded-optional-widget
// contract as the funnel (src/admin/join-funnel.ts) and the zero-search
// widget (src/events/search-log.ts): the SELECT runs in a transaction with
// DB-side lock/statement timeouts, every attempt is bounded by a
// response-side deadline, classified outages propagate to the dashboard's
// shared 503 boundary, and every other failure resolves undefined so the
// dashboard omits the signal instead of failing the page.
//
// Existence, not a count: one constant projection with LIMIT 1 over
// draft-status rows — never COUNT, never a row/roster projection, never a
// member read. The 'draft' status and the LIMIT are literals (both fixed
// constants, never user input) so the statement keeps its pinned,
// reviewable shape; the read classifier pins the exact normalized text
// (src/db/read-classification.ts). Framework-free by construction: no
// cookies, session, audit, or SvelteKit/Workers imports.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events } from "../db/admin-schema";
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../db/errors";
import { nonSensitiveRead } from "../member-reads";

/**
 * Read deadline: the optional widget must never hold the dashboard (a locked
 * table would wait forever). Same family as the funnel's: it outlasts the
 * DB-side cap with room for connect, BEGIN and the sibling widgets'
 * transactions on the shared one-connection pool.
 */
export const DRAFT_READ_DEADLINE_MS = 1500;
/** DB-side cap well below the response deadline so Postgres cancels a lock-blocked SELECT server-side. */
export const DRAFT_DB_TIMEOUT_MS = 400;

/**
 * Dashboard-facing draft-existence read: true when at least one draft event
 * row exists, false when none does, undefined when the read degrades
 * (failed, timed-out or cancelled) so the dashboard omits the signal.
 * Connection outages propagate to the shared sanitized 503 handler; this
 * widget's own PostgreSQL cancellations degrade to undefined.
 */
export async function hasDraftsAwaitingReview(
  db: Db,
  deadlineMs = DRAFT_READ_DEADLINE_MS,
): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Settles when the SELECT's permit releases (or stays unset when the
  // transaction never reaches the SELECT). The outer deadline waits for it
  // below, so the dashboard never renders while this widget still holds
  // the member-read capture — without this, the outer race could win in
  // the same tick the inner race releases the permit, and the boundary
  // would refuse the page for a still-pending read.
  let selectReleased: Promise<void> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  // Promise.race also consumes late rejections after the deadline has won.
  const settled = (async (): Promise<boolean | undefined> => {
    try {
      const rows = await db.transaction(async (tx) => {
        await nonSensitiveRead("timeouts", () =>
          tx.execute(
            sql`select set_config('lock_timeout', ${`${DRAFT_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${DRAFT_DB_TIMEOUT_MS}ms`}, true)`,
          ),
        );
        // Bound the permit-held wait as well as the whole attempt: race the
        // SELECT against the shared deadline INSIDE its permit, so a stuck
        // query releases the member-read capture at the deadline instead of
        // holding the dashboard past it. (The DB-side cap above is the
        // primary bound in production; this mirrors it for paths without
        // server-side cancellation.) A timeout resolves null, never
        // mistaken for the empty set, which is a truthful "no drafts".
        const select = nonSensitiveRead("draft-widget", () =>
          Promise.race([
            tx.execute(sql`select 1 from ${events} where ${events.status} = 'draft' limit 1`),
            timeout,
          ]),
        );
        selectReleased = select.then(
          () => undefined,
          () => undefined,
        );
        return await select;
      });
      // Timeout (null) or an unexpected shape degrades to an omitted
      // signal; only a real row set answers the existence question.
      if (!Array.isArray(rows)) return undefined;
      return rows.length > 0;
    } catch (err) {
      if (isDatabaseUnavailable(err) && !isDatabaseQueryCancellation(err)) throw err;
      return undefined;
    }
  })();
  try {
    const outcome = await Promise.race([settled, timeout.then(() => undefined)]);
    if (selectReleased) await selectReleased;
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}
