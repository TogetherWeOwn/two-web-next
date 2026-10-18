// Admin event-form fields and validation notice (split from event-form.tsx; zero behavior change).
// The <form> element: title/game/description/schedule/location/capacity fields,
// the create-only recurrence fieldset or the edit-only series note, and the
// save/cancel actions. Field errors render through the shared Field helper.

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import { Field, val } from "./shell";

export const EventFormFields: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  action: string;
}> = ({ mode, row, values, errors, action }) => {
  return (
    <>
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
            <textarea id={id} name="description" rows={4} data-event-text-limit={1000}>
              {val(values, "description")}
            </textarea>
          )}
        </Field>
        <Field name="starts_at" label="Starts (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
          {(id) => (
            <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} required />
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
    </>
  );
};
