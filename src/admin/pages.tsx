// Admin pages (W11 pt1). Plain server-rendered tables + forms in this repo's
// JSX idiom, with a small event-editor navigation guard. Moderators get labelled
// fields and field errors; every form posts back to its own route.

import type { ZeroResultSearch } from "../events/search-log";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { Actor } from "./guard";
import { currentlyVisible, FeaturedStatusBadge } from "../featured-status";
import { FeaturedContentItem, SkipLink } from "../pages";
import type { EventRow, FeaturedRow } from "./store";
import { eventListUrl, type EventListQuery, type EventSort } from "./event-list";
import { JOIN_RETENTION_DAYS, type JoinAttemptRow, type RosterEntry } from "./reads";
import { featuredListUrl, joinAttemptsUrl, rosterUrl, type FeaturedListQuery, type JoinAttemptsQuery, type RosterQuery, type SortOrder } from "./table-list";

const TableSortHeader: FC<{ label: string; active: boolean; order: SortOrder; url: (order: SortOrder) => string }> = ({ label, active, order, url }) => {
  const next = active && order === "asc" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <a href={url(next)} aria-label={`Sort by ${label.toLowerCase()} ${next === "asc" ? "ascending" : "descending"}`}>
        {label}{active ? (order === "asc" ? " ↑" : " ↓") : ""}
      </a>
    </th>
  );
};

const Shell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — TWO admin</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <SkipLink />
      <header class="bar">
        <a class="brand" href="/admin">TWO admin</a>
        <nav aria-label="Administration">
          <a href="/admin/events">Events</a> · <a href="/admin/featured">Featured</a> · <a href="/admin/join-attempts">Join attempts</a> · <a href="/">Site</a>
        </nav>
      </header>
      <main id="main" tabindex={-1}>{children}</main>
      <footer>Together We Own · moderators only</footer>
    </body>
  </html>
);

export const ErrorPage: FC<{ heading: string; detail?: string }> = ({ heading, detail }) => (
  <Shell title={heading}>
    <section>
      <h1>{heading}</h1>
      {detail ? <p data-testid="error-detail">{detail}</p> : null}
      <p>
        <a href="/admin">Back to the dashboard</a>
      </p>
    </section>
  </Shell>
);

