// TOG-36301: failing-first acceptance tests — event voice channel link in ICS/GCal.
//
// Host decision D11 + accepted change R18 (event voice channels epic): ICS
// LOCATION carries a STABLE deep link when the voice channel exists and TBD
// text otherwise — never a per-rename value — and ics_sequence bumps only on
// start-time or link-availability transitions, so calendar clients are not
// spammed on every channel rename.
//
// THE CONTRACT (the Builder implements exactly this; this file never changes):
// - Pure builders (`eventIcs`, `eventsIcsCollection`, `googleCalendarUrl`)
//   read an optional `voiceLocation` transient on the row: the exact LOCATION
//   text (deep link or TBD copy). Absent/null keeps today's behavior.
// - Display cache (Builder migration on `events`): `voice_channel_id text`,
//   `voice_channel_name text`, `voice_tbd_reason text`, all nullable.
// - Route rule: channel id present -> deep link
//   `https://discord.com/channels/<DISCORD_GUILD_ID>/<voice_channel_id>`;
//   else tbd_reason present -> static TBD text
//   `Voice channel opens 15 min before · opens at <YYYY-MM-DD HH:MM UTC>`
//   (opens-at = starts_at minus 15 minutes, UTC); else physical location or
//   no LOCATION line as today.
// - `ics_sequence` trigger: bump on starts_at changes and on
//   voice_channel_id NULL<->non-null transitions ONLY. Name-only, title-only
//   and description-only writes do not bump.
// - Deliberately NOT pinned (Builder's choice): ends_at-only and status-only
//   trigger behavior, the hidden (ended, link-less) state, and reason-specific
//   TBD copy (the TBD text here is static across reasons).
//
// RED-FIRST MAP (18 red / 8 green on the pre-voice code; all green after):
// - Red now: every LOCATION-link/TBD assertion, the rename byte-stability
//   test, the TBD-static guard, the page GCal tests, and the no-bump tests.
// - Green now (controls): physical-location passthrough, starts_at and
//   link-availability bumps, combined rename+time bump.
// KNOWN FALLOUT for the Builder: test/event-ics-revision.test.ts pins the old
// bump-on-any-edit trigger (title edits, publish/cancel) and must be updated
// to the time/link-only rule alongside the migration.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { eventIcs, eventsIcsCollection, googleCalendarUrl } from "../src/events/feeds";
import { createMemorySessionStore } from "../src/sessions";
import { env } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

type EventRow = typeof events.$inferSelect;

const APP_URL = "https://next.example.test";
const GUILD_ID = "326474832151838730"; // == env.DISCORD_GUILD_ID
const CHANNEL_ID = "100000000000000131";
const DEEP_LINK = `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`;
const LIVE_NAME = "Event Voice · Game Night";
const AFTER_PARTY_NAME = "After-Party · Game Night";
const STARTS_AT = new Date("2027-01-01T18:00:00Z");
const ENDS_AT = new Date("2027-01-01T20:00:00Z");
const OPENS_TEXT = "Voice channel opens 15 min before · opens at 2027-01-01 17:45 UTC";

// Synthetic ULIDs from the repo-global gitleaks allowlist (a `*Key` const with
// any other ULID trips generic-api-key on the full branch history).
const LIVE_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const TBD_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const AFTER_PARTY_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
const PHYSICAL_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";

const ical = (...lines: string[]): string => `${lines.join("\r\n")}\r\n`;

// In-memory row fixture; the `voiceLocation` transient is the exact LOCATION
// text the route layer resolves (deep link or TBD copy). The Builder's feeds
// change reads it; until then the builders ignore it and these tests fail.
const row = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  eventKey: LIVE_KEY,
  title: "Friday Game Night",
  game: null,
  description: null,
  startsAt: STARTS_AT,
  endsAt: ENDS_AT,
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2026-12-01T12:00:00Z"),
  updatedAt: new Date("2026-12-01T12:00:00Z"),
  icsSequence: 1790000000n, // wire SEQUENCE 90000000 after the disclosure shift
  syncRevision: 1,
  syncedRevision: 0,
  ...overrides,
});

const withVoice = (r: EventRow, voiceLocation: string | null) => ({
  ...r,
  voiceLocation,
});

const locationLine = (body: string): string | undefined =>
  body.replaceAll("\r\n ", "").match(/^LOCATION:([^\r\n]*)/m)?.[1];

