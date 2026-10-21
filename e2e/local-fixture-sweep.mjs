// Backstop sweep for RSVP fixtures made by the local browser spec.
//
// DB-direct: cancels leftover fixture events with one UPDATE on the disposable
// CI Postgres, spending zero QA logins. The previous HTTP sweep logged in as
// qa-moderator and cancelled through the admin UI; that login shared the
// 10/min `qa-login` throttle with every spec in the sequential smoke, so a
// fast runner compressed the run past the budget and 429'd the late parity
// logins. Cleanup needs no session proof — specs already prove cancel through
// the UI in their own `finally` blocks — so the backstop goes straight to the
// row. The caller (local-global-teardown.ts) guards the connection with
// requireGithubRunner + requireTestDatabase; this module never opens a
// connection itself and never touches staging or production.

export const LOCAL_FIXTURE_TITLE_PREFIXES = Object.freeze([
  "E2E Waitlist ",
  "E2E Promotion ",
  "E2E Pause ",
  "E2E Moderator ",
  "E2E Filter ",
]);
export const LOCAL_SWEEP_STATUSES = Object.freeze(["published", "draft"]);

/** True when a title belongs to the local browser fixtures (never the seeded event). */
export function isLocalFixtureTitle(title) {
  return LOCAL_FIXTURE_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

/**
 * Cancel every live fixture event in one statement. `sql` is a postgres.js
 * client (or a fake with the same tagged-template shape in tests). Returns
 * the cancelled event keys. Cancel is terminal and idempotent: already
 * cancelled rows are untouched, and the seeded event ("E2E Community Night")
 * matches no prefix so it is never swept.
 */
export async function sweepLocalFixturesDb(sql) {
  const rows = await sql`
    UPDATE events SET status = 'cancelled', updated_at = now()
    WHERE status IN ('draft', 'published')
      AND (
        title LIKE 'E2E Waitlist %'
        OR title LIKE 'E2E Promotion %'
        OR title LIKE 'E2E Pause %'
        OR title LIKE 'E2E Moderator %'
        OR title LIKE 'E2E Filter %'
      )
    RETURNING event_key
  `;
  return rows.map((row) => row.event_key);
}