export const AdminDashboard: FC<{ actor: Actor; funnel?: Record<string, number>; zeroSearches?: ZeroResultSearch[] }> = ({ actor, funnel, zeroSearches }) => (
  <Shell title="Dashboard">
    <section>
      <h1>Moderation</h1>
      <p class="lead">
        Signed in as <strong data-testid="admin-actor">{actor.username}</strong>.
      </p>
      <ul class="facts">
        <li class="card">
          <h2>
            <a href="/admin/events">Events</a>
          </h2>
          <p>Drafts, publishing, cancellations. Create-as-draft; events are never deleted.</p>
        </li>
        <li class="card">
          <h2>
            <a href="/admin/featured">Featured content</a>
          </h2>
          <p>Landing-page slots: publish toggle, ordering, show window.</p>
        </li>
      </ul>
      {funnel ? (
        <section data-testid="join-funnel">
          <h2>Join funnel, last {JOIN_RETENTION_DAYS} days</h2>
          {Object.keys(funnel).length === 0 ? (
            <p data-testid="join-funnel-empty">No join attempts in the window.</p>
          ) : (
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(funnel).map(([outcome, n]) => (
                  <tr key={outcome}>
                    <td>{outcome}</td>
                    <td data-testid={`funnel-${outcome}`}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
      {zeroSearches ? (
        <section data-testid="top-zero-searches">
          <h2>Top searches with no results</h2>
          <p>What guests looked for on /events and found nothing. A repeat miss is a game night nobody posted yet.</p>
          {zeroSearches.length === 0 ? (
            <p data-testid="top-zero-searches-empty">No missed searches.</p>
          ) : (
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Search</th>
                  <th>Misses</th>
                  <th>Last searched</th>
                </tr>
              </thead>
              <tbody>
                {zeroSearches.map((r) => (
                  <tr key={r.query}>
                    <td>{r.query}</td>
                    <td>{r.searches}</td>
                    <td>{r.lastSearchedAt.toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </section>
  </Shell>
);

export const JoinAttemptsPage: FC<{ rows: JoinAttemptRow[]; query: JoinAttemptsQuery; hasNext: boolean; outcomes: readonly string[] }> = ({
  rows,
  query,
  hasNext,
  outcomes,
}) => (
  <Shell title="Join attempts">
    <section>
      <h1>Join attempts</h1>
      <p class="hint">Read-only. Last {JOIN_RETENTION_DAYS} days, newest first. Search is an exact Discord id or request id.</p>
      <form method="get" action="/admin/join-attempts" class="filters">
        <div class="field">
          <label for="q">Discord id or request id</label>
          <input id="q" name="q" type="search" value={query.q} />
        </div>
        <div class="field">
          <label for="outcome">Outcome</label>
          <select id="outcome" name="outcome">
            {["", ...outcomes].map((o) => (
              <option value={o} selected={o === query.outcome}>
                {o === "" ? "All" : o}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <button type="submit" class="btn">Filter</button>
        </div>
      </form>
      <table class="admin-table" data-testid="join-attempts-table">
        <thead>
          <tr>
            <th>Outcome</th>
            <th>Source</th>
            <th>Discord id</th>
            <th>Request id</th>
            <th>Attempted</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colspan={5} data-testid="join-attempts-empty">
                No join attempts.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td><a href={`/admin/join-attempts/${r.id}`} aria-label={`View join attempt ${r.id}: ${r.outcome}`}>{r.outcome}</a></td>
                <td>{r.source ?? ""}</td>
                <td>{r.discordId ?? ""}</td>
                <td>{r.requestId ?? ""}</td>
                <td>{r.createdAt.toISOString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <nav aria-label="Join attempt pages" class="actions">
        {query.page > 1 ? <a rel="prev" href={joinAttemptsUrl(query, query.page - 1)}>Previous</a> : null}
        <span>Page {query.page}</span>
        {hasNext ? <a rel="next" href={joinAttemptsUrl(query, query.page + 1)}>Next</a> : null}
      </nav>
    </section>
  </Shell>
);

const RsvpAction: FC<{ row: EventRow }> = ({ row }) => {
  if (row.status !== "published" || row.endsAt <= new Date()) return null;
  const action = row.rsvpOpen ? "rsvp-pause" : "rsvp-reopen";
  return (
    <form method="post" action={`/admin/events/${row.eventKey}/${action}`}>
      <button type="submit" class="link" data-testid={action}>
        {row.rsvpOpen ? "Pause RSVPs" : "Reopen RSVPs"}
      </button>
    </form>
  );
};

export const JoinAttemptPage: FC<{ row: JoinAttemptRow }> = ({ row }) => (
  <Shell title={`Join attempt ${row.id}`}>
    <section>
      <p><a href="/admin/join-attempts">Back to join attempts</a></p>
      <h1>Join attempt {row.id}</h1>
      <p class="hint">Read-only. Attempted at and trace identifiers are shown as recorded.</p>
      <h2>Outcome</h2>
      <dl>
        <dt>Outcome</dt><dd>{row.outcome}</dd>
        <dt>Source</dt><dd>{row.source ?? "—"}</dd>
        <dt>Attempted at (UTC)</dt><dd><time datetime={row.createdAt.toISOString()}>{row.createdAt.toISOString()}</time></dd>
      </dl>
      <h2>Trace</h2>
      <dl>
        <dt>Request ID</dt><dd>{row.requestId ?? "—"}</dd>
        <dt>Discord ID</dt><dd>{row.discordId ?? "—"}</dd>
      </dl>
    </section>
  </Shell>
);

const EventSortHeader: FC<{ label: string; sort: EventSort; query: EventListQuery }> = ({ label, sort, query }) => {
  const active = query.sort === sort;
  const order = active && query.order === "asc" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (query.order === "asc" ? "ascending" : "descending") : "none"}>
      <a href={eventListUrl(query, { sort, order, page: 1 })} aria-label={`Sort by ${label.toLowerCase()} ${order === "asc" ? "ascending" : "descending"}`}>
        {label}{active ? (query.order === "asc" ? " ↑" : " ↓") : ""}
      </a>
    </th>
  );
};

export const EventsPage: FC<{ rows: EventRow[]; query: EventListQuery; hasNext: boolean }> = ({ rows, query, hasNext }) => (
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
            <option value="" selected={query.rsvp_open === ""}>All</option>
            <option value="1" selected={query.rsvp_open === "1"}>Open</option>
            <option value="0" selected={query.rsvp_open === "0"}>Paused</option>
          </select>
        </div>
        <div class="field">
          <label for="series">Series</label>
          <select id="series" name="series">
            {[["", "All"], ["parent", "Parent"], ["child", "Child"], ["standalone", "Standalone"]].map(([value, label]) => (
              <option value={value} selected={value === query.series}>{label}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="fill">Fill</label>
          <select id="fill" name="fill">
            {[["", "All"], ["full", "Full"], ["has_seats", "Has seats"], ["unlimited", "Unlimited"]].map(([value, label]) => (
              <option value={value} selected={value === query.fill}>{label}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <button type="submit" class="btn">Filter</button>
        </div>
      </form>
      <p>
        <a class="btn" href="/admin/events/new" data-testid="new-event">New event</a>
      </p>
      <table class="admin-table" data-testid="events-table">
        <thead>
          <tr>
            <EventSortHeader label="Title" sort="title" query={query} />
            <EventSortHeader label="Status" sort="status" query={query} />
            <EventSortHeader label="Starts" sort="starts_at" query={query} />
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colspan={4} data-testid="events-empty">
                No events yet.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.eventKey}>
                <td>
                  <a href={`/admin/events/${r.eventKey}`}>{r.title}</a>
                </td>
                <td data-testid={`event-status-${r.eventKey}`}>{r.status}</td>
                <td>{r.startsAt.toISOString()}</td>
                <td>
                  {r.status === "draft" ? (
                    <form method="post" action={`/admin/events/${r.eventKey}/publish`}>
                      <button type="submit" class="link">Publish</button>
                    </form>
                  ) : null}
                  {r.status === "draft" || r.status === "published" ? (
                    <form method="post" action={`/admin/events/${r.eventKey}/cancel`}>
                      <button type="submit" class="link">Cancel</button>
                    </form>
                  ) : null}
                  <RsvpAction row={r} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <nav aria-label="Event pages" class="actions">
        {query.page > 1 ? <a rel="prev" href={eventListUrl(query, { page: query.page - 1 })}>Previous</a> : null}
        <span>Page {query.page}</span>
        {hasNext ? <a rel="next" href={eventListUrl(query, { page: query.page + 1 })}>Next</a> : null}
      </nav>
    </section>
  </Shell>
);

type FieldProps = {
  name: string;
  label: string;
  errors: Record<string, string>;
  hint?: string;
  children: (id: string) => unknown;
};

const Field: FC<FieldProps> = ({ name, label, errors, hint, children }) => {
  const err = errors[name];
  const id = `f-${name.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children(id)}
      {hint ? <p class="hint">{hint}</p> : null}
      {err ? (
        <p id={`${id}-error`} class="error" role="alert" data-testid={`error-${name}`}>
          {err}
        </p>
      ) : null}
    </div>
  );
};

const val = (values: Record<string, unknown>, name: string): string => {
  const v = values[name];
  return typeof v === "string" ? v : "";
};

export const EventFormPage: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  roster?: RosterEntry[];
  rosterQuery?: RosterQuery;
}> = ({ mode, row, values, errors, roster, rosterQuery = { q: "", sort: "answered", order: "desc" } }) => {
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
        <form method="post" action={action} data-event-editor={mode === "edit" ? "" : undefined}
          data-event-draft={mode === "edit" && Object.keys(errors).length > 0 ? "" : undefined}>
          <Field name="title" label="Title" errors={errors}>
            {(id) => <input id={id} name="title" type="text" value={val(values, "title")} data-event-text-limit={100} required
              aria-invalid={errors.title ? "true" : undefined} aria-describedby={errors.title ? `${id}-error` : undefined} />}
          </Field>
          <Field name="game" label="Game" errors={errors}>
            {(id) => <input id={id} name="game" type="text" value={val(values, "game")} data-event-text-limit={100}
              aria-invalid={errors.game ? "true" : undefined} aria-describedby={errors.game ? `${id}-error` : undefined} />}
          </Field>
          <Field name="description" label="Description" errors={errors}>
            {(id) => <textarea id={id} name="description" rows={4}>{val(values, "description")}</textarea>}
          </Field>
          <Field name="starts_at" label="Starts (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
            {(id) => <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} required
              aria-invalid={errors.starts_at ? "true" : undefined} aria-describedby={errors.starts_at ? `${id}-error` : undefined} />}
          </Field>
          <Field name="ends_at" label="Ends (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
            {(id) => <input id={id} name="ends_at" type="text" value={val(values, "ends_at")} required
              aria-invalid={errors.ends_at ? "true" : undefined} aria-describedby={errors.ends_at ? `${id}-error` : undefined} />}
          </Field>
          <Field
            name="timezone"
            label="Timezone"
            errors={errors}
            hint="The IANA zone the wall time above is typed in. Storage is UTC."
          >
            {(id) => <input id={id} name="timezone" type="text" value={val(values, "timezone") || "Europe/London"}
              aria-invalid={errors.timezone ? "true" : undefined} aria-describedby={errors.timezone ? `${id}-error` : undefined} />}
          </Field>
          <Field name="location" label="Location" errors={errors}>
            {(id) => <input id={id} name="location" type="text" value={val(values, "location")} data-event-text-limit={255}
              aria-invalid={errors.location ? "true" : undefined} aria-describedby={errors.location ? `${id}-error` : undefined} />}
          </Field>
          <Field name="capacity" label="Capacity (empty = unlimited)" errors={errors}>
            {(id) => <input id={id} name="capacity" type="text" inputmode="numeric" value={val(values, "capacity")} />}
          </Field>
          {mode === "new" ? (
            <fieldset>
              <legend>Repeat</legend>
              <Field name="recurrence_frequency" label="Repeats" errors={errors} hint="Empty = a one-off event. Weeks keep the same wall time in the zone above across clock changes.">
                {(id) => (
                  <select id={id} name="recurrence_frequency">
                    <option value="" selected={val(values, "recurrence_frequency") === ""}>Does not repeat</option>
                    <option value="weekly" selected={val(values, "recurrence_frequency") === "weekly"}>Weekly</option>
                  </select>
                )}
              </Field>
              <Field name="recurrence_count" label="Occurrences (including the first, max 52)" errors={errors}>
                {(id) => <input id={id} name="recurrence_count" type="text" inputmode="numeric" value={val(values, "recurrence_count")} />}
              </Field>
              <Field name="recurrence_ends_on" label="Repeat until (YYYY-MM-DD)" errors={errors}>
                {(id) => <input id={id} name="recurrence_ends_on" type="text" value={val(values, "recurrence_ends_on")} />}
              </Field>
            </fieldset>
          ) : row?.recurrenceFrequency ? (
            <p class="hint" data-testid="series-info">
              Part of a {row.recurrenceFrequency} series. Moving this event moves the not-yet-started occurrences by the same amount.
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
                  <button type="submit" class="btn" data-testid="publish-event">Publish</button>
                </form>
              ) : null}
              {row.status === "draft" || row.status === "published" ? (
                <form method="post" action={`/admin/events/${row.eventKey}/cancel`}>
                  <button type="submit" class="link" data-testid="cancel-event">Cancel event</button>
                </form>
              ) : null}
              <RsvpAction row={row} />
            </div>
          </section>
        ) : null}
        {mode === "edit" && roster ? (
          <section id="rsvp-roster" aria-label="RSVP roster" data-testid="rsvp-roster">
            <h2>RSVPs ({roster.length})</h2>
            <p class="hint">Save event changes before searching or sorting the roster.</p>
            <form method="get" action={`${action}#rsvp-roster`} class="filters">
              <input type="hidden" name="roster_sort" value={rosterQuery.sort} />
              <input type="hidden" name="roster_order" value={rosterQuery.order} />
              <div class="field">
                <label for="roster-q">Search members</label>
                <input id="roster-q" name="roster_q" type="search" value={rosterQuery.q} />
              </div>
              <div class="field"><button type="submit" class="btn">Search</button></div>
            </form>
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <TableSortHeader label="Status" active={rosterQuery.sort === "status"} order={rosterQuery.order} url={(order) => rosterUrl(row!.eventKey, rosterQuery, { sort: "status", order })} />
                  <TableSortHeader label="Answered" active={rosterQuery.sort === "answered"} order={rosterQuery.order} url={(order) => rosterUrl(row!.eventKey, rosterQuery, { sort: "answered", order })} />
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 ? (
                  <tr>
                    <td colspan={3} data-testid="roster-empty">
                      {rosterQuery.q ? "No RSVPs match this member search." : "No RSVPs yet."}
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
          </section>
        ) : null}
      </section>
      <script type="module" src="/islands/admin-event-text-limits.js" />
      {mode === "edit" ? <script src="/islands/admin-event-editor.js" defer /> : null}
    </Shell>
  );
};

export const FeaturedPage: FC<{ rows: FeaturedRow[]; query: FeaturedListQuery; now?: Date }> = ({ rows, query, now = new Date() }) => (
  <Shell title="Featured content">
    <section>
      <h1>Featured content</h1>
      <p>
        <a class="btn" href="/admin/featured/new" data-testid="new-featured">New featured slot</a>
      </p>
      <form method="get" action="/admin/featured" class="filters">
        <input type="hidden" name="sort" value={query.sort} />
        <input type="hidden" name="order" value={query.order} />
        <div class="field">
          <label for="q">Search titles</label>
          <input id="q" name="q" type="search" value={query.q} />
        </div>
        <div class="field">
          <label for="published">Published</label>
          <select id="published" name="published">
            <option value="" selected={query.published === ""}>All</option>
            <option value="1" selected={query.published === "1"}>Published</option>
            <option value="0" selected={query.published === "0"}>Unpublished</option>
          </select>
        </div>
        <div class="field"><button type="submit" class="btn">Filter</button></div>
      </form>
      <p id="featured-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
      <div class="featured-table-scroll" role="region" aria-label="Featured content list" aria-describedby="featured-scroll-hint" tabindex={0} data-testid="featured-table-scroll">
      <table class="admin-table featured-table" data-testid="featured-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <TableSortHeader label="Position" active={query.sort === "position"} order={query.order} url={(order) => featuredListUrl(query, { sort: "position", order })} />
            <th scope="col">Window (UTC)</th>
            <TableSortHeader label="Last changed" active={query.sort === "updated_at"} order={query.order} url={(order) => featuredListUrl(query, { sort: "updated_at", order })} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colspan={5} data-testid="featured-empty">
                {query.q || query.published ? "No featured content matches these filters." : "No featured content yet."}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={`/admin/featured/${r.id}`}>{r.title}</a>
                </td>
                <td data-testid={`featured-status-${r.id}`}><FeaturedStatusBadge row={r} now={now} /></td>
                <td data-testid={`featured-position-${r.id}`}>{r.position}</td>
                <td>
                  <span class="featured-window-bound">{r.startsAt ? <time datetime={r.startsAt.toISOString()}>{r.startsAt.toISOString()}</time> : "—"}</span>
                  <span class="featured-window-bound">→ {r.endsAt ? <time datetime={r.endsAt.toISOString()}>{r.endsAt.toISOString()}</time> : "—"}</span>
                </td>
                <td><time datetime={r.updatedAt.toISOString()}>{r.updatedAt.toISOString()}</time></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </section>
  </Shell>
);

export const FeaturedFormPage: FC<{
  mode: "new" | "edit";
  row?: FeaturedRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  now?: Date;
  appUrl: string;
  imageHosts?: string;
}> = ({ mode, row, values, errors, now = new Date(), appUrl, imageHosts }) => {
  const action = mode === "new" ? "/admin/featured" : `/admin/featured/${row!.id}`;
  const checked = values.is_published === "on" || values.is_published === true || values.is_published === "true";
  return (
    <Shell title={mode === "new" ? "New featured slot" : `Edit ${row!.title}`}>
      <section class="featured-form">
        <h1>{mode === "new" ? "New featured slot" : `Edit ${row!.title}`}</h1>
        {mode === "edit" && row ? (
          <section class="featured-preview" aria-labelledby="featured-preview-heading" data-testid="featured-preview">
            <h2 id="featured-preview-heading">Homepage preview</h2>
            <p>Last saved content, checked at <time datetime={now.toISOString()}>{now.toISOString()}</time> (UTC). Save changes to refresh this preview.</p>
            <p>Status: <FeaturedStatusBadge row={row} now={now} /></p>
            {currentlyVisible(row, now) ? (
              <FeaturedContentItem row={row} appUrl={appUrl} imageHosts={imageHosts} />
            ) : (
              <p data-testid="featured-preview-hidden">This slot is not currently visible on the homepage.</p>
            )}
          </section>
        ) : null}
        {Object.keys(errors).length > 0 ? (
          <p class="notice" role="alert" data-testid="form-errors">
            Check the highlighted fields and try again.
          </p>
        ) : null}
        <form method="post" action={action}>
          <Field name="title" label="Headline" errors={errors}>
            {(id) => <input id={id} name="title" type="text" value={val(values, "title")} maxlength={255} required />}
          </Field>
          <Field name="body" label="Body" errors={errors}>
            {(id) => <textarea id={id} name="body" rows={4}>{val(values, "body")}</textarea>}
          </Field>
          <Field name="url" label="Link (full http(s) URL, or empty)" errors={errors}>
            {(id) => <input id={id} name="url" type="url" value={val(values, "url")} />}
          </Field>
          <Field name="image_url" label="Image URL" errors={errors} hint="HTTPS URL on cdn.discordapp.com or a configured approved public host. Other image hosts are blocked by the site's security policy.">
            {(id) => <input id={id} name="image_url" type="url" value={val(values, "image_url")} />}
          </Field>
          <Field
            name="image_alt"
            label="Image description"
            errors={errors}
            hint="Required when an image URL is set — one plain sentence for screen-reader visitors."
          >
            {(id) => <input id={id} name="image_alt" type="text" value={val(values, "image_alt")} maxlength={255} />}
          </Field>
          <div class="field">
            <label for="f-is-published">Published</label>
            <input id="f-is-published" name="is_published" type="checkbox" checked={checked} />
          </div>
          <Field name="position" label="Position (lower appears first)" errors={errors}>
            {(id) => (
              <input id={id} name="position" type="text" inputmode="numeric" value={val(values, "position") || "0"} />
            )}
          </Field>
          <Field name="starts_at" label="Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)" errors={errors}>
            {(id) => <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} />}
          </Field>
          <Field name="ends_at" label="Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)" errors={errors}>
            {(id) => <input id={id} name="ends_at" type="text" value={val(values, "ends_at")} />}
          </Field>
          <div class="actions">
            <button type="submit" class="btn" data-testid="save-featured">
              {mode === "new" ? "Create" : "Save"}
            </button>
            <a href="/admin/featured">Cancel</a>
          </div>
        </form>
        {mode === "edit" ? (
          <form method="post" action={`/admin/featured/${row!.id}/delete`}>
            <div class="actions">
              <button type="submit" class="link" data-testid="delete-featured">
                Delete this slot
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </Shell>
  );
};
