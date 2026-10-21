// Acceptance-owned, hand-derived cases. Do not compute expected periods with
// the production parser or shortcut builder: that would hide UTC boundary bugs.
export const periodPaths = [
  "/hotzones",
  "/hotzones/joins",
  "/hotzones/voice",
  "/hotzones/games",
] as const;

export const committedPeriods = [
  { query: "", value: "all" },
  { query: "?season=all", value: "all" },
  { query: "?season=2026", value: "2026" },
  { query: "?season=2026-02", value: "2026-02" },
  { query: "?season=2026-Q2", value: "2026-Q2" },
] as const;

export const utcPeriodBoundaries = [
  { instant: "2026-03-31T23:59:59.999Z", month: "2026-03", quarter: "2026-Q1" },
  { instant: "2026-04-01T00:00:00.000Z", month: "2026-04", quarter: "2026-Q2" },
  { instant: "2026-06-30T23:59:59.999Z", month: "2026-06", quarter: "2026-Q2" },
  { instant: "2026-07-01T00:00:00.000Z", month: "2026-07", quarter: "2026-Q3" },
  { instant: "2026-09-30T23:59:59.999Z", month: "2026-09", quarter: "2026-Q3" },
  { instant: "2026-10-01T00:00:00.000Z", month: "2026-10", quarter: "2026-Q4" },
  { instant: "2026-12-31T23:59:59.999Z", month: "2026-12", quarter: "2026-Q4" },
  { instant: "2027-01-01T00:00:00.000Z", month: "2027-01", quarter: "2027-Q1" },
  { instant: "2028-02-29T23:59:59.999Z", month: "2028-02", quarter: "2028-Q1" },
] as const;

export const refusedPeriods = ["", "last-season", "2026-13", "2026-Q5", "2026/09"] as const;
export const periodNow = new Date("2026-04-01T00:00:00.000Z");
