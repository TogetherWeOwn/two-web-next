// Shared Hono/Kit UTC labels; invalid instants never take down an admin table.
const ISO_ZONED = /T.*(?:Z|[+-]\d{2}:?\d{2})$/;
const WRITTEN_COMPONENTS =
  /^([+-]?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function writtenCalendarIsValid(value: string): boolean {
  const match = WRITTEN_COMPONENTS.exec(value);
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Refuse calendar overflow and 24:00 rather than accepting Date normalization.
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return (
    day >= 1 &&
    day <= days &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6] ?? 0) < 60
  );
}

export function formatAdminTime(value: unknown): { iso: string | null; label: string } {
  const unavailable = { iso: null as string | null, label: "Unrenderable time" };
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (
    typeof value === "number" ||
    (typeof value === "string" && ISO_ZONED.test(value) && writtenCalendarIsValid(value))
  ) {
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) return unavailable;
  try {
    const iso = date.toISOString();
    const [day, time = ""] = iso.split("T");
    return { iso, label: `${day} ${time.slice(0, 8)} UTC` };
  } catch {
    return unavailable;
  }
}
