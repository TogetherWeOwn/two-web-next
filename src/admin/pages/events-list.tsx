// Admin events-list screen: shared native filters and a bounded event table.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import {
  renderEventStartsInputsHtml,
  renderEventStartsFeedbackHtml,
  renderEventFilterFieldsHtml,
  renderEventFilterActionsHtml,
} from "../event-starts-inputs";
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
      {query.startsWindow?.error ? (
        <span>{label}</span>
      ) : (
        <a
          href={eventListUrl(query, { sort, order, page: 1 })}
          aria-label={`Sort by ${label.toLowerCase()} ${order === "asc" ? "ascending" : "descending"}`}
        >
          {label}
          {active ? (query.order === "asc" ? " ↑" : " ↓") : ""}
        </a>
      )}
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
        {raw(renderEventFilterFieldsHtml(query))}
        {raw(renderEventStartsInputsHtml(query.startsWindow))}
        {raw(renderEventFilterActionsHtml(query))}
      </form>
      {raw(renderEventStartsFeedbackHtml(query.startsWindow))}
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
                    {r.game?.trim() ? (
                      <span class="hint">
                        <br />
                        {r.game}
                      </span>
                    ) : null}
                  </td>
                  <td data-testid={`event-status-${r.eventKey}`}>{r.status}</td>
                  <td>
                    {Number.isFinite(r.startsAt.getTime()) ? (
                      <time datetime={r.startsAt.toISOString()}>{r.startsAt.toISOString()}</time>
                    ) : (
                      <span data-testid={`event-unrenderable-time-${r.eventKey}`}>
                        Unrenderable time
                      </span>
                    )}
                    {Number.isFinite(r.startsAt.getTime()) &&
                    !Number.isFinite(r.endsAt.getTime()) ? (
                      <span data-testid={`event-unrenderable-time-${r.eventKey}`}>
                        {" "}
                        (unrenderable end time)
                      </span>
                    ) : null}
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
      {!query.startsWindow?.error && rows.length === 0 && query.page > 1 ? (
        <p>
          <a href={eventListUrl(query, { page: 1 })}>First page of these results</a>
        </p>
      ) : null}
      <nav aria-label="Event pages" class="actions">
        {!query.startsWindow?.error && query.page > 1 ? (
          <a rel="prev" href={eventListUrl(query, { page: query.page - 1 })}>
            Previous
          </a>
        ) : null}
        <span>Page {query.page}</span>
        {!query.startsWindow?.error && hasNext ? (
          <a rel="next" href={eventListUrl(query, { page: query.page + 1 })}>
            Next
          </a>
        ) : null}
      </nav>
    </section>
  </Shell>
);
