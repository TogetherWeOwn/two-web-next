// W9 calendar feeds: byte-level fixtures pinned to two-web's EventIcs/EventRss/EventGoogleCalendar
// output, plus route tests (agent-testdb; skipped without DATABASE_URL).
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { events } from "../src/db/admin-schema";
import { createDb } from "../src/db/index";
import type { Env } from "../src/env";
import { eventIcs, eventsIcsCollection, eventsRss, googleCalendarUrl, webcalUrl } from "../src/events/feeds";

const APP_URL = "https://next.example.test";
const KEY = "01J0000000000000000000ABCD";
const row = (o: Partial<typeof events.$inferSelect> = {}) =>
  ({
    id: 1,
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
        "SEQUENCE:1782907200",
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

  it("escapes, folds at 75 octets on a character boundary, and maps CANCELLED", () => {
    const out = eventIcs(row({ title: "a;b,c\\d\ne", description: "é".repeat(60), status: "cancelled" }), APP_URL);
    expect(out).toContain("SUMMARY:a\\;b\\,c\\\\d\\ne\r\n");
    expect(out).toContain("STATUS:CANCELLED");
    const lines = out.split("\r\n");
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(out.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${"é".repeat(60)}`);
    expect(out).not.toMatch(/(?<!\r)\n/);
  });

  it("collection ICS wraps one VEVENT per event and webcal swaps the scheme", () => {
    const out = eventsIcsCollection([row(), row({ eventKey: "01J0000000000000000000WXYZ", status: "cancelled" })], APP_URL);
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(out.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(webcalUrl(APP_URL)).toBe("webcal://next.example.test/events.ics");
  });

  it("RSS matches the legacy bytes", () => {
    expect(eventsRss([row({ title: `A & "B" <c>`, description: "it's" })], APP_URL, new Date("2026-07-01T12:00:00Z"))).toBe(
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

  it("Google Calendar link is RFC3986-encoded UTC", () => {
    expect(googleCalendarUrl(row())).toBe(
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Friday%20night%20Helldivers&dates=20260715T180000Z%2F20260715T200000Z&details=Bring%20stims.&location=Voice%3A%20General",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("feed routes (agent-testdb)", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const env = { APP_URL, ADMIN_DB: db, SESSION_SECRET: "test-session-secret-at-least-32-bytes-long" } as unknown as Env;
  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const ins = (key: string, status: "draft" | "published" | "cancelled" | "past", endsAt = "2099-01-02T00:00:00Z") =>
    db.insert(events).values({ eventKey: key, title: `t-${key}`, startsAt: new Date("2099-01-01T00:00:00Z"), endsAt: new Date(endsAt), timezone: "UTC", status } as never);

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
    expect((await req("/events.ics", { headers: { "if-none-match": ics.headers.get("etag")! } })).status).toBe(304);
  });

  it("per-event ICS: 200 published, 403 draft, 404 unknown/malformed, 304 on ETag", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    await ins("01J0000000000000000000DRF1", "draft");
    const ok = await req("/events/01J0000000000000000000PXB1.ics");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe('attachment; filename="01J0000000000000000000PXB1.ics"');
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect((await req("/events/01J0000000000000000000PXB1.ics", { headers: { "if-none-match": ok.headers.get("etag")! } })).status).toBe(304);
    expect((await req("/events/01J0000000000000000000DRF1.ics")).status).toBe(403);
    expect((await req("/events/01J0000000000000000000NONE.ics")).status).toBe(404);
    expect((await req("/events/nope.ics")).status).toBe(404);
  });
});
