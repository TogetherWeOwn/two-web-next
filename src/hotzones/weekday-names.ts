// Weekday names for the 7x24 hot-zone grids.
//
// Client-safe: this module has no server imports (no drizzle, no db, no jobs).
// Kit page components (+page.svelte) must import WEEKDAY_NAMES from here, never
// from ./aggregates: importing the aggregate module bundles drizzle-orm into the
// Kit client output and breaches the Kit client budget in ci/budgets/kit/ (see the /join route's
// +page.svelte note about never importing server screens into Kit pages).
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
