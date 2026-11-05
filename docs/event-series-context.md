# Series context on event detail

Hono and Kit detail pages share `getEventSeriesContext` in
[`src/events/reads.ts`](../src/events/reads.ts). The decorative block lists
**Series hosts**, current host first, and links to the previous and next
occurrences by series index. It does not replace the global upcoming-event rail.

## Visibility and history

- Published and past occurrences belong to the readable series history. Moving
  an occurrence to `past` after it ends does not remove its host or series links.
- Draft and cancelled occurrences are excluded, including when a moderator views
  a draft current event. The current event's own host remains first because it
  is already visible on that page.
- Siblings whose starts cannot be represented as JavaScript dates are excluded
  before choosing neighbors or collecting hosts.
- No other visible occurrence means no series block, even if recurrence metadata
  exists. Events without recurrence metadata skip the read entirely.

## Bounded reads and degradation

The native recurrence writer creates at most 52 occurrences. Legacy imports do
not enforce that limit, so the read does not assume it:

- Fetch at most 53 projected rows: the supported 52 plus one overflow sentinel.
- Retrieve only link fields, organizer, series index and a size marker, never
  descriptions or join instructions.
- Limit the combined UTF-8 size of each row's key, title, timezone, location and
  organizer to 4096 bytes. SQL returns null text plus a false marker for an
  oversized row, rather than transferring that text to the Worker.
- If the sentinel or a false size marker appears, omit the **entire** series
  context. Never present a truncated host list or partial run as complete.
- A rejected series read also omits the block. The event, RSVP controls and
  independent discovery content retain their existing behavior.

The member-read classifier admits the complete normalized series query as a
fixed public projection. This permits its bounded `CASE` expressions without
allowing arbitrary computed event fields, subqueries or member-table reads.

These are read-side safeguards, not new constraints on event creation or import.
The query remains anonymous-safe and audit-silent; the page's private/no-store,
Cookie variation and member-data audit boundaries are unchanged.

## Bounded materialization writes

`materializeMissingInstances` (`src/admin/store-event-writes.ts`) serves both
moderator create and the `events:reconcile` pass, each inside its caller's
transaction. For a weekly series it spends a fixed number of statements, not
one pair per occurrence:

- One read of the existing recurrence indices, then **one** `INSERT` for every
  missing child (index 1 is the parent) and **one** `INSERT` into the activity
  log with one creation entry per child. A complete series, including a
  cancelled child, issues no write. Statements stay sequential on the
  transaction; there is no `ON CONFLICT` clause.
- The occurrence list, DST handling and the 52-occurrence ceiling still come
  from the pure `occurrences` function. Children are drafts with copied fields,
  a fresh event key, the parent link and the recurrence index.
- `RETURNING` order is not trusted. Each returned row must match a submitted
  recurrence index, key and parent exactly once; a missing, duplicate or foreign
  row throws before any audit is written, rolling back the whole transaction.
- Evidence: `test/series-materialization-batch-acceptance.test.ts` (recorded
  statements) and `test/series-materialization-batch-postgres.test.ts`
  (disposable database; prints one JSON receipt per 1/26/52-occurrence case
  with `case_id`, `verdict`, `error_code` and `next_action`). Run the second
  with `DATABASE_URL` set to a run-owned test database, never staging or
  production.
