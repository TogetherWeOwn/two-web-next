// TOG-12103: DST-paired wall agreement across page, JSON and feed surfaces.
//
// Ledger docs/w15-events-acceptance-ledger.md:139 (EventTimezoneDisplayTest):
// host wall conversion, UTC feed exports and calendar month bucketing are
// pinned elsewhere; the gap is cross-surface agreement for one wall instant,
// the New York date rollover and the Auckland viewer day bucket. Display
// agreement only — fold direction belongs to TOG-11669 and no fold behavior
// changes here.
//
// DB-free: pure builders (feeds), pure zone helpers (validation, contracts)
// and the real page shells rendered directly. No database, no network.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { utcToWall, wallToUtc } from "../src/admin/validation";
import { eventJson } from "../src/events/routes";
import { eventIcs, eventsRss, googleCalendarUrl, icsInstant, rssDate } from "../src/events/feeds";
import { EventPage, EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  calendarZone,
  cardTimeLabel,
  wallDateIso,
  wallMonth,
  wallTimeHm,
  type CalendarEmptyState,
  type CalendarState,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2026-07-15T19:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "dst-summer",
    title: "Summer raid night",
    game: null,
    description: "Bring stims.",
    startsAt: start,
    endsAt: new Date("2026-07-15T21:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    goingCount: 3,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  };
}

/** Every surface must name this same stored instant. */
function surfaceInstants(
  html: string,
  json: ReturnType<typeof eventJson>,
  ics: string,
  rss: string,
) {
  const pageMatch = /<time datetime="([^"]+)">/.exec(html);
  expect(pageMatch, "event page renders a datetime instant").not.toBeNull();
  const icsMatch = /DTSTART:(\d{8}T\d{6}Z)/.exec(ics);
  expect(icsMatch, "ICS names a DTSTART instant").not.toBeNull();
  const rssMatch = /<pubDate>([^<]+)<\/pubDate>/.exec(rss);
  expect(rssMatch, "RSS names a pubDate").not.toBeNull();
  // DTSTART is fixed-width `Ymd\THis\Z`; slice positions, not digit runs.
  const v = icsMatch![1]!;
  return {
    page: new Date(pageMatch![1]!).getTime(),
    jsonShow: new Date(json.starts_at).getTime(),
    jsonEnds: new Date(json.ends_at).getTime(),
    ics: Date.UTC(
      +v.slice(0, 4),
      +v.slice(4, 6) - 1,
      +v.slice(6, 8),
      +v.slice(9, 11),
      +v.slice(11, 13),
      +v.slice(13, 15),
    ),
    rss: new Date(rssMatch![1]!).getTime(),
  };
}

async function renderPage(e: PublicEvent): Promise<string> {
  const html = await jsx(EventPage, {
    e,
    neighbors: { previous: null, next: null },
    related: [],
    appUrl: APP_URL,
    jsonLd: "{}",
  }).toString();
  expect(html).toContain(e.title);
  return html;
}

async function renderCalendar(e: PublicEvent, month: string): Promise<string> {
  const state: CalendarState = { view: "calendar", month, q: "", past: false };
  const html = await jsx(EventsCalendarPage, {
    state,
    upcoming: [e],
    past: [],
    zone: e.timezone,
    now: new Date("2026-07-01T12:00:00Z"),
    emptyState: null as CalendarEmptyState,
    discordFailed: false,
    member: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: APP_URL,
  }).toString();
  expect(html).toContain('data-testid="events-calendar-grid"');
  return html;
}

function cellFor(html: string, iso: string): string {
  const cell = new RegExp(`<td[^>]*data-date="${iso}"[^>]*>([\\s\\S]*?)</td>`).exec(html)?.[1];
  expect(cell, `month grid renders a cell for ${iso}`).toBeDefined();
  return cell!;
}

