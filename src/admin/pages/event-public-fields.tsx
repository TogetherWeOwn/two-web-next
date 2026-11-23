// Shared escaped fields for Hono and the server-only Kit editor. Keep one
// renderer for these optional values so the two stacks cannot omit them.
import type { FC } from "hono/jsx";
import { eventTextHasLineBreak, textareaInitialText } from "../event-text";
import { Field, val } from "./shell";

type Props = { values: Record<string, unknown>; errors: Record<string, string> };

// Return a native element so Field can attach its hint and error attributes.
export function eventTextControl(
  id: string,
  name: string,
  value: string,
  limit: number,
  required?: boolean,
) {
  const props = { id, name, "data-event-text-limit": limit, required };
  return eventTextHasLineBreak(value) ? (
    <textarea {...props} rows={2}>
      {textareaInitialText(value)}
    </textarea>
  ) : (
    <input {...props} type="text" value={value} />
  );
}

export const EventAccessibilityField: FC<Props> = ({ values, errors }) => (
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
);

export const EventHostFields: FC<Props> = ({ values, errors }) => (
  <>
    <Field
      name="organizer_name"
      label="Organizer display name (optional)"
      errors={errors}
      hint="Use a name the organizer has agreed to show publicly. Do not enter contact details."
    >
      {(id) => eventTextControl(id, "organizer_name", val(values, "organizer_name"), 500)}
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
  </>
);

export function renderEventPublicFieldsHtml(values: Record<string, unknown>) {
  return {
    accessibilityFieldHtml: String(<EventAccessibilityField values={values} errors={{}} />),
    hostFieldsHtml: String(<EventHostFields values={values} errors={{}} />),
  };
}
