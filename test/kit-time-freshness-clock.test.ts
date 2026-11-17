import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type * as Clock from "../web/src/lib/time-freshness-clock";

let snapshotNow: typeof Clock.snapshotNow;
let timeSnapshotIsStale: typeof Clock.timeSnapshotIsStale;
let timeStaleAt: typeof Clock.timeStaleAt;

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-time-freshness-clock-"));
  try {
    const outfile = join(scratch, "clock.mjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("../web/src/lib/time-freshness-clock.ts", import.meta.url).href),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      tsconfigRaw: {},
    });
    ({ snapshotNow, timeSnapshotIsStale, timeStaleAt } = await import(pathToFileURL(outfile).href));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("snapshot freshness", () => {
  it("uses the latest wall, hydration, response and previously observed clocks", () => {
    const clock = {
      asOf: 1_000,
      responseStart: 100,
      hydrationWall: 1_050,
      hydrationMonotonic: 200,
      previousNow: 1_050,
    };
    expect(snapshotNow(clock, 1_060, 300)).toBe(1_200);
    expect(snapshotNow(clock, 2_000, 300)).toBe(2_000);
    expect(snapshotNow({ ...clock, previousNow: 3_000 }, 1_060, 300)).toBe(3_000);
    expect(snapshotNow(clock, 999, 300)).toBeNaN();
    expect(snapshotNow(clock, NaN, 300)).toBeNaN();
    expect(snapshotNow(clock, 1_060, 199)).toBeNaN();
    expect(snapshotNow({ ...clock, responseStart: 201 }, 1_060, 300)).toBeNaN();
    expect(snapshotNow(clock, 1_060, NaN)).toBeNaN();
  });

  const minute = 60_000;
  const asOf = Date.parse("2026-11-06T20:00:00Z");

  it("uses the earlier of the token window and the next state boundary", () => {
    expect(timeStaleAt("upcoming", asOf, asOf + 60 * minute)).toBe(asOf + 5 * minute);
    expect(timeStaleAt("upcoming", asOf, asOf + 17 * minute)).toBe(asOf + 2 * minute);
    expect(timeStaleAt("upcoming", asOf, asOf + 2 * minute)).toBe(asOf + 2 * minute);
    expect(timeStaleAt("live", asOf, asOf - minute, asOf + minute)).toBe(asOf + minute);
    expect(timeStaleAt("live", asOf, asOf - minute)).toBe(asOf + 5 * minute);
  });

  it("handles the exact relative-claim and near-start boundaries", () => {
    expect(timeStaleAt("upcoming", asOf, asOf + 24 * 60 * minute + 1)).toBeNull();
    expect(timeStaleAt("upcoming", asOf, asOf + 24 * 60 * minute)).toBe(asOf + 5 * minute);
    expect(timeStaleAt("upcoming", asOf, asOf + 15 * minute + 1)).toBe(asOf + 1);
    expect(timeStaleAt("upcoming", asOf, asOf + 15 * minute)).toBe(asOf + 5 * minute);
  });

  it("does not schedule withdrawal when no relative claim is rendered", () => {
    expect(timeStaleAt("upcoming", asOf, asOf + 25 * 60 * minute)).toBeNull();
    expect(timeStaleAt("ended", asOf, asOf - minute)).toBeNull();
    expect(timeStaleAt("cancelled", asOf, asOf + minute)).toBeNull();
  });

  it("withdraws inconsistent snapshots and unreadable clocks safely", () => {
    expect(timeStaleAt("upcoming", asOf, asOf)).toBe(asOf);
    expect(timeStaleAt("live", asOf, asOf - minute, asOf)).toBe(asOf);
    expect(timeStaleAt("live", asOf, asOf + minute)).toBe(asOf);
    expect(timeStaleAt("live", asOf, asOf - minute, NaN)).toBe(asOf);
    expect(timeSnapshotIsStale(timeStaleAt("live", NaN, asOf)!, asOf)).toBe(true);
    expect(timeSnapshotIsStale(asOf + minute, NaN)).toBe(true);
    expect(timeSnapshotIsStale(asOf + minute, asOf)).toBe(false);
    expect(timeSnapshotIsStale(asOf + minute, asOf + minute)).toBe(true);
  });
});