describe("DST-paired cross-surface agreement", () => {
  it.each([
    // [slug, host wall, stored UTC instant, host zone]
    ["dst-summer", "2026-07-15 20:00", "2026-07-15T19:00:00.000Z", "Europe/London"], // BST
    ["dst-winter", "2026-01-15 20:00", "2026-01-15T20:00:00.000Z", "Europe/London"], // GMT
    ["fold-bst", "2026-10-25 01:30", "2026-10-25T01:30:00.000Z", "Europe/London"], // second occurrence (#289)
  ])("%s renders one wall instant on page, JSON, ICS and RSS", async (slug, wall, iso, zone) => {
    const startsAt = new Date(iso);
    const e = event({
      eventKey: slug,
      timezone: zone,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 7200_000),
    });

    // Host wall conversion round-trips through the stored instant.
    expect(wallToUtc(wall, zone).toISOString()).toBe(iso);
    expect(utcToWall(startsAt, zone)).toBe(wall);

    // Page HTML names the stored instant and shows the host wall clock.
    const html = await renderPage(e);
    expect(html).toContain(`datetime="${iso}"`);
    expect(html).toContain(wallTimeHm(startsAt, zone));

    // JSON show and collection share one serializer: UTC instant + host zone.
    const json = eventJson(e);
    expect(json.starts_at).toBe(iso);
    expect(json.ends_at).toBe(e.endsAt.toISOString());
    expect(json.timezone).toBe(zone);

    // Feed bytes name the same UTC instant (no wall text leaks into exports).
    const ics = eventIcs(e, APP_URL);
    expect(ics).toContain(`DTSTART:${icsInstant(startsAt)}`);
    expect(ics).toContain(`DTEND:${icsInstant(e.endsAt)}`);
    const rss = eventsRss([e], APP_URL, new Date("2026-07-01T12:00:00Z"));
    expect(rss).toContain(`<pubDate>${rssDate(startsAt)}</pubDate>`);
    expect(googleCalendarUrl(e)).toContain(
      `dates=${icsInstant(startsAt)}%2F${icsInstant(e.endsAt)}`,
    );

    // Page, JSON, ICS and RSS resolve to the one stored instant; the JSON
    // end clock names the stored end instant.
    const { jsonEnds, ...starts } = surfaceInstants(html, json, ics, rss);
    for (const [surface, ms] of Object.entries(starts)) {
      expect(ms, `${surface} agrees on ${iso}`).toBe(startsAt.getTime());
    }
    expect(jsonEnds).toBe(e.endsAt.getTime());

    // Calendar buckets and labels follow the host zone, not UTC.
    const bucket = wallDateIso(startsAt, zone);
    expect(cardTimeLabel(startsAt, zone)).toContain(wallTimeHm(startsAt, zone));
    expect(calendarZone([zone])).toBe(zone);
    const grid = await renderCalendar(e, wallMonth(startsAt, zone));
    expect(cellFor(grid, bucket)).toContain(`${wallTimeHm(startsAt, zone)} ${e.title}`);
  });

  it("rolls the calendar day back when New York wall time falls on the previous date", async () => {
    // 00:30Z is 19:30 the evening before in America/New_York (EST).
    const startsAt = new Date("2026-01-15T00:30:00Z");
    const e = event({
      eventKey: "ny-rollover",
      title: "Late night raid",
      timezone: "America/New_York",
      startsAt,
      endsAt: new Date("2026-01-15T02:30:00Z"),
    });
    expect(utcToWall(startsAt, e.timezone)).toBe("2026-01-14 19:30");
    expect(wallToUtc("2026-01-14 19:30", e.timezone).toISOString()).toBe(startsAt.toISOString());

    // Every surface still names the stored instant; the viewer bucket is the 14th.
    const html = await renderPage(e);
    expect(html).toContain(`datetime="${startsAt.toISOString()}"`);
    expect(eventJson(e).starts_at).toBe(startsAt.toISOString());
    expect(eventIcs(e, APP_URL)).toContain(`DTSTART:${icsInstant(startsAt)}`);
    expect(wallDateIso(startsAt, e.timezone)).toBe("2026-01-14");
    expect(wallMonth(startsAt, e.timezone)).toBe("2026-01");

    const grid = await renderCalendar(e, "2026-01");
    expect(cellFor(grid, "2026-01-14")).toContain("19:30 Late night raid");
    expect(cellFor(grid, "2026-01-15")).not.toContain("Late night raid");
  });

  it("buckets the viewer day forward when Auckland wall time falls on the next date", async () => {
    // 13:00Z is 01:00 the next morning in Pacific/Auckland (NZST, +12).
    const startsAt = new Date("2026-07-15T13:00:00Z");
    const e = event({
      eventKey: "auckland-bucket",
      title: "Dawn patrol",
      timezone: "Pacific/Auckland",
      startsAt,
      endsAt: new Date("2026-07-15T15:00:00Z"),
    });
    expect(utcToWall(startsAt, e.timezone)).toBe("2026-07-16 01:00");
    expect(wallToUtc("2026-07-16 01:00", e.timezone).toISOString()).toBe(startsAt.toISOString());

    const html = await renderPage(e);
    expect(html).toContain(`datetime="${startsAt.toISOString()}"`);
    expect(eventJson(e).starts_at).toBe(startsAt.toISOString());
    expect(eventsRss([e], APP_URL, new Date("2026-07-01T12:00:00Z"))).toContain(
      `<pubDate>${rssDate(startsAt)}</pubDate>`,
    );
    expect(wallDateIso(startsAt, e.timezone)).toBe("2026-07-16");
    expect(wallMonth(startsAt, e.timezone)).toBe("2026-07");

    const grid = await renderCalendar(e, "2026-07");
    expect(cellFor(grid, "2026-07-16")).toContain("01:00 Dawn patrol");
    expect(cellFor(grid, "2026-07-15")).not.toContain("Dawn patrol");
  });
});
