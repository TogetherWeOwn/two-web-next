// Admin chronology: explicit UTC labels with lossless machine instants.
// The roster "Answered" column and the activity log "When" column share this
// adapter so the Hono pages and their Kit twins label the same instants the
// same way. One unusable timestamp stays visible as "Unrenderable time" (the
// events-inventory placeholder) instead of throwing RangeError and taking
// down the whole table. Labels are derived from toISOString, so they never
// shift with the server's local zone or a DST transition.
const ISO_ZONED = /T.*(?:Z|[+-]\d{2}:?\d{2})$/;
// The written calendar/clock components of a zoned instant. V8 normalizes
// out-of-range components (Feb 30 becomes Mar 2), so the suffix check above
// is not enough: validate the written components before constructing the Date
// and refuse impossible dates instead of fabricating a different instant.
// Hour 24 is refused on the same basis: it names midnight on the next day,
// so accepting it would render a different date than the one written.
const WRITTEN_COMPONENTS =
  /^([+-]?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function writtenCalendarIsValid(value: string): boolean {
  const match = WRITTEN_COMPONENTS.exec(value);
  // Not a calendar shape at all (odd offset, …): nothing to round-trip,
  // so let Date decide — garbage still parses to NaN below.
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  // Absent at minute precision: Date renders :00, so validate as zero.
  const second = Number(match[6] ?? 0);
  if (!Number.isSafeInteger(year)) return false;
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}

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
    if (!writtenCalendarIsValid(value)) return unavailable;
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) return unavailable;
  let iso: string;
  try {
    iso = date.toISOString();
  } catch {
    return unavailable;
  }
  // Split on "T", not a fixed width: expanded years ("+010000-01-01…")
  // are longer than "YYYY-MM-DD" and slice(0, 19) would eat their seconds.
  const [day, time = ""] = iso.split("T");
  return { iso, label: `${day} ${time.slice(0, 8)} UTC` };
}
