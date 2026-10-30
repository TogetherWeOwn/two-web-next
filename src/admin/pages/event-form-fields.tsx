// Admin event-form fields and validation notice (split from event-form.tsx; zero behavior change).
// The <form> element: title/game/description/schedule/location/capacity fields,
// the create-only recurrence fieldset or the edit-only series note, and the
// save/cancel actions. Field errors render through the shared Field helper.

import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { adminSaveStatus } from "../save-status";
import type { EventRow } from "../store";
import { Field, val } from "./shell";
import { ValidationSummary } from "./validation-summary";

export const EventFormFields: FC<{
  mode: "new" | "edit";
  row?: EventRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  action: string;
}> = ({ mode, row, values, errors, action }) => {
  return (
    <>
      <ValidationSummary errors={errors} kind="event" mode={mode} />
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
        <Field
          name="accessibility_notes"
          label="Accessibility notes"
          errors={errors}
          hint="Optional; include only confirmed details, not personal contact information."
        >
          {(id) => (
            <textarea id={id} name="accessibility_notes" rows={4} data-event-text-limit={1000}>
              {val(values, "accessibility_notes")}
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
        <Field
          name="organizer_name"
          label="Organizer display name (optional)"
          errors={errors}
          hint="Use a name the organizer has agreed to show publicly. Do not enter contact details."
        >
          {(id) => (
            <input
              id={id}
              name="organizer_name"
              type="text"
              value={val(values, "organizer_name")}
              data-event-text-limit={500}
            />
          )}
        </Field>
        <Field
          name="join_url"
          label="Public joining link (optional)"
          errors={errors}
          hint="HTTPS or HTTP link visible to everyone. Never use attendee-only or private links."
        >
          {(id) => <input id={id} name="join_url" type="url" value={val(values, "join_url")} />}
        </Field>
        <Field
          name="join_instructions"
          label="Public joining instructions (optional)"
          errors={errors}
          hint="Share only verified details that are safe for anyone to see. Do not enter contact details."
        >
          {(id) => (
            <textarea id={id} name="join_instructions" rows={4} data-event-text-limit={5000}>
              {val(values, "join_instructions")}
            </textarea>
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
              hint="Empty = a one-off event. Repeats keep the same wall time in the zone above across clock changes."
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
                  <option
                    value="monthly"
                    selected={val(values, "recurrence_frequency") === "monthly"}
                  >
                    Monthly
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
