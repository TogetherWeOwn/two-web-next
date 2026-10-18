// Wall-time validators (W11). Pure move out of `./validation`, ports the
// legacy Filament form rules as pure functions so they are unit-testable
// without a database. `./validation` re-exports every public name below, so
// all existing importers keep working untouched; `parseWall`/`wallString`
// stay leaf-internal (exported only for the event-form sibling leaf).
//
// Design notes carried over from legacy:
// - The form speaks LOCAL WALL TIME + IANA zone; storage is a UTC instant.
//   "20:00 Europe/London" is 19:00Z in July and 20:00Z in December —
//   resolving without the zone gets one of the two wrong every year.
// - A wall time inside a spring-forward gap never occurred: refused loudly
//   (TOG-6803). A wall time carrying its own zone/offset would silently win
//   over the explicit zone: refused by shape, the parser only accepts naive
//   input (TOG-6804).
// - An autumn-overlap (fold) wall time names two instants. A fresh parse
//   takes the second occurrence (legacy/Carbon parity, TOG-11669); an
//   unchanged edit keeps the exact stored instant via the hidden *_utc
//   carrier (TOG-6805, see routes).

import { ValidationError } from "./validation-shared";

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

// Intl construction dominates repeated wall-time validation. Bound shared
// formatter reuse so request-supplied zones cannot grow isolate memory forever.
const FORMATTER_CACHE_LIMIT = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  const cached = formatters.get(key);
  if (cached) return cached;
  const value = new Intl.DateTimeFormat(locale, options);
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, value);
  return value;
}

/** Whether the string names an IANA zone the runtime knows. */
export function isKnownTimezone(tz: string): boolean {
  try {
    formatter("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type WallParts = { y: number; mo: number; d: number; h: number; mi: number };

export function parseWall(raw: string): WallParts | null {
  const m = WALL_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59) return null;
  // Reject impossible calendar dates (e.g. Feb 30) rather than rolling over.
  const probe = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));
  if (probe.getUTCMonth() !== mo! - 1 || probe.getUTCDate() !== d!) return null;
  return { y: y!, mo: mo!, d: d!, h: h!, mi: mi! };
}

const dtf = (tz: string) =>
  formatter("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function wallOfInstant(instantMs: number, formatter: Intl.DateTimeFormat): string {
  const parts: Record<string, string> = {};
  for (const p of formatter.formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // en-GB can emit hour "24" for midnight; normalise to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour!;
  return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function wallString(p: WallParts): string {
  return `${String(p.y).padStart(4, "0")}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * Which instant a fold-ambiguous wall time resolves to. Single events take
 * the second (later) occurrence, matching legacy/Carbon; series take the
 * earlier one to keep the seed's offset like legacy `addWeeks` (TOG-11669).
 */
export type FoldPreference = "earlier" | "later";

/**
 * Resolve a naive local wall time in an IANA zone to the UTC instant it names.
 * Throws on unparseable input, unknown zones, and gap times that never
 * occurred. Fold-ambiguous times resolve to the second occurrence by default
 * (legacy/Carbon single-event parity, TOG-11669).
 */
export function wallToUtc(raw: string, timezone: string, fold: FoldPreference = "later"): Date {
  const parts = parseWall(raw);
  if (!parts)
    throw new ValidationError({ wall: `Not a date and time (want YYYY-MM-DD HH:mm): ${raw}` });
  if (!isKnownTimezone(timezone))
    throw new ValidationError({ timezone: `Unknown timezone: ${timezone}` });

  // Sample offsets on both sides of a nearby transition. Keep only
  // candidates that round-trip, then choose by fold preference: a fold wall
  // time names two instants. Single events default to the latest instant —
  // legacy/Carbon resolves to the second (post-transition) occurrence
  // (TOG-11669) — while series ask for the earliest to keep the seed's
  // offset the way legacy `addWeeks` does.
  // This also handles half-hour DST without assuming a one-hour change.
  const naiveMs = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi);
  // Reuse one real formatter for all samples and round-trips in this parse.
  const formatter = dtf(timezone);
  const candidates = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const sample = naiveMs + delta * 3600_000;
    const rendered = parseWall(wallOfInstant(sample, formatter));
    if (!rendered) continue;
    const renderedAsUtc = Date.UTC(
      rendered.y,
      rendered.mo - 1,
      rendered.d,
      rendered.h,
      rendered.mi,
    );
    const candidate = naiveMs - (renderedAsUtc - sample);
    if (wallOfInstant(candidate, formatter) === wallString(parts)) candidates.add(candidate);
  }

  // Gap check (TOG-6803): a time that never occurred has no candidate.
  if (candidates.size === 0) {
    throw new ValidationError({
      wall: `That time never occurred in ${timezone} — clocks skipped forward over it. Pick a time outside the gap.`,
    });
  }
  const instants = [...candidates];
  return new Date(fold === "later" ? Math.max(...instants) : Math.min(...instants));
}

/** Render a stored UTC instant as wall text in the row's zone (edit form fill). */
export function utcToWall(instant: Date, timezone: string): string {
  return wallOfInstant(instant.getTime(), dtf(timezone));
}
