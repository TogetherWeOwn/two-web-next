/** Server-side event date formatting shared by page models and renderers. */
function calendarDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

export function isValidZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function partsIn(
  instant: Date,
  zone: string,
  opts: Intl.DateTimeFormatOptions,
): Map<string, string> {
  const z = isValidZone(zone) ? zone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: z, ...opts }).formatToParts(instant);
  return new Map(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

/** Canonical ISO wall date, including expanded years (invalid zones read as UTC). */
export function wallDateIso(instant: Date, zone: string): string {
  const p = partsIn(instant, zone, {
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const year = Number(p.get("year"));
  const isoYear = p.get("era") === "BC" ? 1 - year : year;
  return calendarDate(isoYear, Number(p.get("month")) - 1, Number(p.get("day")))
    .toISOString()
    .split("T")[0]!;
}

/** "HH:mm" 24-hour wall time in `zone` (invalid zones read as UTC). */
export function wallTimeHm(instant: Date, zone: string): string {
  const p = partsIn(instant, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.get("hour")}:${p.get("minute")}`;
}

/** ISO wall month in `zone`; unsupported years remain rejectable by the parser. */
export function wallMonth(instant: Date, zone: string): string {
  return wallDateIso(instant, zone).slice(0, -3);
}

/** "Fri 4 Nov" — the card's human day in the host zone. */
export function cardDayLabel(instant: Date, zone: string): string {
  const p = partsIn(instant, zone, { weekday: "short", day: "numeric", month: "short" });
  return `${p.get("weekday")} ${p.get("day")} ${p.get("month")}`;
}

/** "Fri 4 Nov, 20:00" — the card's human time in the host zone. */
export function cardTimeLabel(instant: Date, zone: string): string {
  return `${cardDayLabel(instant, zone)}, ${wallTimeHm(instant, zone)}`;
}

/** The modal valid zone among the shown rows, UTC when there are no rows. */
export function calendarZone(timezones: Iterable<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const tz of timezones) {
    if (tz) counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && isValidZone(top[0]) ? top[0] : "UTC";
}

/** Skew guard for the edited-event Updated stamp: fresh inserts stamp
 * createdAt/updatedAt together (millisecond drift), while a real edit lands
 * later. A full minute keeps fresh rows clean. */
export const EVENT_UPDATED_SKEW_MS = 60_000;

/** True when the row was edited after creation: updatedAt strictly beyond
 * createdAt plus the skew guard. Fresh rows, within-skew edits, backwards
 * rows, and missing or unparseable instants all read as unedited, never as
 * a throw: both renderers call this on every detail render, so a partial
 * row must hide the stamp rather than break the page. Both detail renderers
 * share this predicate, so the stamp never disagrees between them. */
export function isEditedEvent(
  createdAt: Date | null | undefined,
  updatedAt: Date | null | undefined,
): boolean {
  if (!(createdAt instanceof Date) || !(updatedAt instanceof Date)) return false;
  return updatedAt.getTime() - createdAt.getTime() > EVENT_UPDATED_SKEW_MS;
}

/** "Thursday, 20 November 2029, 15:30 GMT+00:00" — the shared Updated-stamp
 * human date in the event zone (the served long-offset detail format, ISO on
 * a bad zone). Both renderers call this one function, so the stamp's visible
 * text is identical on Hono and Kit for the same row. */
export function updatedStampLabel(updatedAt: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
      timeZoneName: "longOffset",
    }).format(updatedAt);
  } catch {
    return updatedAt.toISOString();
  }
}

/** Bad/absent `month` falls back to this month (UTC). */
export function currentCalendarMonth(now: Date): string {
  return wallMonth(now, "UTC");
}

/** Midnight-UTC instant of a wall day for range checks. */
export function wallDayStart(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/** Numeric day key for an ISO wall day ("YYYY-MM-DD", plus the expanded grid
 * years past 9999), so clipping compares calendar days without Date parsing.
 * Null when the shape is unusable. */
function dayKey(iso: string): number | null {
  const m = /^([+-]?)(\d{4,6})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const key = Number(m[2]) * 10000 + Number(m[3]) * 100 + Number(m[4]);
  return m[1] === "-" ? -key : key;
}

/**
 * Host-zone wall days of the canonical interval [startsAt, endsAt) clipped to
 * the displayed grid. The end is exclusive: an exact-midnight ending does not
 * add the next day. Invalid zones read as UTC, like every wall reader here.
 *
 * Clip-then-iterate: the endpoints narrow to the grid before any day is
 * stepped, so a millennia-long interval costs grid days, not millennia. Day
 * membership comes from Intl wall dates at the endpoints (monotonic in time,
 * so every day between is touched); the stepping walks UTC midnights only to
 * enumerate ISO labels, never to decide membership — DST never shifts a day.
 * A degenerate window keeps start-day plotting instead of vanishing.
 */
export function canonicalIntervalDays(
  startsAt: Date,
  endsAt: Date,
  zone: string,
  gridFirst: string,
  gridLast: string,
): string[] {
  const first = wallDateIso(startsAt, zone);
  const gridLo = dayKey(gridFirst);
  const gridHi = dayKey(gridLast);
  if (gridLo === null || gridHi === null) return [];
  if (!(endsAt.getTime() > startsAt.getTime())) {
    const key = dayKey(first);
    return key !== null && key >= gridLo && key <= gridHi ? [first] : [];
  }
  const last = wallDateIso(new Date(endsAt.getTime() - 1), zone);
  const firstKey = dayKey(first) ?? gridLo;
  const lastKey = dayKey(last) ?? gridHi;
  const lo = firstKey >= gridLo ? first : gridFirst;
  const hi = lastKey <= gridHi ? last : gridLast;
  if (dayKey(lo)! > dayKey(hi)!) return [];
  const start = wallDayStart(lo);
  const end = wallDayStart(hi);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  // Grid geometry caps the walk: whole weeks, at most 6 rows of 7.
  const days: string[] = [];
  for (let t = start; t <= end && days.length < 42; t += 86_400_000) {
    days.push(wallDateIso(new Date(t), "UTC"));
  }
  return days;
}

/** "Monday, 15 February 2027" — the long day line for continuation names. The
 * ISO wall day formats as its own UTC date, so the weekday belongs to the
 * displayed day in every zone. Falls back to the raw day, never throws. */
export function calendarDayLongLabel(dayIso: string): string {
  const t = wallDayStart(dayIso);
  if (!Number.isFinite(t)) return dayIso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(t));
}
