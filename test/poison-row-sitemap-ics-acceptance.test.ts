// Acceptance: one poison row must never empty the sitemap or 503 the ICS.
//
// Contract pinned here (return types stay exactly as today):
// - `sitemapEvents(db)` still resolves to the same
//   `{ key, status: "published", updatedAt }[]` array for valid rows, but a
//   row whose window or `updatedAt` is not a finite JS Date is skipped
//   instead of throwing inside the map. A database failure still rejects.
// - `eventsIcsCollection(rows, appUrl)` still returns the calendar string,
//   but a row whose stored revision is outside the RFC 5545 SEQUENCE range
//   is skipped per row instead of throwing for the whole collection. Only
//   that sequence-range failure is skippable; any other builder error
//   still throws.
// - Every skip is counted in a log line: at least one console call (any
//   level) must carry the exact skipped-row count, either as a numeric
//   field whose name mentions "skip" (e.g. `{ skipped: 2 }`) or as a
//   number adjacent to skip wording in the message. No skip log may fire
//   when nothing was skipped.
// - All-valid inputs stay byte-identical, boundary SEQUENCE values are
//   not skipped, and the RSS builder is untouched (it never reads the
//   stored revision, so a sequence-poison row renders there unchanged).
//
// Hermetic only: pure builders plus a chainable fake Db for the sitemap
// read. The fake ignores query clauses, so the guard must live in JS
// (SQL cannot see a PostgreSQL timestamp that is finite there but
// outside the JS Date range anyway).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { eventsIcsCollection, eventsRss } from "../src/events/feeds";
import { sitemapEvents } from "../src/events/reads";

const APP_URL = "https://next.example.test";
const KEY_A = "01J0000000000000000000AAA1";
const KEY_B = "01J0000000000000000000BBB2";
const KEY_C = "01J0000000000000000000CCC3";

type Row = typeof events.$inferSelect;
const row = (o: Partial<Row> = {}): Row =>
  ({
    id: 1,
    icsSequence: 1782907200n,
    eventKey: KEY_A,
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...o,
  }) as Row;

// --- log capture -----------------------------------------------------------
type LogCall = unknown[];
function captureLogs(): LogCall[] {
  const calls: LogCall[] = [];
  for (const level of ["warn", "error", "info", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
  }
  return calls;
}

function skipCountsIn(call: LogCall): number[] {
  const counts: number[] = [];
  const visit = (value: unknown, keyHint = ""): void => {
    if (typeof value === "number" && /skip/i.test(keyHint)) counts.push(value);
    else if (typeof value === "bigint" && /skip/i.test(keyHint)) counts.push(Number(value));
    else if (typeof value === "string") {
      for (const m of value.matchAll(/skip\w*(?:\D{0,24})(\d+)/gi)) counts.push(Number(m[1]));
      for (const m of value.matchAll(/(\d+)(?:\D{0,24})skip/gi)) counts.push(Number(m[1]));
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, keyHint));
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  call.forEach((arg) => visit(arg));
  return counts;
}

const expectSkipLogged = (calls: LogCall[], expected: number) =>
  expect(
    calls.flatMap(skipCountsIn),
    `expected a log line carrying skipped count ${expected}; saw ${JSON.stringify(calls)}`,
  ).toContain(expected);

const expectNoSkipLogged = (calls: LogCall[]) =>
  expect(
    calls.filter((call) => /skip/i.test(JSON.stringify(call) ?? "")),
    "no skip log may fire when nothing was skipped",
  ).toEqual([]);

// --- fake Db ---------------------------------------------------------------
// Every builder method returns the same chain; awaiting it resolves the
// scripted rows (or rejects). Survives the read gaining extra chain calls.
function fakeDb(script: Row[] | Error): Db {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then")
          return (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
            (script instanceof Error ? Promise.reject(script) : Promise.resolve(script)).then(
              resolve,
              reject,
            );
        return () => chain;
      },
    },
  );
  return { select: () => chain } as unknown as Db;
}

afterEach(() => vi.restoreAllMocks());

