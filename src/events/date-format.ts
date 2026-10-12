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

/** Bad/absent `month` falls back to this month (UTC). */
export function currentCalendarMonth(now: Date): string {
  return wallMonth(now, "UTC");
}

/** Midnight-UTC instant of a wall day for range checks. */
export function wallDayStart(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}