describe("ICS voice link sync (pure builders)", () => {
  it("live voice link lands in LOCATION, never the channel name", () => {
    const body = eventIcs(withVoice(row(), DEEP_LINK), APP_URL);
    expect(locationLine(body)).toBe(DEEP_LINK);
    expect(body).not.toContain(LIVE_NAME);
    expect(body).toContain("SUMMARY:Friday Game Night");
  });

  it("live golden VEVENT bytes", () => {
    const live = withVoice(row({ description: "A live community game night." }), DEEP_LINK);
    expect(eventIcs(live, APP_URL)).toBe(
      ical(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${LIVE_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T120000Z",
        "DTSTART:20270101T180000Z",
        "DTEND:20270101T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        "DESCRIPTION:A live community game night.",
        `LOCATION:${DEEP_LINK}`,
        `URL:${APP_URL}/e/${LIVE_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
  });

  it("TBD golden VEVENT bytes", () => {
    const tbd = withVoice(row({ eventKey: TBD_KEY }), OPENS_TEXT);
    expect(eventIcs(tbd, APP_URL)).toBe(
      ical(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${TBD_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T120000Z",
        "DTSTART:20270101T180000Z",
        "DTEND:20270101T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        `LOCATION:${OPENS_TEXT}`,
        `URL:${APP_URL}/e/${TBD_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
  });

  it("after-party keeps the stable link after the end, never the new name", () => {
    const afterParty = withVoice(
      row({
        eventKey: AFTER_PARTY_KEY,
        startsAt: new Date("2026-12-01T18:00:00Z"),
        endsAt: new Date("2026-12-01T20:00:00Z"),
        updatedAt: new Date("2026-12-01T21:00:00Z"),
      }),
      DEEP_LINK,
    );
    const body = eventIcs(afterParty, APP_URL);
    expect(locationLine(body)).toBe(DEEP_LINK);
    expect(body).not.toContain(AFTER_PARTY_NAME);
    expect(body).toBe(
      ical(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${AFTER_PARTY_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T210000Z",
        "DTSTART:20261201T180000Z",
        "DTEND:20261201T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        `LOCATION:${DEEP_LINK}`,
        `URL:${APP_URL}/e/${AFTER_PARTY_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
  });

  it("null voiceLocation falls back to the physical location (control)", () => {
    const body = eventIcs(withVoice(row({ location: "Room 3, Community Hall" }), null), APP_URL);
    expect(locationLine(body)).toBe("Room 3\\, Community Hall");
  });

  it("a row without voice state keeps today's behavior (control)", () => {
    expect(locationLine(eventIcs(row(), APP_URL))).toBeUndefined();
    expect(locationLine(eventIcs(row({ location: "Room 3, Community Hall" }), APP_URL))).toBe(
      "Room 3\\, Community Hall",
    );
  });

  it("collection golden covers live + TBD + after-party + physical", () => {
    const live = withVoice(row({ description: "A live community game night." }), DEEP_LINK);
    const tbd = withVoice(row({ eventKey: TBD_KEY }), OPENS_TEXT);
    const afterParty = withVoice(
      row({
        eventKey: AFTER_PARTY_KEY,
        startsAt: new Date("2026-12-01T18:00:00Z"),
        endsAt: new Date("2026-12-01T20:00:00Z"),
        updatedAt: new Date("2026-12-01T21:00:00Z"),
      }),
      DEEP_LINK,
    );
    const physical = row({ eventKey: PHYSICAL_KEY, location: "Room 3, Community Hall" });
    expect(eventsIcsCollection([live, tbd, afterParty, physical], APP_URL)).toBe(
      ical(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TogetherWeOwn//Events//EN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Together We Own Events",
        "X-WR-CALDESC:Upcoming events from Together We Own",
        "BEGIN:VEVENT",
        `UID:${LIVE_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T120000Z",
        "DTSTART:20270101T180000Z",
        "DTEND:20270101T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        "DESCRIPTION:A live community game night.",
        `LOCATION:${DEEP_LINK}`,
        `URL:${APP_URL}/e/${LIVE_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "BEGIN:VEVENT",
        `UID:${TBD_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T120000Z",
        "DTSTART:20270101T180000Z",
        "DTEND:20270101T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        `LOCATION:${OPENS_TEXT}`,
        `URL:${APP_URL}/e/${TBD_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "BEGIN:VEVENT",
        `UID:${AFTER_PARTY_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T210000Z",
        "DTSTART:20261201T180000Z",
        "DTEND:20261201T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        `LOCATION:${DEEP_LINK}`,
        `URL:${APP_URL}/e/${AFTER_PARTY_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "BEGIN:VEVENT",
        `UID:${PHYSICAL_KEY}@next.example.test`,
        "SEQUENCE:90000000",
        "DTSTAMP:20261201T120000Z",
        "DTSTART:20270101T180000Z",
        "DTEND:20270101T200000Z",
        "SUMMARY:Friday Game Night",
        "STATUS:CONFIRMED",
        "LOCATION:Room 3\\, Community Hall",
        `URL:${APP_URL}/e/${PHYSICAL_KEY}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Friday Game Night",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
  });

  it("googleCalendarUrl carries the live link", () => {
    const out = new URL(googleCalendarUrl(withVoice(row(), DEEP_LINK)));
    expect(out.searchParams.get("location")).toBe(DEEP_LINK);
  });

  it("googleCalendarUrl carries the TBD text", () => {
    const out = new URL(googleCalendarUrl(withVoice(row(), OPENS_TEXT)));
    expect(out.searchParams.get("location")).toBe(OPENS_TEXT);
  });

  it("googleCalendarUrl without voice keeps the physical location (control)", () => {
    const out = new URL(googleCalendarUrl(row({ location: "Room 3, Community Hall" })));
    expect(out.searchParams.get("location")).toBe("Room 3, Community Hall");
    expect(new URL(googleCalendarUrl(row())).searchParams.has("location")).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ICS voice link sync (routes + trigger)", () => {
  const NOW = new Date("2026-09-30T12:00:00Z");
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    // Display-cache columns the Builder migration adds; IF NOT EXISTS keeps
    // this file green both before the migration lands and after.
    await fixture.client.unsafe(
      "ALTER TABLE events ADD COLUMN IF NOT EXISTS voice_channel_id text",
    );
    await fixture.client.unsafe(
      "ALTER TABLE events ADD COLUMN IF NOT EXISTS voice_channel_name text",
    );
    await fixture.client.unsafe(
      "ALTER TABLE events ADD COLUMN IF NOT EXISTS voice_tbd_reason text",
    );
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, init, {
      ...env,
      ADMIN_DB: fixture.db,
      SESSION_STORE: createMemorySessionStore(),
    });

  const insert = async (
    overrides: {
      eventKey?: string;
      title?: string;
      description?: string | null;
      location?: string | null;
      startsAt?: Date;
      endsAt?: Date;
      status?: string;
    } = {},
  ) => {
    const [created] = await fixture.db
      .insert(events)
      .values({
        eventKey: LIVE_KEY,
        title: "Friday Game Night",
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        timezone: "UTC",
        status: "published",
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      })
      .returning();
    return created!;
  };

  const setVoice = (
    eventKey: string,
    voice: { id?: string | null; name?: string | null; reason?: string | null },
  ) =>
    fixture.client`
      UPDATE events
      SET voice_channel_id = ${voice.id ?? null},
        voice_channel_name = ${voice.name ?? null},
        voice_tbd_reason = ${voice.reason ?? null}
      WHERE event_key = ${eventKey}`;

  const read = async (eventKey: string) =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, eventKey)))[0]!;

  const downloadLocation = async (eventKey: string): Promise<string | undefined> => {
    const response = await request(`/events/${eventKey}.ics`);
    expect(response.status).toBe(200);
    return locationLine(await response.text());
  };

  it("per-event ICS carries the stable deep link when the channel exists", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const body = await (await request(`/events/${LIVE_KEY}.ics`)).text();
    expect(locationLine(body)).toBe(DEEP_LINK);
    expect(body).not.toContain(LIVE_NAME);
  });

  it("per-event ICS carries TBD text before the channel exists", async () => {
    await insert({ eventKey: TBD_KEY });
    await setVoice(TBD_KEY, { reason: "opens_soon" });
    const location = await downloadLocation(TBD_KEY);
    expect(location).toBe(OPENS_TEXT);
    expect(location).not.toContain("discord.com");
    expect(location).not.toContain(CHANNEL_ID);
  });

  it("per-event ICS keeps the link for the after-party state", async () => {
    await insert({
      eventKey: AFTER_PARTY_KEY,
      startsAt: new Date("2026-12-01T18:00:00Z"),
      endsAt: new Date("2026-12-01T20:00:00Z"),
    });
    await setVoice(AFTER_PARTY_KEY, { id: CHANNEL_ID, name: AFTER_PARTY_NAME });
    const body = await (await request(`/events/${AFTER_PARTY_KEY}.ics`)).text();
    expect(locationLine(body)).toBe(DEEP_LINK);
    expect(body).not.toContain(AFTER_PARTY_NAME);
  });

  it("collection feed mixes live, TBD and physical locations", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    await insert({ eventKey: TBD_KEY });
    await setVoice(TBD_KEY, { reason: "opens_soon" });
    await insert({ eventKey: PHYSICAL_KEY, location: "Room 3, Community Hall" });
    const response = await request("/events.ics");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`LOCATION:${DEEP_LINK}`);
    expect(body).toContain(`LOCATION:${OPENS_TEXT}`);
    expect(body).toContain("LOCATION:Room 3\\, Community Hall");
    expect(body).not.toContain(LIVE_NAME);
  });

  it("rename-only channel update keeps LOCATION bytes and the ETag", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const first = await request(`/events/${LIVE_KEY}.ics`);
    const etag = first.headers.get("etag")!;
    const before = await first.text();
    expect(locationLine(before)).toBe(DEEP_LINK);
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: AFTER_PARTY_NAME });
    const second = await request(`/events/${LIVE_KEY}.ics`);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe(before);
    expect(
      (await request(`/events/${LIVE_KEY}.ics`, { headers: { "if-none-match": etag } })).status,
    ).toBe(304);
  });

  it("TBD text is static across tbd reasons (guard)", async () => {
    await insert({ eventKey: TBD_KEY });
    await setVoice(TBD_KEY, { reason: "opens_soon" });
    const opensSoon = await downloadLocation(TBD_KEY);
    await setVoice(TBD_KEY, { reason: "rate_limited" });
    expect(await downloadLocation(TBD_KEY)).toBe(opensSoon);
    expect(opensSoon).toBe(OPENS_TEXT);
  });

  it("physical location passes through without voice cache (control)", async () => {
    await insert({ eventKey: PHYSICAL_KEY, location: "Room 3, Community Hall" });
    expect(await downloadLocation(PHYSICAL_KEY)).toBe("Room 3\\, Community Hall");
  });

  it("event detail GCal link carries the live voice link", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const response = await request(`/e/${LIVE_KEY}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="event-google-calendar"');
    expect(html).toContain(
      "location=https%3A%2F%2Fdiscord.com%2Fchannels%2F326474832151838730%2F100000000000000131",
    );
    expect(html).not.toContain(LIVE_NAME);
  });

  it("event detail GCal link carries the TBD text", async () => {
    await insert();
    await setVoice(LIVE_KEY, { reason: "opens_soon" });
    const response = await request(`/e/${LIVE_KEY}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="event-google-calendar"');
    expect(html).toContain(`location=${encodeURIComponent(OPENS_TEXT)}`);
  });

  it("trigger: starts_at change bumps (control)", async () => {
    await insert();
    const before = await read(LIVE_KEY);
    await fixture.client`UPDATE events SET starts_at = '2027-02-01 18:00:00+00' WHERE event_key = ${LIVE_KEY}`;
    expect((await read(LIVE_KEY)).icsSequence).toBeGreaterThan(before.icsSequence);
  });

  it("trigger: link NULL->set bumps (control)", async () => {
    await insert();
    await setVoice(LIVE_KEY, { reason: "opens_soon" });
    const before = await read(LIVE_KEY);
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    expect((await read(LIVE_KEY)).icsSequence).toBeGreaterThan(before.icsSequence);
  });

  it("trigger: link set->NULL bumps (control)", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const before = await read(LIVE_KEY);
    await setVoice(LIVE_KEY, { reason: "unavailable" });
    expect((await read(LIVE_KEY)).icsSequence).toBeGreaterThan(before.icsSequence);
  });

  it("trigger: voice name-only change does not bump", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const before = await read(LIVE_KEY);
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: AFTER_PARTY_NAME });
    expect((await read(LIVE_KEY)).icsSequence).toBe(before.icsSequence);
  });

  it("trigger: title-only change does not bump", async () => {
    await insert();
    const before = await read(LIVE_KEY);
    await fixture.client`UPDATE events SET title = 'Renamed Game Night' WHERE event_key = ${LIVE_KEY}`;
    expect((await read(LIVE_KEY)).icsSequence).toBe(before.icsSequence);
  });

  it("trigger: description-only change does not bump", async () => {
    await insert();
    const before = await read(LIVE_KEY);
    await fixture.client`UPDATE events SET description = 'New blurb' WHERE event_key = ${LIVE_KEY}`;
    expect((await read(LIVE_KEY)).icsSequence).toBe(before.icsSequence);
  });

  it("trigger: rename plus start-time change still bumps (control)", async () => {
    await insert();
    await setVoice(LIVE_KEY, { id: CHANNEL_ID, name: LIVE_NAME });
    const before = await read(LIVE_KEY);
    await fixture.client`
      UPDATE events
      SET starts_at = '2027-02-01 18:00:00+00', voice_channel_name = ${AFTER_PARTY_NAME}
      WHERE event_key = ${LIVE_KEY}`;
    expect((await read(LIVE_KEY)).icsSequence).toBeGreaterThan(before.icsSequence);
  });
});
