// Admin chronology: explicit UTC labels with lossless machine instants.
// The roster "Answered" column and the activity log "When" column share this
// adapter so the Hono pages and their Kit twins label the same instants the
// same way. One unusable timestamp stays visible as "Unrenderable time" (the
// events-inventory placeholder) instead of throwing RangeError and taking
// down the whole table. Labels are derived from toISOString, so they never
// shift with the server's local zone or a DST transition.
const ISO_ZONED = /T.*(?:Z|[+-]\d{2}:?\d{2})$/;

export function formatAdminTime(value: unknown): { iso: string | null; label: string } {
  const unavailable = { iso: null as string | null, label: "Unrenderable time" };
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "string" && ISO_ZONED.test(value)) {
    // Zone-suffixed wire instants only: a naive "2026-10-01T12:34:56" would
    // parse as server-local time and drift across zones.
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) return unavailable;
  let iso: string;
  try {
    iso = date.toISOString();
  } catch {
    return unavailable;
  }
  return { iso, label: `${iso.slice(0, 19).replace("T", " ")} UTC` };
}
