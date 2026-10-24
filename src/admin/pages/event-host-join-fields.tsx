// Shared SSR fields for the Hono and Kit edit forms. Rendering these on the
// server keeps identical labels, escaping and error wiring without shipping
// duplicate field templates in Kit's unhydrated structural client node.
import { Field, val } from "./shell";

export function EventNotesField({
  values,
  errors,
}: {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}) {
  return (
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
}

export function EventHostJoinFields({
  values,
  errors,
}: {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}) {
  return (
    <>
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
    </>
  );
}
