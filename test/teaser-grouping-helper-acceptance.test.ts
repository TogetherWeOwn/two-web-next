// Teaser grouping helper acceptance: direct units for groupTeaserEvents.
//
// Owned by the teaser-grouping acceptance handoff: the paired build works
// from this branch and never edits this file; corrections return to the
// acceptance author. Local only: the helper module is loaded through a
// throwaway esbuild bundle (the same scratch-bundle harness the Kit SSR
// suites use), because the static gates forbid importing a not-yet-existing
// module any other way. Until the builder adds
// `src/events/teaser-groups.ts` the bundle fails to resolve and every test
// below is RED for that reason; after it lands, these pin the buckets
// both renderers share.
//
// Buckets are event-timezone calendar-day differences from `now`: tonight
// is the same wall day (a past-start row clamps here, never drops),
// this-week is 1-7 wall days ahead, later is 8+. Invalid zones read as
// UTC. "This week" is a 7-day window, not a locale calendar week.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_PATH = join(root, "src/events/teaser-groups.ts");
const NOW = new Date("2030-07-04T18:00:00Z");

type TeaserGroupKey = "tonight" | "this-week" | "later";

interface TeaserInputRow {
  startsAt: Date;
  timezone: string;
  title: string;
}

interface TeaserGroup {
  key: TeaserGroupKey;
  label: string;
  events: TeaserInputRow[];
}

type GroupTeaserEvents = (rows: TeaserInputRow[], now: Date) => TeaserGroup[];

let scratch = "";
let grouper: GroupTeaserEvents | null = null;
let loadError: unknown = null;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "teaser-grouping-helper-"));
  const entry = join(scratch, "teaser-grouping-helper-entry.mjs");
  writeFileSync(entry, `export { groupTeaserEvents } from ${JSON.stringify(HELPER_PATH)};\n`);
  const outfile = join(scratch, "teaser-grouping-helper-bundle.mjs");
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "node_modules")],
    });
    const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
      groupTeaserEvents?: unknown;
    };
    if (typeof mod.groupTeaserEvents === "function") {
      grouper = mod.groupTeaserEvents as GroupTeaserEvents;
    } else {
      loadError = new Error(
        "src/events/teaser-groups.ts must export a groupTeaserEvents(rows, now) function",
      );
    }
  } catch (err) {
    loadError = err;
  }
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function group(): GroupTeaserEvents {
  expect(
    loadError,
    "shared helper src/events/teaser-groups.ts is missing: the builder has not landed it yet",
  ).toBeNull();
  expect(
    typeof grouper,
    "src/events/teaser-groups.ts must export a groupTeaserEvents(rows, now) function",
  ).toBe("function");
  return grouper as GroupTeaserEvents;
}

function inputRow(startsAt: string, timezone: string, title: string): TeaserInputRow {
  return { startsAt: new Date(startsAt), timezone, title };
}

function bucketOf(groups: TeaserGroup[], title: string): TeaserGroupKey {
  const hit = groups.find((g) => g.events.some((row) => row.title === title));
  if (!hit) throw new Error(`no bucket for ${title}`);
  return hit.key;
}

function bucketOfStart(groups: TeaserGroup[], startsAt: Date): TeaserGroupKey {
  const hit = groups.find((g) =>
    g.events.some((row) => row.startsAt.getTime() === startsAt.getTime()),
  );
  if (!hit) throw new Error(`no bucket for ${startsAt.toISOString()}`);
  return hit.key;
}

/** Sealed rows prove the helper buckets from startsAt/timezone alone. */
function sealedRow(startsAt: Date, timezone: string, title: string): TeaserInputRow {
  const target: TeaserInputRow = { startsAt, timezone, title };
  return new Proxy(target, {
    get(t, p, r) {
      if (p === "startsAt" || p === "timezone" || typeof p === "symbol") {
        return Reflect.get(t, p, r);
      }
      throw new Error(
        `groupTeaserEvents must bucket from startsAt/timezone only (read ${String(p)}); pass rows through by reference`,
      );
    },
  });
}

function zoneOffsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const wall = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((wall - at.getTime()) / 60000);
}

