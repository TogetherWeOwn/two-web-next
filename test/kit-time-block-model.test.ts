import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { structuredTime as StructuredTime } from "../web/src/lib/structured-time";

let structuredTime: typeof StructuredTime;

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-time-block-model-"));
  try {
    const outfile = join(scratch, "model.mjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("../web/src/lib/structured-time.ts", import.meta.url).href),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      tsconfigRaw: {},
    });
    ({ structuredTime } = await import(pathToFileURL(outfile).href));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("structured time block model", () => {
  it("shows the viewer's date and time with an unambiguous UTC anchor", () => {
    expect(structuredTime("2026-11-07T19:30:00Z", "Asia/Tokyo")).toEqual({
      datetime: "2026-11-07T19:30:00.000Z",
      zone: "Asia/Tokyo",
      localTime: "04:30",
      utcTime: "19:30",
      localDate: "Sunday 8 November",
    });
  });

  it("names the UTC fallback honestly and rejects invalid or implicit instants", () => {
    expect(structuredTime("2026-11-07T19:30:00Z", "Not/AZone")).toMatchObject({
      zone: "UTC",
      localTime: "19:30",
      utcTime: "19:30",
    });
    for (const value of [null, "2026-11-07T19:30:00", "2026-02-30T19:30:00Z"]) {
      expect(structuredTime(value, "Europe/London")).toBeNull();
    }
  });

  it("uses the zone's offset at each instant across daylight-saving transitions", () => {
    expect(structuredTime("2026-03-29T00:30:00Z", "Europe/London")?.localTime).toBe("00:30");
    expect(structuredTime("2026-03-29T01:30:00Z", "Europe/London")?.localTime).toBe("02:30");
  });
});