const sitemapEntry = (key: string, updatedAt = "2026-07-01T12:00:00.000Z") => ({
  key,
  status: "published" as const,
  updatedAt,
});

describe("sitemapEvents skips poison rows with a logged count", () => {
  it("resolves with good rows in order when one updatedAt is an invalid Date", async () => {
    const logs = captureLogs();
    const rows = [
      row({ id: 1, eventKey: KEY_A }),
      row({ id: 2, eventKey: KEY_B, updatedAt: new Date(NaN) }),
      row({ id: 3, eventKey: KEY_C, updatedAt: new Date("2026-07-02T12:00:00Z") }),
    ];
    await expect(sitemapEvents(fakeDb(rows))).resolves.toEqual([
      sitemapEntry(KEY_A),
      sitemapEntry(KEY_C, "2026-07-02T12:00:00.000Z"),
    ]);
    expectSkipLogged(logs, 1);
  });

  it("resolves when updatedAt is outside the JS Date range", async () => {
    const logs = captureLogs();
    // Past the JS Date ceiling: decodes to an invalid Date, same poison
    // class a far-future PostgreSQL timestamp produces through the driver.
    const rows = [
      row({ id: 1, eventKey: KEY_A, updatedAt: new Date(8.64e15 + 1) }),
      row({ id: 2, eventKey: KEY_B }),
    ];
    await expect(sitemapEvents(fakeDb(rows))).resolves.toEqual([sitemapEntry(KEY_B)]);
    expectSkipLogged(logs, 1);
  });

  it("skips rows whose startsAt or endsAt is invalid, counting each one", async () => {
    const logs = captureLogs();
    const rows = [
      row({ id: 1, eventKey: KEY_A, startsAt: new Date(NaN) }),
      row({ id: 2, eventKey: KEY_B, endsAt: new Date(NaN) }),
      row({ id: 3, eventKey: KEY_C }),
    ];
    await expect(sitemapEvents(fakeDb(rows))).resolves.toEqual([sitemapEntry(KEY_C)]);
    expectSkipLogged(logs, 2);
  });

  it("resolves to an empty list when every row is poison", async () => {
    const logs = captureLogs();
    const rows = [
      row({ id: 1, eventKey: KEY_A, updatedAt: new Date(NaN) }),
      row({ id: 2, eventKey: KEY_B, startsAt: new Date(NaN) }),
    ];
    await expect(sitemapEvents(fakeDb(rows))).resolves.toEqual([]);
    expectSkipLogged(logs, 2);
  });

  it("all-valid rows are unchanged and no skip is logged", async () => {
    const logs = captureLogs();
    const rows = [row({ id: 1, eventKey: KEY_A }), row({ id: 2, eventKey: KEY_B })];
    await expect(sitemapEvents(fakeDb(rows))).resolves.toEqual([
      sitemapEntry(KEY_A),
      sitemapEntry(KEY_B),
    ]);
    expectNoSkipLogged(logs);
  });

  it("an empty result stays empty with no skip logged", async () => {
    const logs = captureLogs();
    await expect(sitemapEvents(fakeDb([]))).resolves.toEqual([]);
    expectNoSkipLogged(logs);
  });

  it("a database failure still rejects instead of reading as zero events", async () => {
    captureLogs();
    await expect(sitemapEvents(fakeDb(new Error("db down")))).rejects.toThrow("db down");
  });
});

