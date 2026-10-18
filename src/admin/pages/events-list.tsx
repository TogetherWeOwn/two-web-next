// Admin events-list screen (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import type { EventListRow } from "../store";
import { goingCountText } from "../../islands/contracts";
import { eventEmptyText, eventListUrl, type EventListQuery, type EventSort } from "../event-list";
import { RsvpAction, Shell } from "./shell";

const EventSortHeader: FC<{ label: string; sort: EventSort; query: EventListQuery }> = ({
  label,
  sort,
  query,
}) => {
  const active = query.sort === sort;
  const order = active && query.order === "asc" ? "desc" : "asc";
  return (
    <th
      scope="col"
      aria-sort={active ? (query.order === "asc" ? "ascending" : "descending") : "none"}
    >
      <a
        href={eventListUrl(query, { sort, order, page: 1 })}
        aria-label={`Sort by ${label.toLowerCase()} ${order === "asc" ? "ascending" : "descending"}`}
      >
        {label}
        {active ? (query.order === "asc" ? " ↑" : " ↓") : ""}
      </a>
    </th>
  );
};

/**
 * Going-only seat fill for one admin list row. Maybe/Waitlist/Not going never
 * occupy a seat (same rule as the fill filter); uncapped events show "N going".
 * A capped event at or over capacity carries a Full badge, and an
 * over-capacity row (more Going than seats) carries an Over capacity badge.
 */
const EventFillCell: FC<{ row: EventListRow }> = ({ row }) => (
  <td data-testid={`event-fill-${row.eventKey}`}>
    {goingCountText(row.goingCount, row.capacity)}
    {row.capacity !== null && row.goingCount >= row.capacity ? (
      <span data-testid={`event-fill-badge-${row.eventKey}`}> Full</span>
    ) : null}
    {row.capacity !== null && row.goingCount > row.capacity ? (
      <span data-testid={`event-over-capacity-${row.eventKey}`}> Over capacity</span>
    ) : null}
  </td>
);

export const EventsPage: FC<{ rows: EventListRow[]; query: EventListQuery; hasNext: boolean }> = ({
  rows,
  query,
  hasNext,
}) => (
  <Shell title="Events">
    <section>
      <h1>Events</h1>
      <form method="get" action="/admin/events" class="filters">
        <input type="hidden" name="sort" value={query.sort} />
        <input type="hidden" name="order" value={query.order} />
        <div class="field">
          <label for="q">Search</label>
          <input id="q" name="q" type="search" value={query.q} />
        </div>
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            {["", "draft", "published", "cancelled", "past"].map((s) => (
              <option value={s} selected={s === query.status}>
                {s === "" ? "All" : s}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="rsvp_open">RSVPs</label>
          <select id="rsvp_open" name="rsvp_open">
            <option value="" selected={query.rsvp_open === ""}>
              All
            </option>
            <option value="1" selected={query.rsvp_open === "1"}>
              Open
            </option>
            <option value="0" selected={query.rsvp_open === "0"}>
              Paused
            </option>
          </select>
        </div>
        <div class="field">
          <label for="series">Series</label>
          <select id="series" name="series">
            {[
              ["", "All"],
              ["parent", "Parent"],
              ["child", "Child"],
              ["standalone", "Standalone"],
            ].map(([value, label]) => (
              <option value={value} selected={value === query.series}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="fill">Fill</label>
          <select id="fill" name="fill">
            {[
              ["", "All"],
              ["full", "Full"],
              ["has_seats", "Has seats"],
              ["unlimited", "Unlimited"],
            ].map(([value, label]) => (
              <option value={value} selected={value === query.fill}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <button type="submit" class="btn">
            Filter
          </button>
        </div>
      </form>
      <p>
        <a class="btn" href="/admin/events/new" data-testid="new-event">
          New event
        </a>
      </p>
      <p id="events-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
      <div
        class="admin-table-scroll"
        role="region"
        aria-label="Events list"
        aria-describedby="events-scroll-hint"
        tabindex={0}
        data-testid="events-table-scroll"
      >
        <table class="admin-table" data-testid="events-table">
          <thead>
            <tr>
              <EventSortHeader label="Title" sort="title" query={query} />
              <EventSortHeader label="Status" sort="status" query={query} />
              <EventSortHeader label="Starts (UTC)" sort="starts_at" query={query} />
              <th scope="col">Fill</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={5} data-testid="events-empty">
                  {eventEmptyText(query)}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.eventKey}>
                  <td>
                    <a href={`/admin/events/${r.eventKey}`}>{r.title}</a>
                  </td>
                  <td data-testid={`event-status-${r.eventKey}`}>{r.status}</td>
                  <td>
                    <time datetime={r.startsAt.toISOString()}>{r.startsAt.toISOString()}</time>
                  </td>
                  <EventFillCell row={r} />
                  <td>
                    {r.status === "draft" ? (
                      <form method="post" action={`/admin/events/${r.eventKey}/publish`}>
                        <button type="submit" class="link">
                          Publish
                        </button>
                      </form>
                    ) : null}
                    {r.status === "draft" || r.status === "published" ? (
                      <form method="post" action={`/admin/events/${r.eventKey}/cancel`}>
                        <button type="submit" class="link">
                          Cancel
                        </button>
                      </form>
                    ) : null}
                    <RsvpAction row={r} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <nav aria-label="Event pages" class="actions">
        {query.page > 1 ? (
          <a rel="prev" href={eventListUrl(query, { page: query.page - 1 })}>
            Previous
          </a>
        ) : null}
        <span>Page {query.page}</span>
        {hasNext ? (
          <a rel="next" href={eventListUrl(query, { page: query.page + 1 })}>
            Next
          </a>
        ) : null}
      </nav>
    </section>
  </Shell>
);
