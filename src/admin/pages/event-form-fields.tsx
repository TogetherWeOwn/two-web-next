// Admin event-form fields and validation notice (split from event-form.tsx; zero behavior change).
// The <form> element: title/game/description/schedule/location/capacity fields,
// the create-only recurrence fieldset or the edit-only series note, and the
// save/cancel actions. Field errors render through the shared Field helper.

import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { adminSaveStatus } from "../save-status";
import { SAVE_BASELINE_FIELD } from "../save-baseline";
import type { EventRow } from "../store";
import { Field, val } from "./shell";
import { ValidationSummary } from "./validation-summary";
import { StaleSaveNotice } from "./stale-save-notice";
import { EventEditableFields } from "./event-editable-fields";

export const EventFormFields: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  action: string;
  saveRefused?: "stale" | "unverified";
}> = ({ mode, row, values, errors, action, saveRefused }) => {
  return (
    <>
      {saveRefused ? (
        <StaleSaveNotice
          kind="event"
          action={action}
          updatedAt={row?.updatedAt}
          unverified={saveRefused === "unverified"}
          errors={errors}
        />
      ) : (
        <ValidationSummary errors={errors} kind="event" mode={mode} />
      )}
      <form
        method="post"
        action={action}
        data-event-editor=""
        data-event-draft={saveRefused || Object.keys(errors).length > 0 ? "" : undefined}
      >
        {mode === "edit" ? (
          <input
            type="hidden"
            name={SAVE_BASELINE_FIELD}
            value={val(values, SAVE_BASELINE_FIELD)}
          />
        ) : null}
        <EventEditableFields values={values} errors={errors} />
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
            Part of a {row.recurrenceFrequency} series. Moving this event moves the not-yet-started
            occurrences by the same amount.
          </p>
        ) : null}
        <div class="actions">
          <button type="submit" class="btn" data-testid="save-event">
            {mode === "new" ? "Create draft" : "Save"}
          </button>
          <a href="/admin/events">Cancel</a>
        </div>
      </form>
      {raw(adminSaveStatus)}
    </>
  );
};
