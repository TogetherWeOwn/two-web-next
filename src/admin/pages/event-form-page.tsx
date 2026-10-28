// Admin event-form screen: new and edit (split from event-form.tsx; zero behavior change).
// Composes the per-concern leaves inside the admin Shell: validation notice and
// fields, then the edit-only status and RSVP roster sections.

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import type { RosterEntry } from "../reads";
import type { CapacityPanel } from "../event-capacity";
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
  capacity?: CapacityPanel;
}> = ({ mode, row, values, errors, roster, rosterTotal, rosterQuery, capacity }) => {
  const action = mode === "new" ? "/admin/events" : `/admin/events/${row!.eventKey}`;
  return (
    <Shell title={mode === "new" ? "New event" : `Edit ${row!.title}`}>
      <section>
        <h1>{mode === "new" ? "New event" : `Edit ${row!.title}`}</h1>
        <EventFormFields
          mode={mode}
          row={row}
          values={values}
          errors={errors}
          action={action}
          capacity={capacity}
        />
        {mode === "edit" && row ? <EventStatusSection row={row} /> : null}
        {mode === "edit" && roster ? (
          <EventRosterSection
            eventKey={row!.eventKey}
            action={action}
            roster={roster}
            rosterTotal={rosterTotal}
            rosterQuery={rosterQuery}
          />
        ) : null}
      </section>
      <script type="module" src="/islands/admin-event-text-limits.js" />
      <script src="/islands/admin-event-editor.js" defer />
      {capacity ? <script src="/islands/admin-event-capacity.js" defer /> : null}
    </Shell>
  );
};
