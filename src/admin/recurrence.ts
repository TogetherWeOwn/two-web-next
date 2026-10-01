// Recurring series (W13). Ports two-web app/Support/RecurrenceSchedule.php and
// RecurrenceInput.php (legacy main, TOG-8399) as pure functions.
//
// A series is ordinary event rows: the parent holds the rule and is index 1;
// every occurrence is a row. `occurrences` answers "which indexes exist and
// when"; materialisation tops up whatever is missing and never touches an
// existing row, so cancelling one instance to skip a week is never undone.
//
// Weeks step in the host's zone, not in UTC: "20:00 London every Sunday" must
// stay 20:00 London across the clocks-change weekend.

import { type FieldErrors, isKnownTimezone, utcToWall, ValidationError, wallToUtc } from "./validation";

/** A series that never ends is a runaway reconcile pass: 52 weeklies is a year of Sunday Squads. */
export const MAX_OCCURRENCES = 52;

export const RECURRENCE_FREQUENCIES = ["weekly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export type RecurrenceInput = {
  frequency: RecurrenceFrequency;
  count: number | null;
  /** Calendar date, stored as UTC midnight of that date. */
  endsOn: Date | null;
};

export type Occurrence = { startsAt: Date; endsAt: Date };

const WALL_PARTS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

function addDaysToWall(wall: string, days: number): string {
  const m = WALL_PARTS.exec(wall)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days, Number(m[4]), Number(m[5])));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Wall time to instant the way PHP/Carbon does it: a fold time takes the first
 * occurrence, and a wall time inside a spring-forward gap moves forward by the
 * length of the gap (02:30 becomes 03:30) instead of failing, because a
 * recurring slot must not vanish for one week a year.
 */
function resolveWall(wall: string, timezone: string): Date {
  try {
    return wallToUtc(wall, timezone);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
  }
  // Gap: read the offset from the day before (pre-transition) and apply it.
  const probe = wallToUtc(addDaysToWall(wall, -1), timezone);
  const probeWall = utcToWall(probe, timezone);
  const offsetMs = asUtcMs(probeWall) - probe.getTime();
  return new Date(asUtcMs(wall) - offsetMs);
}

function asUtcMs(wall: string): number {
  const m = WALL_PARTS.exec(wall)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * Every occurrence the rule names, parent first, keyed by 1-based index.
 * Both bounds apply and the tighter wins: `count` caps the total including
 * the parent, `endsOn` keeps occurrences whose host-local date is on or before
 * it (compared as Y-m-d, no zone shift).
 */
export function occurrences(
  startsAt: Date,
  endsAt: Date,
  timezone: string,
  frequency: RecurrenceFrequency,
  count: number | null = null,
  endsOn: Date | null = null,
  max: number = MAX_OCCURRENCES,
): Map<number, Occurrence> {
  const limit = Math.min(Math.max(count ?? max, 1), max);
  const localStart = utcToWall(startsAt, timezone);
  const localEnd = utcToWall(endsAt, timezone);
  const endDate = endsOn ? endsOn.toISOString().slice(0, 10) : null;
  const out = new Map<number, Occurrence>();
  for (let index = 1; index <= limit; index++) {
    const step = index - 1;
    const days = frequency === "weekly" ? 7 * step : 0;
    const startWall = addDaysToWall(localStart, days);
    if (endDate !== null && startWall.slice(0, 10) > endDate) break;
    out.set(index, {
      startsAt: index === 1 ? startsAt : resolveWall(startWall, timezone),
      endsAt: index === 1 ? endsAt : resolveWall(addDaysToWall(localEnd, days), timezone),
    });
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

function parseDate(raw: string): Date | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

// Number() rounds before we see it: "3.0000000000000001" reads as exactly 3, so
// the decimal literal itself must name a whole number. Once the exponent shifts
// the point, every digit right of it is zero. Non-decimal Number() forms (0x,
// 0b, 0o, Infinity) are integer literals or already fail Number.isInteger.
const COUNT_DECIMAL = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function isWholeCountLiteral(raw: string): boolean {
  const m = COUNT_DECIMAL.exec(raw);
  if (!m) return true;
  const digits = m[1] + (m[2] ?? "");
  const shift = (m[2]?.length ?? 0) - Number(m[3] ?? "0");
  if (shift <= 0) return true;
  if (shift >= digits.length) return /^0*$/.test(digits);
  return digits.endsWith("0".repeat(shift));
}

/**
 * Read the rule out of the create/edit form, or null for a one-off. Unknown
 * frequencies, out-of-range counts, unparsable dates and a repeat-until that
 * ends before the first meeting are field errors, never a stored half-rule.
 * Messages are the legacy ones, verbatim.
 */
export function parseRecurrenceForm(data: Record<string, unknown>): RecurrenceInput | null {
  const frequency = str(data.recurrence_frequency);
  if (frequency === null) return null;
  const fields: FieldErrors = {};
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(frequency)) {
    throw new ValidationError({ recurrence_frequency: "Unknown repeat frequency." });
  }

  let count: number | null = null;
  const countRaw = str(data.recurrence_count);
  if (countRaw !== null) {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_OCCURRENCES || !isWholeCountLiteral(countRaw)) {
      fields.recurrence_count = `Occurrences must be between 1 and ${MAX_OCCURRENCES}.`;
    } else count = n;
  }

  let endsOn: Date | null = null;
  const endsRaw = str(data.recurrence_ends_on);
  if (endsRaw !== null) {
    endsOn = parseDate(endsRaw);
    if (!endsOn) fields.recurrence_ends_on = "The repeat-until date is not a date.";
  }

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  if (count === null && endsOn === null) {
    throw new ValidationError({ recurrence_count: "Give a number of occurrences or a repeat-until date." });
  }

  // The event rules own bad starts/timezone fields; only compare when they parse.
  const startsRaw = str(data.starts_at);
  const timezone = str(data.timezone) ?? "Europe/London";
  if (endsOn && startsRaw && isKnownTimezone(timezone)) {
    const startsDate = /^\d{4}-\d{2}-\d{2}/.test(startsRaw) && parseDate(startsRaw.slice(0, 10)) ? startsRaw.slice(0, 10) : null;
    if (startsDate && endsOn.toISOString().slice(0, 10) < startsDate) {
      throw new ValidationError({ recurrence_ends_on: "The repeat-until date is before the first meeting." });
    }
  }
  return { frequency: frequency as RecurrenceFrequency, count, endsOn };
}
