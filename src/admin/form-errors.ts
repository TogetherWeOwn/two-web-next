// Only fields present in this presentation get correction links. Server/global
// errors (including immutable keys and edit-only recurrence errors) stay visible.
const eventFields = {
  title: "Title",
  game: "Game",
  description: "Description",
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

export function validationSummary(
  errors: Record<string, string>,
  kind: "event" | "featured",
  mode: "new" | "edit",
) {
  const fields: Record<string, string> =
    kind === "featured"
      ? featuredFields
      : mode === "new"
        ? { ...eventFields, ...recurrenceFields }
        : eventFields;
  return Object.entries(errors).map(([key, message]) => ({
    key,
    message,
    label: Object.hasOwn(fields, key) ? fields[key] : null,
    target: Object.hasOwn(fields, key) ? `f-${key.replace(/[^a-z0-9]+/gi, "-")}` : null,
  }));
}
