// route-inventory: GET /events.ics
// route-inventory: GET /events.rss
// route-inventory: GET /events/:file{.+\.ics}
// W9 calendar feeds: byte-level fixtures pinned to two-web's EventIcs/EventRss/EventGoogleCalendar
// output, plus route tests (agent-testdb; skipped without DATABASE_URL).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import type { Env } from "../src/env";
import {
  IcsSequenceRangeError,
  eventIcs,
  eventsIcsCollection,
  eventsRss,
  googleCalendarUrl,
  isWireInstant,
  latestWireUpdatedAt,
  webcalUrl,
} from "../src/events/feeds";

const APP_URL = "https://next.example.test";
const KEY = "01J0000000000000000000ABCD";
const row = (o: Partial<typeof events.$inferSelect> = {}) =>
  ({
    id: 1,
    icsSequence: 1782907200n,
    eventKey: KEY,
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
  }) as typeof events.$inferSelect;

describe("feed builders (byte fixtures)", () => {
  it("per-event ICS matches the legacy bytes", () => {
    expect(eventIcs(row(), APP_URL)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${KEY}@next.example.test`,
        "SEQUENCE:82907200",
        "DTSTAMP:20260701T120000Z",
        "DTSTART:20260715T180000Z",
        "DTEND:20260715T200000Z",
        "SUMMARY:Friday night Helldivers",
        "STATUS:CONFIRMED",
        "DESCRIPTION:Bring stims.",
        "LOCATION:Voice: General",
        `URL:${APP_URL}/e/${KEY}`,
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
  });

  it.each([
    [0n, "0"],
    [2147483647n, "447483647"],
  ] as const)(
    "emits base-shifted SEQUENCE %s for stored revision %s independently of updatedAt",
    (icsSequence, emitted) => {
      const event = row({ icsSequence });
      for (const body of [eventIcs(event, APP_URL), eventsIcsCollection([event], APP_URL)]) {
        expect(body).toContain(`SEQUENCE:${emitted}\r\n`);
        expect(body).toContain("DTSTAMP:20260701T120000Z\r\n");
      }
    },
  );

  it.each([-1n, 2147483648n, 9007199254740993n])(
    "rejects invalid SEQUENCE %s without clamping; collections skip the row instead",
    (icsSequence) => {
      const event = row({ icsSequence });
      expect(() => eventIcs(event, APP_URL)).toThrow(IcsSequenceRangeError);
      expect(eventsIcsCollection([row(), event], APP_URL)).toBe(
        eventsIcsCollection([row()], APP_URL),
      );
      expect(event.icsSequence).toBe(icsSequence);
    },
  );

  it("escapes, folds at 75 octets on a character boundary, and maps CANCELLED", () => {
    const out = eventIcs(
      row({ title: "a;b,c\\d\ne", description: "é".repeat(60), status: "cancelled" }),
      APP_URL,
    );
    expect(out).toContain("SUMMARY:a\\;b\\,c\\\\d\\ne\r\n");
    expect(out).toContain("STATUS:CANCELLED");
    const lines = out.split("\r\n");
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(out.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${"é".repeat(60)}`);
    expect(out).not.toMatch(/(?<!\r)\n/);
  });

  it("collection ICS wraps one VEVENT per event and webcal swaps the scheme", () => {
    const out = eventsIcsCollection(
      [row(), row({ eventKey: "01J0000000000000000000WXYZ", status: "cancelled" })],
      APP_URL,
    );
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(out.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(webcalUrl(APP_URL)).toBe("webcal://next.example.test/events.ics");
  });

  it("RSS matches the legacy bytes", () => {
    expect(
      eventsRss(
        [row({ title: `A & "B" <c>`, description: "it's" })],
        APP_URL,
        new Date("2026-07-01T12:00:00Z"),
      ),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
        "<title>Together We Own Events</title>" +
        `<link>${APP_URL}/events</link>` +
        `<atom:link href="${APP_URL}/events.rss" rel="self" type="application/rss+xml" />` +
        "<description>Upcoming events from Together We Own</description>" +
        "<lastBuildDate>Wed, 01 Jul 2026 12:00:00 +0000</lastBuildDate>" +
        `<item><title>A &amp; &quot;B&quot; &lt;c&gt;</title><link>${APP_URL}/e/${KEY}</link>` +
        `<guid isPermaLink="true">${APP_URL}/e/${KEY}</guid><pubDate>Wed, 15 Jul 2026 18:00:00 +0000</pubDate>` +
        "<description>it&#039;s</description></item></channel></rss>",
    );
  });

  it.each([
    ["0000-01-02T03:04:05Z", "Sun, 02 Jan 0000 03:04:05 +0000"],
    ["0500-01-02T03:04:05Z", "Sat, 02 Jan 0500 03:04:05 +0000"],
    ["0999-01-02T03:04:05Z", "Wed, 02 Jan 0999 03:04:05 +0000"],
  ])("pads RSS item and channel years for %s", (instant, expected) => {
    const date = new Date(instant);
    const body = eventsRss([row({ startsAt: date })], APP_URL, date);
    expect(body).toContain(`<pubDate>${expected}</pubDate>`);
    expect(body).toContain(`<lastBuildDate>${expected}</lastBuildDate>`);
    expect(body.match(/<item>/g)).toHaveLength(1);
  });

  it("Google Calendar link is RFC3986-encoded UTC", () => {
    expect(googleCalendarUrl(row())).toBe(
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Friday%20night%20Helldivers&dates=20260715T180000Z%2F20260715T200000Z&details=Bring%20stims.&location=Voice%3A%20General",
    );
  });

  it("omits the item description element when the event has none, keeping the channel description", () => {
    const out = eventsRss(
      [
        row({ description: null }),
        row({ eventKey: "01J0000000000000000000EMPT", description: "" }),
      ],
      APP_URL,
      new Date("2026-07-01T12:00:00Z"),
    );
    // Exactly one <description> remains: the channel's own.
    expect(out.match(/<description>/g)).toHaveLength(1);
    expect(out).toContain("<pubDate>Wed, 15 Jul 2026 18:00:00 +0000</pubDate></item>");
  });

  it("keeps the permalink guid stable across a rename and renders pubDate in UTC on both DST sides", () => {
    const summer = eventsRss([row()], APP_URL, new Date("2026-07-01T12:00:00Z"));
    const renamed = eventsRss(
      [row({ title: "Renamed raid" })],
      APP_URL,
      new Date("2026-07-01T12:00:00Z"),
    );
    const guid = `<guid isPermaLink="true">${APP_URL}/e/${KEY}</guid>`;
    expect(summer).toContain(guid);
    expect(renamed).toContain(guid);
    expect(summer).toContain("<pubDate>Wed, 15 Jul 2026 18:00:00 +0000</pubDate>"); // BST: 19:00 local
    const winter = eventsRss(
      [row({ startsAt: new Date("2026-01-15T20:00:00Z") })],
      APP_URL,
      new Date("2026-07-01T12:00:00Z"),
    );
    expect(winter).toContain("<pubDate>Thu, 15 Jan 2026 20:00:00 +0000</pubDate>"); // GMT: 20:00 local
  });

  it("round-trips emoji and multibyte titles byte-for-byte (RSS escaped, ICS raw)", () => {
    const title = "🎮 Nächster Raid — 東京ゲームナイト";
    const rss = eventsRss([row({ title })], APP_URL, new Date("2026-07-01T12:00:00Z"));
    expect(rss).toContain(`<title>${title}</title>`);
    expect(new TextDecoder().decode(new TextEncoder().encode(rss))).toContain(title);
    const ics = eventIcs(row({ title }), APP_URL);
    expect(ics).toContain(`SUMMARY:${title}`);
    for (const l of ics.split("\r\n"))
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
  it("skips RSS rows with non-wire boundary years while keeping healthy bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = eventsRss(
        [
          row({ eventKey: "01J0000000000000000000GOOD" }),
          row({
            eventKey: "01J0000000000000000000BAD1",
            startsAt: new Date("+010000-01-02T03:04:05Z"),
          }),
          row({
            eventKey: "01J0000000000000000000BAD2",
            endsAt: new Date("-000001-01-02T03:04:05Z"),
          }),
        ],
        APP_URL,
        new Date("2026-07-01T12:00:00Z"),
      );
      expect(body).toContain("01J0000000000000000000GOOD");
      expect(body).not.toContain("01J0000000000000000000BAD");
      expect(warn).toHaveBeenCalledWith("eventsRss skipped rows with non-wire timestamps.", {
        skipped: 2,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("excludes a non-wire updatedAt from RSS lastBuildDate without dropping the item", () => {
    const rows = [
      row({
        eventKey: "01J0000000000000000000BAD3",
        updatedAt: new Date("+010000-01-02T03:04:05Z"),
      }),
      row({
        eventKey: "01J0000000000000000000GOOD",
        updatedAt: new Date("2026-07-01T12:00:00Z"),
      }),
    ];
    const lastBuild = latestWireUpdatedAt(rows);
    const body = eventsRss(rows, APP_URL, lastBuild);
    expect(lastBuild).toEqual(new Date("2026-07-01T12:00:00Z"));
    expect(body).toContain("<lastBuildDate>Wed, 01 Jul 2026 12:00:00 +0000</lastBuildDate>");
    expect(body).toContain("01J0000000000000000000BAD3");
  });

  it("pads the lower supported ICS year to four digits", () => {
    const event = row({
      updatedAt: new Date("0000-01-02T03:04:05Z"),
      startsAt: new Date("0000-02-03T04:05:06Z"),
      endsAt: new Date("0000-03-04T05:06:07Z"),
    });
    const body = eventIcs(event, APP_URL);
    expect(isWireInstant(event.updatedAt)).toBe(true);
    expect(body).toContain("DTSTAMP:00000102T030405Z");
    expect(body).toContain("DTSTART:00000203T040506Z");
    expect(body).toContain("DTEND:00000304T050607Z");
  });
});

describe("feed host CN normalization (RFC 5545 quoted-string)", () => {
  const organizerLine = (organizerName: string): string => {
    const unfolded = eventIcs(row({ organizer_name: organizerName }), APP_URL).replace(
      /\r\n[ \t]/g,
      "",
    );
    return unfolded.split("\r\n").find((l) => l.startsWith("ORGANIZER"))!;
  };
  const cnInner = (line: string): string => {
    const inner = line.slice('ORGANIZER;CN="'.length, line.lastIndexOf(`":mailto:`));
    // QSAFE-CHAR excludes DQUOTE and controls; the grammar defines no
    // backslash escape for parameter values, so neither may appear.
    expect(inner).not.toMatch(/["\u0000-\u001F\u007F]/);
    return inner;
  };

  it.each([
    ["dquote to apostrophe", 'Ada "Host" Lovelace', "Ada 'Host' Lovelace"],
    ["newline run to space", "Line1\nLine2", "Line1 Line2"],
    ["crlf run to space", "Line1\r\nLine2", "Line1 Line2"],
    ["tab run to space", "A\tB", "A B"],
    ["backslash stays single", "A\\B", "A\\B"],
    ["colon stays literal", "A:B", "A:B"],
    ["semicolon stays literal", "Raid; Night", "Raid; Night"],
    ["comma stays literal", "Doe, Jane", "Doe, Jane"],
    ["caret stays literal", "A^nB", "A^nB"],
  ])("%s", (_label, name, expected) => {
    const line = organizerLine(name);
    expect(line.startsWith('ORGANIZER;CN="')).toBe(true);
    expect(line.endsWith('":mailto:noreply@example.invalid')).toBe(true);
    expect(cnInner(line)).toBe(expected);
  });
});

describe("latestWireUpdatedAt", () => {
  it.each([
    ["empty", [], "1970-01-01T00:00:00Z"],
    [
      "all poison",
      [Number.NaN, "+010000-01-01T00:00:00Z", "-000001-01-01T00:00:00Z"],
      "1970-01-01T00:00:00Z",
    ],
    ["year zero only", ["0000-01-02T03:04:05Z"], "0000-01-02T03:04:05Z"],
    [
      "unsorted pre-epoch with poison",
      [
        Number.NaN,
        "+010000-01-01T00:00:00Z",
        "0000-01-02T03:04:05Z",
        "1960-01-01T00:00:00Z",
        "0500-01-02T03:04:05Z",
      ],
      "1960-01-01T00:00:00Z",
    ],
    [
      "unsorted modern dates",
      ["2000-01-01T00:00:00Z", "2030-01-01T00:00:00Z", "2020-01-01T00:00:00Z"],
      "2030-01-01T00:00:00Z",
    ],
  ] as const)("selects the latest wire instant: %s", (_label, instants, expected) => {
    const rows = instants.map((instant) => row({ updatedAt: new Date(instant) }));
    expect(latestWireUpdatedAt(rows)).toEqual(new Date(expected));
    expect(rows.map((row) => row.updatedAt.getTime())).toEqual(
      instants.map((instant) => new Date(instant).getTime()),
    );
  });
});

describe("isWireInstant", () => {
  it.each([
    ["finite UTC instant", "2026-07-15T18:00:00Z", true],
    ["year zero", "0000-01-02T03:04:05Z", true],
    ["low year", "0001-01-02T03:04:05Z", true],
    ["year 9999", "9999-01-02T03:04:05Z", true],
    ["invalid Date", Number.NaN, false],
    ["outside JS Date", 8.64e15 + 1, false],
    ["expanded year", "+010000-01-02T03:04:05Z", false],
    ["negative year", "-000001-01-02T03:04:05Z", false],
    ["maximum finite Date", 8.64e15, false],
    ["minimum finite Date", -8.64e15, false],
  ])("%s classifies as %s", (_label, instant, expected) => {
    expect(isWireInstant(new Date(instant))).toBe(expected);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("feed routes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  beforeAll(async () => {
    // Replay every canonical migration into a guarded, owned schema (never public).
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  const env = {
    APP_URL,
    get ADMIN_DB() {
      return db;
    },
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  } as unknown as Env;
  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const ins = (
    key: string,
    status: "draft" | "published" | "cancelled" | "past",
    endsAt = "2099-01-02T00:00:00Z",
  ) =>
    db.insert(events).values({
      eventKey: key,
      title: `t-${key}`,
      startsAt: new Date("2099-01-01T00:00:00Z"),
      endsAt: new Date(endsAt),
      timezone: "UTC",
      status,
    } as never);

  beforeEach(async () => {
    await db.delete(events);
  });

  it("serves feeds sessionless with ETag/304 and never exposes drafts", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    await ins("01J0000000000000000000DRF1", "draft");
    await ins("01J0000000000000000000CAN1", "cancelled");
    await ins("01J00000000000000000000KD1", "published", "2000-01-02T00:00:00Z");

    const rss = await req("/events.rss");
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(rss.headers.get("set-cookie")).toBeNull();
    const rssBody = await rss.text();
    expect(rssBody).toContain("PXB1");
    for (const k of ["DRF1", "CAN1", "0KD1"]) expect(rssBody).not.toContain(k);
    const etag = rss.headers.get("etag")!;
    const nm = await req("/events.rss", { headers: { "if-none-match": etag } });
    expect(nm.status).toBe(304);
    expect(await nm.text()).toBe("");

    const ics = await req("/events.ics");
    const icsBody = await ics.text();
    expect(ics.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(ics.headers.get("set-cookie")).toBeNull();
    expect(icsBody).toContain("PXB1");
    expect(icsBody).toContain("STATUS:CANCELLED");
    expect(icsBody).not.toContain("DRF1");
    expect(
      (await req("/events.ics", { headers: { "if-none-match": ics.headers.get("etag")! } })).status,
    ).toBe(304);
  });

  it("per-event ICS: 200 published, 403 draft, 404 unknown/malformed, 304 on ETag", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    await ins("01J0000000000000000000DRF1", "draft");
    const ok = await req("/events/01J0000000000000000000PXB1.ics");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe(
      'attachment; filename="01J0000000000000000000PXB1.ics"',
    );
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await req("/events/01J0000000000000000000PXB1.ics", {
          headers: { "if-none-match": ok.headers.get("etag")! },
        })
      ).status,
    ).toBe(304);
    expect((await req("/events/01J0000000000000000000DRF1.ics")).status).toBe(403);
    expect((await req("/events/01J0000000000000000000NONE.ics")).status).toBe(404);
    expect((await req("/events/nope.ics")).status).toBe(404);
  });

  it.each([
    ["/events.rss", "<item>"],
    ["/events.ics", "BEGIN:VEVENT"],
  ])(
    "%s drops an expired event and rotates its ETag with no write after ends_at",
    async (path, itemMarker) => {
      // Legacy FeedExpiryValidatorTest: equality is still upcoming; advancing
      // the clock one second invalidates the original validator without a write.
      const key = "01J0000000000000000000EXP1";
      const title = "Clock-only expiry sentinel";
      await db.insert(events).values({
        eventKey: key,
        title,
        startsAt: new Date("2026-07-15T18:00:00Z"),
        endsAt: new Date("2026-07-15T20:00:00Z"),
        timezone: "UTC",
        status: "published",
      });
      const original = await db.select().from(events).where(eq(events.eventKey, key));
      expect(original).toHaveLength(1);
      // Fake only the clock: the driver needs its real socket timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-07-15T20:00:00Z"));

        const fresh = await req(path);
        expect(fresh.status).toBe(200);
        expect(fresh.headers.get("cache-control")).toBe("max-age=300, public");
        const freshBody = await fresh.text();
        expect(freshBody).toContain(itemMarker);
        expect(freshBody).toContain(title);
        const etag = fresh.headers.get("etag");
        expect(etag).toBeTruthy();
        const unchanged = await req(path, { headers: { "if-none-match": etag! } });
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get("etag")).toBe(etag);
        expect(await unchanged.text()).toBe("");

        vi.setSystemTime(new Date("2026-07-15T20:00:01Z"));

        const stale = await req(path, { headers: { "if-none-match": etag! } });
        expect(stale.status).toBe(200);
        const staleBody = await stale.text();
        expect(staleBody).not.toBe(freshBody);
        expect(staleBody).not.toContain(itemMarker);
        expect(staleBody).not.toContain(title);
        const etag2 = stale.headers.get("etag");
        expect(etag2).toBeTruthy();
        expect(etag2).not.toBe(etag);
        const refreshed = await req(path, { headers: { "if-none-match": etag2! } });
        expect(refreshed.status).toBe(304);
        expect(refreshed.headers.get("etag")).toBe(etag2);
        expect(await refreshed.text()).toBe("");
        expect((await req(`/events/${key}.ics`)).status).toBe(200); // per-event download still serves
        expect(await db.select().from(events).where(eq(events.eventKey, key))).toEqual(original);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
