// Admin pages (W11 pt1). Plain server-rendered tables + forms in this repo's
// JSX idiom — no client JS, no component framework. Moderators get labelled
// fields and field errors; every form posts back to its own route.

import type { FC, PropsWithChildren } from "hono/jsx";
import type { Actor } from "./guard";
import type { EventRow, FeaturedRow } from "./store";
import { JOIN_RETENTION_DAYS, type JoinAttemptRow, type RosterEntry } from "./reads";

const Shell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — TWO admin</title>
      <link rel="stylesheet" href="/styles.css" />
      <style>{`
        .admin-table { width: 100%; border-collapse: collapse; }
        .admin-table th, .admin-table td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #d8cfc0; }
        .field { margin: 1rem 0; }
        .field label { display: block; font-weight: 700; margin-bottom: .25rem; }
        .field input, .field textarea, .field select { width: 100%; max-width: 34rem; font: inherit; padding: .5rem; }
        .field .hint { color: #6b6257; font-size: .85rem; }
        .field .error { color: #9a3412; font-size: .9rem; margin-top: .25rem; }
        .actions { display: flex; gap: .75rem; align-items: center; margin-top: 1.5rem; }
        .filters { display: flex; gap: .75rem; align-items: end; margin-bottom: 1rem; flex-wrap: wrap; }
        .filters .field { margin: 0; }
      `}</style>
    </head>
    <body>
      <header class="bar">
        <a class="brand" href="/admin">TWO admin</a>
        <nav>
          <a href="/admin/events">Events</a> · <a href="/admin/featured">Featured</a> · <a href="/admin/join-attempts">Join attempts</a> · <a href="/">Site</a>
        </nav>
      </header>
      <main>{children}</main>
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

export const AdminDashboard: FC<{ actor: Actor; funnel?: Record<string, number> }> = ({ actor, funnel }) => (
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
    </section>
  </Shell>
);

export const JoinAttemptsPage: FC<{ rows: JoinAttemptRow[]; outcome: string; q: string; outcomes: readonly string[] }> = ({
  rows,
  outcome,
  q,
  outcomes,
}) => (
  <Shell title="Join attempts">
    <section>
      <h1>Join attempts</h1>
      <p class="hint">Read-only. Last {JOIN_RETENTION_DAYS} days, newest first. Search is an exact Discord id or request id.</p>
      <form method="get" action="/admin/join-attempts" class="filters">
        <div class="field">
          <label for="q">Discord id or request id</label>
          <input id="q" name="q" type="search" value={q} />
        </div>
        <div class="field">
          <label for="outcome">Outcome</label>
          <select id="outcome" name="outcome">
            {["", ...outcomes].map((o) => (
              <option value={o} selected={o === outcome}>
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
                <td>{r.outcome}</td>
                <td>{r.source ?? ""}</td>
                <td>{r.discordId ?? ""}</td>
                <td>{r.requestId ?? ""}</td>
                <td>{r.createdAt.toISOString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  </Shell>
);

export const EventsPage: FC<{ rows: EventRow[]; q: string; status: string }> = ({ rows, q, status }) => (
  <Shell title="Events">
    <section>
      <h1>Events</h1>
      <form method="get" action="/admin/events" class="filters">
        <div class="field">
          <label for="q">Search</label>
          <input id="q" name="q" type="search" value={q} />
        </div>
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            {["", "draft", "published", "cancelled", "past"].map((s) => (
              <option value={s} selected={s === status}>
                {s === "" ? "All" : s}
              </option>
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
            <th>Title</th>
            <th>Status</th>
            <th>Starts</th>
            <th>Actions</th>
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
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
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
        <p class="error" role="alert" data-testid={`error-${name}`}>
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
}> = ({ mode, row, values, errors, roster }) => {
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
        <form method="post" action={action}>
          <Field name="title" label="Title" errors={errors}>
            {(id) => <input id={id} name="title" type="text" value={val(values, "title")} maxlength={100} required />}
          </Field>
          <Field name="game" label="Game" errors={errors}>
            {(id) => <input id={id} name="game" type="text" value={val(values, "game")} maxlength={100} />}
          </Field>
          <Field name="description" label="Description" errors={errors}>
            {(id) => <textarea id={id} name="description" rows={4}>{val(values, "description")}</textarea>}
          </Field>
          <Field name="starts_at" label="Starts (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
            {(id) => <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} required />}
          </Field>
          <Field name="ends_at" label="Ends (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
            {(id) => <input id={id} name="ends_at" type="text" value={val(values, "ends_at")} required />}
          </Field>
          <Field
            name="timezone"
            label="Timezone"
            errors={errors}
            hint="The IANA zone the wall time above is typed in. Storage is UTC."
          >
            {(id) => <input id={id} name="timezone" type="text" value={val(values, "timezone") || "Europe/London"} />}
          </Field>
          <Field name="location" label="Location" errors={errors}>
            {(id) => <input id={id} name="location" type="text" value={val(values, "location")} maxlength={255} />}
          </Field>
          <Field name="capacity" label="Capacity (empty = unlimited)" errors={errors}>
            {(id) => <input id={id} name="capacity" type="text" inputmode="numeric" value={val(values, "capacity")} />}
          </Field>
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
            </div>
          </section>
        ) : null}
        {mode === "edit" && roster ? (
          <section aria-label="RSVP roster" data-testid="rsvp-roster">
            <h2>RSVPs ({roster.length})</h2>
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Status</th>
                  <th>Answered</th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 ? (
                  <tr>
                    <td colspan={3} data-testid="roster-empty">
                      No RSVPs yet.
                    </td>
                  </tr>
                ) : (
                  roster.map((r) => (
                    <tr key={r.userId}>
                      <td>{r.username ?? r.userId}</td>
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
    </Shell>
  );
};

export const FeaturedPage: FC<{ rows: FeaturedRow[] }> = ({ rows }) => (
  <Shell title="Featured content">
    <section>
      <h1>Featured content</h1>
      <p>
        <a class="btn" href="/admin/featured/new" data-testid="new-featured">New featured slot</a>
      </p>
      <table class="admin-table" data-testid="featured-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Published</th>
            <th>Position</th>
            <th>Window (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colspan={4} data-testid="featured-empty">
                No featured content yet.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={`/admin/featured/${r.id}`}>{r.title}</a>
                </td>
                <td data-testid={`featured-published-${r.id}`}>{r.isPublished ? "yes" : "no"}</td>
                <td data-testid={`featured-position-${r.id}`}>{r.position}</td>
                <td>
                  {r.startsAt ? r.startsAt.toISOString() : "—"} → {r.endsAt ? r.endsAt.toISOString() : "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  </Shell>
);

export const FeaturedFormPage: FC<{
  mode: "new" | "edit";
  row?: FeaturedRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  roster?: RosterEntry[];
}> = ({ mode, row, values, errors, roster }) => {
  const action = mode === "new" ? "/admin/featured" : `/admin/featured/${row!.id}`;
  const checked = values.is_published === "on" || values.is_published === true || values.is_published === "true";
  return (
    <Shell title={mode === "new" ? "New featured slot" : `Edit ${row!.title}`}>
      <section>
        <h1>{mode === "new" ? "New featured slot" : `Edit ${row!.title}`}</h1>
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
          <Field name="image_url" label="Image URL" errors={errors}>
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
          <Field name="starts_at" label="Show from (UTC, YYYY-MM-DD HH:mm, or empty)" errors={errors}>
            {(id) => <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} />}
          </Field>
          <Field name="ends_at" label="Show until (UTC, YYYY-MM-DD HH:mm, or empty)" errors={errors}>
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
