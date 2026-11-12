// Shared escaped editable fields; form actions and recovery stay with each page.
import type { FC } from "hono/jsx";
import { Field, val } from "./shell";
import { EventAccessibilityField, EventHostFields } from "./event-public-fields";

export const EventEditableFields: FC<{
  values: Record<string, unknown>;
  errors: Record<string, string>;
}> = ({ values, errors }) => (
  <>
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
    <EventAccessibilityField values={values} errors={errors} />
    <Field name="starts_at" label="Starts (local wall time, YYYY-MM-DD HH:mm)" errors={errors}>
      {(id) => (
        <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} required />
      )}
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
    <EventHostFields values={values} errors={errors} />
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
  </>
);
