// Independent acceptance: chosen-zone range formatter. No database, account, or
// external requests. Run: npx vitest run test/event-chosen-timezone-formatter.test.ts
// Test-author owned: the Builder consumes this file without editing it;
// corrections return to the Test Author. The Builder implements
// eventRangeInChosenTimezone(start, end, zone) in assets/event-device-timezone.ts
// (shared with the device-only contract) or in assets/event-chosen-timezone.ts.
// Either location satisfies these tests; the device-only export must keep working.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as deviceModule from "../assets/event-device-timezone";

const WORKTREE = fileURLToPath(new URL("../", import.meta.url));

type RangeFormatter = (start: unknown, end: unknown, zone: unknown) => string;

async function loadDedicated(): Promise<Record<string, unknown> | null> {
  // The dedicated source is optional until the Builder creates it. Bundle it
  // into a scratch file and import the bundle URL: a missing entry fails the
  // build, caught below, so the probe stays absent-tolerant without a static
  // specifier the timeout ledger must resolve or tsc must find.
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "chosen-timezone-dedicated-",
    ),
  );
  try {
    const outfile = join(scratch, "dedicated.mjs");
    await build({
      entryPoints: [join(WORKTREE, "assets/event-chosen-timezone.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      outfile,
    });
    return (await import(pathToFileURL(outfile).href)) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let cached: { format: RangeFormatter; unavailable: string } | null = null;
async function requireChosen(): Promise<{ format: RangeFormatter; unavailable: string }> {
  if (cached) return cached;
  const shared = deviceModule as unknown as Record<string, unknown>;
  if (typeof shared.eventRangeInChosenTimezone === "function") {
    const unavailable =
      typeof shared.CHOSEN_TIMEZONE_UNAVAILABLE === "string" &&
      shared.CHOSEN_TIMEZONE_UNAVAILABLE.length > 0
        ? (shared.CHOSEN_TIMEZONE_UNAVAILABLE as string)
        : (shared.DEVICE_TIMEZONE_UNAVAILABLE as string);
    cached = { format: shared.eventRangeInChosenTimezone as RangeFormatter, unavailable };
    return cached;
  }
  const dedicated = await loadDedicated();
  if (dedicated && typeof dedicated.eventRangeInChosenTimezone === "function") {
    const unavailable =
      typeof dedicated.CHOSEN_TIMEZONE_UNAVAILABLE === "string" &&
      (dedicated.CHOSEN_TIMEZONE_UNAVAILABLE as string).length > 0
        ? (dedicated.CHOSEN_TIMEZONE_UNAVAILABLE as string)
        : (shared.DEVICE_TIMEZONE_UNAVAILABLE as string);
    cached = { format: dedicated.eventRangeInChosenTimezone as RangeFormatter, unavailable };
    return cached;
  }
  throw new Error(
    "chosen-range formatter not implemented: export eventRangeInChosenTimezone(start, end, zone) " +
      "from assets/event-device-timezone.ts (shared, preferred) or assets/event-chosen-timezone.ts",
  );
}

async function formatRange(start: unknown, end: unknown, zone: unknown): Promise<string> {
  const { format } = await requireChosen();
  const out = format(start, end, zone);
  expect(typeof out, "formatter must return a string, never throw").toBe("string");
  return out as string;
}

function expectUnavailable(out: string, zone: string) {
  expect(out).toMatch(
    /unavailable|unable|could not|couldn't|cannot|can't|not supported|unknown|invalid/i,
  );
  expect(out).toMatch(/host|shown above|calendar/i);
  if (zone) expect(out).not.toContain(zone);
  // Never fabricate a conversion on failure: no wall time or offset leaks through.
  expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  expect(out).not.toMatch(/GMT[+-]\d{2}:\d{2}/);
}

const native = Intl.DateTimeFormat;
afterEach(() => vi.restoreAllMocks());

describe("event chosen timezone range formatter acceptance", () => {
  it("CONTROL: device-only contract still resolves the device zone", async () => {
    // The existing device export is the shared authority; the chosen range must
    // not rewrite it. This passes before and after the chosen slice.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new native(locales, { timeZone: "America/New_York", ...options });
    } as typeof Intl.DateTimeFormat);
    const { eventStartInDeviceTimezone } = deviceModule;
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toContain("15:00 GMT-04:00");
  });

  it("London summer range to New York shows both instants with one offset", async () => {
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expect(out).toContain("America/New_York");
    expect(out).toMatch(/15 July 2026|July 15,? 2026|2026-07-15/);
    expect(out).toMatch(/15:00|3:00\s*pm/i);
    expect(out).toMatch(/17:00|5:00\s*pm/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/);
  });

  it("Tokyo rollover shows the next calendar day for both instants", async () => {
    const out = await formatRange(
      "2026-07-15T23:30:00.000Z",
      "2026-07-16T01:30:00.000Z",
      "Asia/Tokyo",
    );
    expect(out).toContain("Asia/Tokyo");
    expect(out).toMatch(/16 July 2026|July 16,? 2026|2026-07-16/);
    expect(out).toMatch(/08:30|8:30\s*am/i);
    expect(out).toMatch(/10:30|10:30\s*am/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*\+0?9(?::?00)?\b(?![\d:])/);
  });

  it("autumn fold span shows one wall time with two offsets", async () => {
    const out = await formatRange(
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "America/New_York",
    );
    expect(out).toContain("America/New_York");
    // Both instants read 01:30 locally; the offsets must differ.
    expect(out).toMatch(/01:30|1:30\s*am/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/);
    expect(out).toMatch(/(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/);
  });

  it("spring gap-adjacent span skips the missing hour with two offsets", async () => {
    const out = await formatRange(
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "America/New_York",
    );
    expect(out).toContain("America/New_York");
    expect(out).toMatch(/01:30|1:30\s*am/i);
    expect(out).toMatch(/03:30|3:30\s*am/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/);
    expect(out).toMatch(/(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/);
  });

  it("Kathmandu quarter-hour offset survives with rollover", async () => {
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "Asia/Kathmandu",
    );
    expect(out).toMatch(/Asia\/Kat(?:h)?mandu/);
    expect(out).toMatch(/16 July 2026|July 16,? 2026|2026-07-16/);
    expect(out).toMatch(/00:45|12:45\s*am/i);
    expect(out).toMatch(/02:45|2:45\s*am/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*\+0?5:45\b/);
  });

  it("same zone stays explicitly chosen-labelled", async () => {
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "Europe/London",
    );
    expect(out).toContain("Europe/London");
    expect(out).toMatch(/20:00|8:00\s*pm/i);
    expect(out).toMatch(/22:00|10:00\s*pm/i);
    expect(out).toMatch(/(?:UTC|GMT)\s*\+0?1(?::?00)?\b(?![\d:])/);
  });

  it("different chosen dates across midnight show both dates", async () => {
    const out = await formatRange(
      "2026-07-16T02:00:00.000Z",
      "2026-07-16T06:00:00.000Z",
      "America/New_York",
    );
    expect(out).toContain("America/New_York");
    expect(out).toMatch(/15 July 2026|July 15,? 2026|2026-07-15/);
    expect(out).toMatch(/16 July 2026|July 16,? 2026|2026-07-16/);
    expect(out).toMatch(/22:00|10:00\s*pm/i);
    expect(out).toMatch(/02:00|2:00\s*am/i);
  });

  it("ignores the device zone and formats the explicit chosen zone", async () => {
    // Device reads Tokyo; the chosen request names New York. A device-zone leak
    // would render 04:00+09:00 instead of 15:00-04:00.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      const opts = (options ?? {}) as Intl.DateTimeFormatOptions;
      if (!("timeZone" in opts)) return new native(locales, { timeZone: "Asia/Tokyo", ...opts });
      return new native(locales, opts);
    } as typeof Intl.DateTimeFormat);
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expect(out).toContain("America/New_York");
    expect(out).toContain("15:00 GMT-04:00");
    expect(out).not.toContain("Asia/Tokyo");
  });

  it.each(["Not/AZone!!", "Europe/../London", "Mars/Olympus_Mons", "Invalid/Zone", ""])(
    "refuses unusable zone %j without fabricating times",
    async (zone) => {
      const out = await formatRange("2026-07-15T19:00:00.000Z", "2026-07-15T21:00:00.000Z", zone);
      expectUnavailable(out, zone);
    },
  );

  it("refuses an overlong zone without truncating it into a valid prefix", async () => {
    const overlong = `Europe/London${"A".repeat(120)}`;
    expect(overlong.length).toBeGreaterThan(100);
    const out = await formatRange("2026-07-15T19:00:00.000Z", "2026-07-15T21:00:00.000Z", overlong);
    expectUnavailable(out, "Europe/London");
    const pure = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "A".repeat(200),
    );
    expectUnavailable(pure, "");
  });

  it.each([null, undefined, "", 42, {}, true])("refuses malformed zone %j", async (zone) => {
    const out = await formatRange("2026-07-15T19:00:00.000Z", "2026-07-15T21:00:00.000Z", zone);
    expectUnavailable(out, "");
  });

  it.each([
    ["invalid-start", "2026-07-15T21:00:00.000Z"],
    ["2026-07-15T19:00:00.000Z", "invalid-end"],
    ["", "2026-07-15T21:00:00.000Z"],
    ["2026-07-15T19:00:00.000Z", ""],
    [null, "2026-07-15T21:00:00.000Z"],
    ["2026-07-15T19:00:00.000Z", null],
  ])("refuses invalid instant pair %j / %j", async (start, end) => {
    const out = await formatRange(start, end, "America/New_York");
    expectUnavailable(out, "America/New_York");
  });

  it("fails closed when the constructor throws", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new RangeError("Intl unavailable");
    });
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expectUnavailable(out, "America/New_York");
  });

  it("fails closed when format throws", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      const formatter = new native(locales, options);
      Object.defineProperty(formatter, "format", {
        value: () => {
          throw new Error("format unavailable");
        },
      });
      formatter.formatToParts = () => {
        throw new Error("parts unavailable");
      };
      return formatter;
    } as typeof Intl.DateTimeFormat);
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expectUnavailable(out, "America/New_York");
  });

  it("fails closed when formatToParts is unsupported", async () => {
    vi.spyOn(native.prototype, "formatToParts").mockImplementation(() => {
      throw new TypeError("unsupported");
    });
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expectUnavailable(out, "America/New_York");
  });

  it("fails closed when longOffset is silently ignored", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new native(locales, {
        ...options,
        timeZone: "America/New_York",
        timeZoneName: "short",
      });
    } as typeof Intl.DateTimeFormat);
    const out = await formatRange(
      "2026-07-15T19:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
      "America/New_York",
    );
    expectUnavailable(out, "America/New_York");
  });
});
