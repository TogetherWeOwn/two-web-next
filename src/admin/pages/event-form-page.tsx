// Admin event-form screen: new and edit (split from event-form.tsx; zero behavior change).
// Composes the per-concern leaves inside the admin Shell: validation notice and
// fields, then the edit-only status and RSVP roster sections.

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import type { RosterEntry } from "../reads";
import type { RosterQuery } from "../table-list";
import { EventFormFields } from "./event-form-fields";
import { EventRosterSection } from "./event-form-roster";
import { EventStatusSection } from "./event-form-status";
import { Shell } from "./shell";

export const EventFormPage: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  roster?: RosterEntry[];
  rosterTotal?: number;
  rosterQuery?: RosterQuery;
  // Refused-edit re-renders only: the roster is read solely on the audited
  // GET, so a 422 re-render explains its absence instead of dropping the
  // section silently. Carries no roster data of any kind.
  rosterHiddenNotice?: boolean;
}> = ({ mode, row, values, errors, roster, rosterTotal, rosterQuery, rosterHiddenNotice }) => {
  const action = mode === "new" ? "/admin/events" : `/admin/events/${row!.eventKey}`;
  return (
    <Shell title={mode === "new" ? "New event" : `Edit ${row!.title}`}>
      <section>
        <h1>{mode === "new" ? "New event" : `Edit ${row!.title}`}</h1>
        <EventFormFields mode={mode} row={row} values={values} errors={errors} action={action} />
        {mode === "edit" && row ? <EventStatusSection row={row} /> : null}
        {mode === "edit" && roster ? (
          <EventRosterSection
            eventKey={row!.eventKey}
            action={action}
            roster={roster}
            rosterTotal={rosterTotal}
            rosterQuery={rosterQuery}
          />
        ) : mode === "edit" && rosterHiddenNotice && row ? (
          <section aria-label="RSVP roster" data-testid="roster-hidden-notice">
            <h2>RSVPs</h2>
            <p class="notice">
              The RSVP roster is hidden here because this save was refused. No RSVP data has changed
              — every response is still recorded. <a href={action}>Reload the edit page</a> to show
              the roster again. Reloading discards the unsaved edits currently shown, so fix the
              highlighted fields and save first if you want to keep them.
            </p>
          </section>
        ) : null}
      </section>
      <script type="module" src="/islands/admin-event-text-limits.js" />
      <script src="/islands/admin-event-editor.js" defer />
    </Shell>
  );
};
