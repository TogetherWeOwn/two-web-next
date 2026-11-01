// Admin event-form RSVP roster (split from event-form.tsx; zero behavior change).
// Edit-only roster: search filter, sortable table, range line and prev/next pagination.

import type { FC } from "hono/jsx";
import type { RosterEntry } from "../reads";
import {
  ROSTER_PAGE_SIZE,
  ROSTER_STATUSES,
  rosterEmptyText,
  rosterRangeText,
  rosterRecovery,
  rosterUrl,
  type RosterQuery,
} from "../table-list";
import { TableSortHeader } from "./shell";

export const EventRosterSection: FC<{
  eventKey: string;
  action: string;
  roster: RosterEntry[];
  rosterTotal?: number;
  rosterQuery?: RosterQuery;
}> = ({
  eventKey,
  action,
  roster,
  rosterTotal,
  rosterQuery = { q: "", status: "", sort: "answered", order: "desc", page: 1 },
}) => {
  const total = rosterTotal ?? roster.length;
  const rangeStart = roster.length > 0 ? (rosterQuery.page - 1) * ROSTER_PAGE_SIZE + 1 : 0;
  const rangeEnd =
    roster.length > 0 ? (rosterQuery.page - 1) * ROSTER_PAGE_SIZE + roster.length : 0;
  const rosterHasNext = rosterQuery.page * ROSTER_PAGE_SIZE < total;
  const recovery = rosterRecovery(eventKey, rosterQuery, roster.length, total);
  return (
    <section id="rsvp-roster" aria-label="RSVP roster" data-testid="rsvp-roster">
      <h2>RSVPs ({total})</h2>
      <p class="hint">Save event changes before searching or sorting the roster.</p>
      <p class="hint">
        Waitlist position is global queue order, not a promised seat or attendance. Searching and
        filtering do not renumber it; Answered shows the latest update, not priority. Paused or
        closed queues do not advance.
      </p>
      <p data-testid="roster-range">{rosterRangeText(rangeStart, rangeEnd, total)}</p>
      <form method="get" action={`${action}#rsvp-roster`} class="filters">
        <input type="hidden" name="roster_sort" value={rosterQuery.sort} />
        <input type="hidden" name="roster_order" value={rosterQuery.order} />
        <div class="field">
          <label for="roster-status">Answer status</label>
          <select id="roster-status" name="roster_status">
            {ROSTER_STATUSES.map((o) => (
              <option value={o.value} selected={o.value === rosterQuery.status}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="roster-q">Search members</label>
          <input id="roster-q" name="roster_q" type="search" value={rosterQuery.q} />
        </div>
        <div class="field">
          <button type="submit" class="btn">
            Search
          </button>
        </div>
      </form>
      <p id="roster-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
      <div
        class="admin-table-scroll"
        role="region"
        aria-label="RSVP roster list"
        aria-describedby="roster-scroll-hint"
        tabindex={0}
        data-testid="roster-table-scroll"
      >
        <table class="admin-table" data-testid="roster-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <TableSortHeader
                label="Status"
                active={rosterQuery.sort === "status"}
                order={rosterQuery.order}
                url={(order) =>
                  rosterUrl(eventKey, rosterQuery, { sort: "status", order, page: 1 })
                }
              />
              <TableSortHeader
                label="Answered"
                active={rosterQuery.sort === "answered"}
                order={rosterQuery.order}
                url={(order) =>
                  rosterUrl(eventKey, rosterQuery, { sort: "answered", order, page: 1 })
                }
              />
              <TableSortHeader
                label="Waitlist position"
                active={rosterQuery.sort === "waitlist"}
                order={rosterQuery.order}
                url={(order) =>
                  rosterUrl(eventKey, rosterQuery, { sort: "waitlist", order, page: 1 })
                }
              />
            </tr>
          </thead>
          <tbody>
            {roster.length === 0 ? (
              <tr>
                <td colspan={4} data-testid="roster-empty">
                  {total > 0 ? "No RSVPs on this page." : rosterEmptyText(rosterQuery)}
                </td>
              </tr>
            ) : (
              roster.map((r) => (
                <tr key={r.userId}>
                  <td>{r.username?.trim() || "Unknown member"}</td>
                  <td>{r.status}</td>
                  <td>{r.answeredAt.toISOString()}</td>
                  <td>{r.status === "waitlisted" ? (r.waitlistPosition ?? "—") : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {recovery.clearUrl || recovery.firstUrl ? (
        <p class="actions">
          {recovery.firstUrl ? <a href={recovery.firstUrl}>First page of these responses</a> : null}
          {recovery.clearUrl ? <a href={recovery.clearUrl}>Clear roster filters</a> : null}
        </p>
      ) : null}
      <nav aria-label="RSVP roster pages" class="actions">
        {rosterQuery.page > 1 ? (
          <a rel="prev" href={rosterUrl(eventKey, rosterQuery, { page: rosterQuery.page - 1 })}>
            Previous
          </a>
        ) : null}
        <span>Page {rosterQuery.page}</span>
        {rosterHasNext ? (
          <a rel="next" href={rosterUrl(eventKey, rosterQuery, { page: rosterQuery.page + 1 })}>
            Next
          </a>
        ) : null}
      </nav>
    </section>
  );
};
