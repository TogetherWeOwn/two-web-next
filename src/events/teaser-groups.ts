/**
 * Tonight / This week / Later buckets for the homepage teaser. One shared
 * module so the Hono screen and the Kit home page never drift: both group
 * the same capped rows at render time with the same wall-calendar rule.
 *
 * Buckets are event-timezone calendar-day differences from `now`: tonight is
 * the same wall day (a past-start row clamps here, never drops), this-week
 * is 1-7 wall days ahead, later is 8+. "This week" is a 7-day window, not a
 * locale calendar week. Invalid zones read as UTC, like every wall reader.
 *
 * Pure and framework-free: the only row reads are the start instant and its
 * zone, and rows pass through by reference, so grouping adds no queries.
 */
import { wallDateIso, wallDayStart } from "./date-format";

export type TeaserGroupKey = "tonight" | "this-week" | "later";

export interface TeaserRowInput {
  startsAt: Date;
  timezone: string;
}

export interface TeaserGroup<Row extends TeaserRowInput> {
  key: TeaserGroupKey;
  label: string;
  events: Row[];
}

const GROUP_ORDER: { key: TeaserGroupKey; label: string }[] = [
  { key: "tonight", label: "Tonight" },
  { key: "this-week", label: "This week" },
  { key: "later", label: "Later" },
];

const MS_PER_DAY = 86_400_000;

/** Whole wall days since the epoch for `instant` in `zone` (UTC fallback). */
function wallDayNumber(instant: Date, zone: string): number {
  return wallDayStart(wallDateIso(instant, zone)) / MS_PER_DAY;
}

function bucketFor(dayDiff: number): TeaserGroupKey {
  if (dayDiff <= 0) return "tonight";
  if (dayDiff <= 7) return "this-week";
  return "later";
}

/**
 * Group teaser rows into tonight / this-week / later, in that order, omitting
 * empty groups. Input order is preserved inside each bucket; `now` is the
 * render instant both renderers freeze in tests and read live in production.
 */
export function groupTeaserEvents<Row extends TeaserRowInput>(
  rows: readonly Row[],
  now: Date,
): TeaserGroup<Row>[] {
  const buckets: Record<TeaserGroupKey, Row[]> = {
    tonight: [],
    "this-week": [],
    later: [],
  };
  for (const row of rows) {
    const zone = row.timezone;
    const diff = wallDayNumber(row.startsAt, zone) - wallDayNumber(now, zone);
    buckets[bucketFor(diff)].push(row);
  }
  return GROUP_ORDER.filter(({ key }) => buckets[key].length > 0).map(({ key, label }) => ({
    key,
    label,
    events: buckets[key],
  }));
}
