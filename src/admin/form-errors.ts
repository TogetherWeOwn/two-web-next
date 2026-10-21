// Only fields present in this presentation get correction links. Server/global
// errors (including immutable keys and edit-only recurrence errors) stay visible.
const eventFields = {
  title: "Title",
  game: "Game",
  description: "Description",
  accessibility_notes: "Accessibility notes",
  starts_at: "Starts",
  ends_at: "Ends",
  timezone: "Timezone",
  location: "Location",
  capacity: "Capacity",
};
const recurrenceFields = {
  recurrence_frequency: "Repeats",
  recurrence_count: "Occurrences",
  recurrence_ends_on: "Repeat until",
};
const featuredFields = {
  title: "Headline",
  body: "Body",
  url: "Link",
  image_url: "Image URL",
  image_alt: "Image description",
  position: "Position",
  starts_at: "Show from",
  ends_at: "Show until",
};

function summarizeFields(errors: Record<string, string>, fields: Record<string, string>) {
  return Object.entries(errors).map(([key, message]) => ({
    key,
    message,
    label: Object.hasOwn(fields, key) ? fields[key] : null,
    target: Object.hasOwn(fields, key) ? `f-${key.replace(/[^a-z0-9]+/gi, "-")}` : null,
  }));
}

// Event-only clients do not need the featured editor's field metadata.
export function eventValidationSummary(errors: Record<string, string>, mode: "new" | "edit") {
  return summarizeFields(
    errors,
    mode === "new" ? { ...eventFields, ...recurrenceFields } : eventFields,
  );
}

export function validationSummary(
  errors: Record<string, string>,
  kind: "event" | "featured",
  mode: "new" | "edit",
) {
  return kind === "featured"
    ? summarizeFields(errors, featuredFields)
    : eventValidationSummary(errors, mode);
}
