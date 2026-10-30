// Weekday reader contract shared by the Hono and Kit hot-zone signal pages.
//
// Pure and client-safe (no server imports, same rule as ./weekday-names): one
// allowlisted `day` token selects a single row of the existing 7x24 grid. The
// projection reads the cells already aggregated, so it adds no query and never
// changes a total. Anything but exactly one known token means the full week,
// so a malformed or repeated selector is never an error and never a data probe.
import type { HeatGrid } from "./aggregates";

// Order matches the grid's weekday indexing (0 = Sunday, UTC).
export const DAY_TOKENS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayToken = (typeof DAY_TOKENS)[number];

export function parseDayParam(values: readonly string[]): DayToken | null {
  const [value] = values;
  return values.length === 1 && DAY_TOKENS.includes(value as DayToken) ? (value as DayToken) : null;
}

/** The selected weekday's 24 source cells in ascending hour order, zeros kept. */
export function projectDay(cells: HeatGrid, day: DayToken): number[] {
  return [...cells[DAY_TOKENS.indexOf(day)]!];
}

/**
 * Query string for a hot-zone link: the committed season (absent for all, the
 * canonical bare form) followed by the chosen weekday (absent for the full week).
 */
export function hotzoneQuery(season: string, day: DayToken | null): string {
  const parts = [season === "all" ? "" : `season=${season}`, day ? `day=${day}` : ""].filter(
    Boolean,
  );
  return parts.length ? `?${parts.join("&")}` : "";
}