describe("eventsIcsCollection skips sequence-poison rows with a logged count", () => {
  it.each([-1n, 2147483648n, 9007199254740993n])(
    "serves the good VEVENTs byte-identically when one revision is %s",
    (badSequence) => {
      const logs = captureLogs();
      const goodA = row({ id: 1, eventKey: KEY_A });
      const goodC = row({ id: 3, eventKey: KEY_C });
      const poison = row({ id: 2, eventKey: KEY_B, icsSequence: badSequence });
      const out = eventsIcsCollection([goodA, poison, goodC], APP_URL);
      expect(out).toBe(eventsIcsCollection([goodA, goodC], APP_URL));
      expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
      expect(out).toContain(`UID:${KEY_A}@next.example.test`);
      expect(out).toContain(`UID:${KEY_C}@next.example.test`);
      expect(out).not.toContain(KEY_B);
      expect(out.indexOf(KEY_A)).toBeLessThan(out.indexOf(KEY_C));
      expectSkipLogged(logs, 1);
    },
  );

  it("counts every skipped row when several are poison", () => {
    const logs = captureLogs();
    const out = eventsIcsCollection(
      [
        row({ id: 1, eventKey: KEY_A, icsSequence: -5n }),
        row({ id: 2, eventKey: KEY_B }),
        row({ id: 3, eventKey: KEY_C, icsSequence: 2147483648n }),
      ],
      APP_URL,
    );
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(out).toContain(`UID:${KEY_B}@next.example.test`);
    expectSkipLogged(logs, 2);
  });

  it("serves an empty calendar when every row is poison", () => {
    const logs = captureLogs();
    const out = eventsIcsCollection([row({ id: 1, eventKey: KEY_A, icsSequence: -1n })], APP_URL);
    expect(out).toBe(eventsIcsCollection([], APP_URL));
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).not.toContain("BEGIN:VEVENT");
    expectSkipLogged(logs, 1);
  });

  it("still throws for a non-sequence builder failure instead of serving an empty calendar", () => {
    captureLogs();
    expect(() => eventsIcsCollection([row()], "not a url")).toThrow();
  });
});

describe("positive controls stay byte-identical", () => {
  it("single valid row collection matches the pinned calendar bytes", () => {
    const logs = captureLogs();
    expect(eventsIcsCollection([row()], APP_URL)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${KEY_A}@next.example.test`,
        "SEQUENCE:82907200",
        "DTSTAMP:20260701T120000Z",
        "DTSTART:20260715T180000Z",
        "DTEND:20260715T200000Z",
        "SUMMARY:Friday night Helldivers",
        "STATUS:CONFIRMED",
        "DESCRIPTION:Bring stims.",
        "LOCATION:Voice: General",
        `URL:${APP_URL}/e/${KEY_A}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday night Helldivers",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    expectNoSkipLogged(logs);
  });

  it("boundary revisions 0 and 2147483647 are served, not skipped", () => {
    const logs = captureLogs();
    const out = eventsIcsCollection(
      [
        row({ id: 1, eventKey: KEY_A, icsSequence: 0n }),
        row({ id: 2, eventKey: KEY_B, icsSequence: 2147483647n }),
      ],
      APP_URL,
    );
    expect(out).toContain("SEQUENCE:0\r\n");
    expect(out).toContain("SEQUENCE:447483647\r\n");
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expectNoSkipLogged(logs);
  });

  it("RSS bytes are unchanged and the stored revision never reaches RSS", () => {
    const logs = captureLogs();
    const built = new Date("2026-07-01T12:00:00Z");
    const expected =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
      "<title>Together We Own Events</title>" +
      `<link>${APP_URL}/events</link>` +
      `<atom:link href="${APP_URL}/events.rss" rel="self" type="application/rss+xml" />` +
      "<description>Upcoming events from Together We Own</description>" +
      "<lastBuildDate>Wed, 01 Jul 2026 12:00:00 +0000</lastBuildDate>" +
      `<item><title>Friday night Helldivers</title><link>${APP_URL}/e/${KEY_A}</link>` +
      `<guid isPermaLink="true">${APP_URL}/e/${KEY_A}</guid>` +
      "<pubDate>Wed, 15 Jul 2026 18:00:00 +0000</pubDate>" +
      "<description>Bring stims.</description></item></channel></rss>";
    expect(eventsRss([row()], APP_URL, built)).toBe(expected);
    // A sequence-poison row is an ICS-only skip: RSS output is identical.
    expect(eventsRss([row({ icsSequence: -1n })], APP_URL, built)).toBe(expected);
    expectNoSkipLogged(logs);
  });
});