describe("teaser grouping helper acceptance", () => {
  it("buckets tonight, this-week and later with stable keys, labels and order", () => {
    const groups = group()(
      [
        inputRow("2030-07-04T19:00:00Z", "Europe/London", "tonight"),
        inputRow("2030-07-05T10:00:00Z", "Europe/London", "week"),
        inputRow("2030-07-13T10:00:00Z", "Europe/London", "later"),
      ],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["tonight", "this-week", "later"]);
    expect(groups.map((g) => g.label)).toEqual(["Tonight", "This week", "Later"]);
    expect(bucketOf(groups, "tonight")).toBe("tonight");
    expect(bucketOf(groups, "week")).toBe("this-week");
    expect(bucketOf(groups, "later")).toBe("later");
    expect(groups.flatMap((g) => g.events)).toHaveLength(3);
  });

  it("returns no groups for no rows and a lone group when one bucket fills", () => {
    const groups = group()([inputRow("2030-07-13T10:00:00Z", "UTC", "later")], NOW);
    expect(group()([], NOW)).toEqual([]);
    expect(groups.map((g) => g.key)).toEqual(["later"]);
    expect(groups[0]?.events.map((row) => row.title)).toEqual(["later"]);
  });

  it("puts an exact-midnight start on the next day, never tonight", () => {
    const groups = group()(
      [
        inputRow("2030-07-04T23:59:00Z", "UTC", "late"),
        inputRow("2030-07-05T00:00:00Z", "UTC", "midnight"),
      ],
      new Date("2030-07-04T23:30:00Z"),
    );
    expect(bucketOf(groups, "late")).toBe("tonight");
    expect(bucketOf(groups, "midnight")).toBe("this-week");
  });

  it("buckets the same instant per event zone: UTC tomorrow, Auckland tonight", () => {
    const groups = group()(
      [
        inputRow("2030-06-02T00:30:00Z", "UTC", "utc"),
        inputRow("2030-06-02T00:30:00Z", "Pacific/Auckland", "auckland"),
      ],
      new Date("2030-06-01T23:30:00Z"),
    );
    expect(bucketOf(groups, "utc")).toBe("this-week");
    expect(bucketOf(groups, "auckland")).toBe("tonight");
  });

  it("keeps day 7 in This week and moves day 8 to Later", () => {
    const groups = group()(
      [
        inputRow("2030-07-11T18:00:00Z", "UTC", "day-7"),
        inputRow("2030-07-12T18:00:00Z", "UTC", "day-8"),
      ],
      NOW,
    );
    expect(bucketOf(groups, "day-7")).toBe("this-week");
    expect(bucketOf(groups, "day-8")).toBe("later");
  });

  it("follows the wall calendar across DST transitions, not hour counts", () => {
    // Spring forward (US Eastern 2030-03-10): 23 hours apart, adjacent days.
    const springNow = new Date("2030-03-09T17:00:00Z");
    const springRow = new Date("2030-03-10T16:00:00Z");
    expect(zoneOffsetMinutes(springNow, "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(springRow, "America/New_York")).toBe(-240);
    expect(springRow.getTime() - springNow.getTime()).toBe(23 * 3600_000);
    const spring = group()(
      [inputRow("2030-03-10T16:00:00Z", "America/New_York", "spring")],
      springNow,
    );
    expect(bucketOf(spring, "spring")).toBe("this-week");
    // Fall back (US Eastern 2030-11-03): 24 hours apart, the same wall day.
    const fallNow = new Date("2030-11-03T04:30:00Z");
    const fallRow = new Date("2030-11-04T04:30:00Z");
    expect(zoneOffsetMinutes(fallNow, "America/New_York")).toBe(-240);
    expect(zoneOffsetMinutes(fallRow, "America/New_York")).toBe(-300);
    expect(fallRow.getTime() - fallNow.getTime()).toBe(24 * 3600_000);
    const fall = group()([inputRow("2030-11-04T04:30:00Z", "America/New_York", "fall")], fallNow);
    expect(bucketOf(fall, "fall")).toBe("tonight");
  });

  it("reads invalid zones as UTC", () => {
    const groups = group()(
      [
        inputRow("2030-07-04T19:00:00Z", "Invalid/Zone", "tonight"),
        inputRow("2030-07-05T10:00:00Z", "Invalid/Zone", "week"),
      ],
      NOW,
    );
    expect(bucketOf(groups, "tonight")).toBe("tonight");
    expect(bucketOf(groups, "week")).toBe("this-week");
  });

  it("clamps a past-start row to tonight instead of dropping it", () => {
    const groups = group()([inputRow("2030-07-03T20:00:00Z", "UTC", "in-progress")], NOW);
    expect(groups.map((g) => g.key)).toEqual(["tonight"]);
    expect(bucketOf(groups, "in-progress")).toBe("tonight");
  });

  it("buckets from startsAt and timezone alone, never another row field", () => {
    const late = new Date("2030-07-04T19:00:00Z");
    const week = new Date("2030-07-05T10:00:00Z");
    const later = new Date("2030-07-13T10:00:00Z");
    const groups = group()(
      [
        sealedRow(late, "Europe/London", "tonight"),
        sealedRow(week, "Europe/London", "week"),
        sealedRow(later, "Europe/London", "later"),
      ],
      NOW,
    );
    expect(bucketOfStart(groups, late)).toBe("tonight");
    expect(bucketOfStart(groups, week)).toBe("this-week");
    expect(bucketOfStart(groups, later)).toBe("later");
  });

  it("preserves input order inside a bucket instead of re-sorting", () => {
    const groups = group()(
      [
        inputRow("2030-07-04T20:00:00Z", "UTC", "second"),
        inputRow("2030-07-04T19:00:00Z", "UTC", "first"),
      ],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["tonight"]);
    expect(groups[0]?.events.map((row) => row.title)).toEqual(["second", "first"]);
  });
});
