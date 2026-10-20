// Hot-zone `?season=` grammar.
//
// Pure date-window function, no seasons table in v1, shared with the sibling
// leaderboards slice: absent/all = unbounded; YYYY; YYYY-MM; YYYY-QN (N 1-4);
// anything else is invalid and must answer 400 before any aggregation.
//
// All windows are UTC, start-inclusive / end-exclusive.
export type SeasonWindow =
  | { kind: "all"; label: string }
  | { kind: "window"; start: Date; end: Date; label: string };

const YEAR_RE = /^(\d{4})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

// Parse the raw `?season=` query value. `null`/`undefined` = absent = `all`.
// Returns `null` when the value is present but invalid (caller answers 400,
// never a silent fallback window). Empty string is invalid, not absent.
export function parseSeasonParam(raw: string | null | undefined): SeasonWindow | null {
  if (raw === null || raw === undefined) return { kind: "all", label: "all" };
  if (raw === "all") return { kind: "all", label: "all" };
  let m = YEAR_RE.exec(raw);
  if (m) {
    const year = Number(m[1]);
    return {
      kind: "window",
      start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)),
      label: raw,
    };
  }
  m = MONTH_RE.exec(raw);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    return {
      kind: "window",
      start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
      end: new Date(
        Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 0, 0, 0, 0),
      ),
      label: raw,
    };
  }
  m = QUARTER_RE.exec(raw);
  if (m) {
    const year = Number(m[1]);
    const quarter = Number(m[2]);
    const startMonth = (quarter - 1) * 3;
    return {
      kind: "window",
      start: new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0)),
      label: raw,
    };
  }
  return null;
}

/** Season label for logging: absent maps to `all`, otherwise the raw value. */
export function seasonLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "all";
  return raw;
}

/** Current UTC month/quarter season values for the period-picker shortcuts.
///
/// Pure UTC getters only, never viewer-local dates. `now` is the injectable
/// request clock: callers use the default (the request-time clock) and tests
/// inject a fixed instant for deterministic quarter/year boundaries. */
export function utcPeriodShortcuts(now: Date = new Date()): {
  month: string;
  quarter: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const quarter = Math.floor((month - 1) / 3) + 1;
  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    quarter: `${year}-Q${quarter}`,
  };
}

/** True when `d` lies inside the window (all = unbounded). */
export function inSeasonWindow(d: Date, window: SeasonWindow): boolean {
  if (window.kind === "all") return true;
  const t = d.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}
