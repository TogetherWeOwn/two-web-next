// Admin event-form screen: new and edit (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import type { RosterEntry } from "../reads";
import { ROSTER_PAGE_SIZE, rosterEmptyText, rosterUrl, type RosterQuery } from "../table-list";
import { Field, RsvpAction, Shell, TableSortHeader, val } from "./shell";

export const EventFormPage: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  roster?: RosterEntry[];
  rosterTotal?: number;
  rosterQuery?: RosterQuery;
}> = ({
  mode,
  row,
  values,
  errors,
  roster,
  rosterTotal,
  rosterQuery = { q: "", sort: "answered", order: "desc", page: 1 },
}) => {
  const total = rosterTotal ?? roster?.length ?? 0;
  const rangeStart =
    roster && roster.length > 0 ? (rosterQuery.page - 1) * ROSTER_PAGE_SIZE + 1 : 0;
  const rangeEnd =
    roster && roster.length > 0 ? (rosterQuery.page - 1) * ROSTER_PAGE_SIZE + roster.length : 0;
  const rosterHasNext = rosterQuery.page * ROSTER_PAGE_SIZE < total;
  const action = mode === "new" ? "/admin/events" : `/admin/events/${row!.eventKey}`;
  return (
    <Shell title={mode === "new" ? "New event" : `Edit ${row!.title}`}>
      <section>
        <h1>{mode === "new" ? "New event" : `Edit ${row!.title}`}</h1>
        {Object.keys(errors).length > 0 ? (
          <p class="notice" role="alert" data-testid="form-errors">
            Check the highlighted fields and try again.
          </p>
        ) : null}
        <form
          method="post"
          action={action}
          data-event-editor=""
          data-event-draft={Object.keys(errors).length > 0 ? "" : undefined}
        >
          <Field name="title" label="Title" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="title"
                type="text"
                value={val(values, "title")}
                data-event-text-limit={100}
                required
              />
            )}
          </Field>
          <Field name="game" label="Game" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="game"
                type="text"
                value={val(values, "game")}
                data-event-text-limit={100}
              />
            )}
          </Field>
          <Field name="description" label="Description" errors={errors}>
            {(id) => (
              <textarea id={id} name="description" rows={4}>
                {val(values, "description")}
              </textarea>
            )}
          </Field>
          <Field
            name="starts_at"
            label="Starts (local wall time, YYYY-MM-DD HH:mm)"
            errors={errors}
          >
            {(id) => (
              <input
                id={id}
                name="starts_at"
                type="text"
                value={val(values, "starts_at")}
                required
              />
            )}
          </Field>
          <Field name="ends_at" label="Ends (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
            {(id) => (
              <input id={id} name="ends_at" type="text" value={val(values, "ends_at")} required />
            )}
          </Field>
          <Field
            name="timezone"
            label="Timezone"
            errors={errors}
            hint="The IANA zone the wall time above is typed in. Storage is UTC."
          >
            {(id) => (
              <input
                id={id}
                name="timezone"
                type="text"
                value={val(values, "timezone") || "Europe/London"}
              />
            )}
          </Field>
          <Field name="location" label="Location" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="location"
                type="text"
                value={val(values, "location")}
                data-event-text-limit={255}
              />
            )}
          </Field>
          <Field name="capacity" label="Capacity (empty = unlimited)" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="capacity"
                type="text"
                inputmode="numeric"
                value={val(values, "capacity")}
              />
            )}
          </Field>
          {mode === "new" ? (
            <fieldset>
              <legend>Repeat</legend>
              <Field
                name="recurrence_frequency"
                label="Repeats"
                errors={errors}
                hint="Empty = a one-off event. Weeks keep the same wall time in the zone above across clock changes."
              >
                {(id) => (
                  <select id={id} name="recurrence_frequency">
                    <option value="" selected={val(values, "recurrence_frequency") === ""}>
                      Does not repeat
                    </option>
                    <option
                      value="weekly"
                      selected={val(values, "recurrence_frequency") === "weekly"}
                    >
                      Weekly
                    </option>
                  </select>
                )}
              </Field>
              <Field
                name="recurrence_count"
                label="Occurrences (including the first, max 52)"
                errors={errors}
              >
                {(id) => (
                  <input
                    id={id}
                    name="recurrence_count"
                    type="text"
                    inputmode="numeric"
                    value={val(values, "recurrence_count")}
                  />
                )}
              </Field>
              <Field name="recurrence_ends_on" label="Repeat until (YYYY-MM-DD)" errors={errors}>
                {(id) => (
                  <input
                    id={id}
                    name="recurrence_ends_on"
                    type="text"
                    value={val(values, "recurrence_ends_on")}
                  />
                )}
              </Field>
            </fieldset>
          ) : row?.recurrenceFrequency ? (
            <p class="hint" data-testid="series-info">
              Part of a {row.recurrenceFrequency} series. Moving this event moves the
              not-yet-started occurrences by the same amount.
            </p>
          ) : null}
          <div class="actions">
            <button type="submit" class="btn" data-testid="save-event">
              {mode === "new" ? "Create draft" : "Save"}
            </button>
            <a href="/admin/events">Cancel</a>
          </div>
        </form>
        {mode === "edit" && row ? (
          <section aria-label="Status">
            <h2>Status: {row.status}</h2>
            <div class="actions">
              {row.status === "draft" ? (
                <form method="post" action={`/admin/events/${row.eventKey}/publish`}>
                  <button type="submit" class="btn" data-testid="publish-event">
                    Publish
                  </button>
                </form>
              ) : null}
              {row.status === "draft" || row.status === "published" ? (
                <form method="post" action={`/admin/events/${row.eventKey}/cancel`}>
                  <button type="submit" class="link" data-testid="cancel-event">
                    Cancel event
                  </button>
                </form>
              ) : null}
              <RsvpAction row={row} />
            </div>
          </section>
        ) : null}
        {mode === "edit" && roster ? (
          <section id="rsvp-roster" aria-label="RSVP roster" data-testid="rsvp-roster">
            <h2>RSVPs ({total})</h2>
            <p class="hint">Save event changes before searching or sorting the roster.</p>
            <p data-testid="roster-range">
              Showing {rangeStart}-{rangeEnd} of {total}
            </p>
            <form method="get" action={`${action}#rsvp-roster`} class="filters">
              <input type="hidden" name="roster_sort" value={rosterQuery.sort} />
              <input type="hidden" name="roster_order" value={rosterQuery.order} />
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
            <p id="roster-scroll-hint">
              Scroll horizontally to see all columns on smaller screens.
            </p>
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
                        rosterUrl(row!.eventKey, rosterQuery, { sort: "status", order, page: 1 })
                      }
                    />
                    <TableSortHeader
                      label="Answered"
                      active={rosterQuery.sort === "answered"}
                      order={rosterQuery.order}
                      url={(order) =>
                        rosterUrl(row!.eventKey, rosterQuery, { sort: "answered", order, page: 1 })
                      }
                    />
                  </tr>
                </thead>
                <tbody>
                  {roster.length === 0 ? (
                    <tr>
                      <td colspan={3} data-testid="roster-empty">
                        {total > 0 ? "No RSVPs on this page." : rosterEmptyText(rosterQuery)}
                      </td>
                    </tr>
                  ) : (
                    roster.map((r) => (
                      <tr key={r.userId}>
                        <td>{r.username?.trim() || "Unknown member"}</td>
                        <td>{r.status}</td>
                        <td>{r.answeredAt.toISOString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <nav aria-label="RSVP roster pages" class="actions">
              {rosterQuery.page > 1 ? (
                <a
                  rel="prev"
                  href={rosterUrl(row!.eventKey, rosterQuery, { page: rosterQuery.page - 1 })}
                >
                  Previous
                </a>
              ) : null}
              <span>Page {rosterQuery.page}</span>
              {rosterHasNext ? (
                <a
                  rel="next"
                  href={rosterUrl(row!.eventKey, rosterQuery, { page: rosterQuery.page + 1 })}
                >
                  Next
                </a>
              ) : null}
            </nav>
          </section>
        ) : null}
      </section>
      <script type="module" src="/islands/admin-event-text-limits.js" />
      <script src="/islands/admin-event-editor.js" defer />
    </Shell>
  );
};
