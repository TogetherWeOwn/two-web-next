// route-inventory: GET /events
// route-inventory: GET /events/past
// Failing-first acceptance: visible calendar search scope + past-card
// zone/location (roadmap S3).
//
// Owned by the Test Author; the Builder builds on this branch and never edits
// this file. Hermetic pg-proxy fixtures + the compiled Kit archive binding:
// no DATABASE_URL, no network. RED tests fail on the base HEAD (no hint
// association, past cards carry a bare time); CONTROL tests pass before and
// after, proving the fixtures are live and the preserved contract holds.
//
// Builder contract:
// - Hono calendar search: add a persistent VISIBLE scope hint and tie it to
//   the search input with aria-describedby. The hint id and exact copy are
//   the Builder's choice, except the hint text must name the searched scope:
//   titles and descriptions. Label, placeholder, testids, debounce and the
//   island binder stay unchanged; the hint renders in every calendar state
//   (plain, searching, month grid). Kit has no schedule-index search page,
//   so the hint half is Hono-only.
// - Past cards on both twins: extend the time line to the upcoming-card
//   shape (time · zone · location) using the row's timezone/location. The
//   zone label and location strings must render identically on both twins
//   for shared fixtures. A missing location renders cleanly: no dangling or
//   doubled separators, no empty spans. Time formatting itself is not pinned
//   here — only the zone/location facts and their order (zone, then location).
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  CALENDAR_DAY_TESTID,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_LIST_TESTID,
  EVENTS_SEARCH_DEBOUNCE_MS,
  EVENTS_SEARCH_LABEL,
  EVENTS_SEARCH_PLACEHOLDER,
  EVENTS_SEARCH_TESTID,
  EVENT_CARD_TESTID,
  WEEKDAY_HEADINGS,
} from "../src/islands/contracts";
import app from "./app";
import {
  ARCHIVE_NOW,
  archiveReadFixture,
  archiveRow,
  archiveTwins,
  compileArchiveKit,
  type ArchiveTwin,
} from "./helpers/past-archive-search-acceptance";

vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

const CALENDAR_ORIGIN = "https://scope.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const INVITE = "https://discord.gg/example";

const VENUE_KEY = "scope-past-venue";
const BARE_KEY = "scope-past-bare";
const PAST_TZ = "Europe/London";
const PAST_LOCATION = "The Brass Room";
const BARE_TZ = "America/New_York";

const UPCOMING_KEY = "scope-upcoming-1";
const UPCOMING_TZ = "Europe/London";
const UPCOMING_LOCATION = "The Mezzanine";

type EventRow = typeof events.$inferSelect;

let rowSeq = 1000;
function calendarRow(over: Partial<EventRow> = {}): EventRow {
  const n = ++rowSeq;
  const startsAt = over.startsAt ?? new Date("2030-03-10T19:00:00Z");
  const endsAt = over.endsAt ?? new Date("2030-03-10T21:00:00Z");
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `scope-cal-${n}`,
    title: `Scope night ${n}`,
    game: null,
    description: null,
    startsAt,
    endsAt,
    timezone: UPCOMING_TZ,
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
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
    createdAt: startsAt,
    updatedAt: startsAt,
    ...over,
  };
}

// Compact calendar read fixture (same dispatch shape as the island calendar
// suite): past vs upcoming by the boundary operator, LIKE term honored,
// counts answered from the filtered set. Search logging is mocked above.
function calendarFixture(up: EventRow[], past: EventRow[]) {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((key) => (row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]));
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    let rows = /"ends_at" </.test(sql) ? past : up;
    if (sql.includes("'draft'")) rows = rows.filter((row) => row.status !== "draft");
    const bound = params.find(
      (param): param is string =>
        typeof param === "string" && param.startsWith("%") && param.endsWith("%"),
    );
    if (bound) {
      const term = bound.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      rows = rows.filter(
        (row) =>
          row.title.toLowerCase().includes(term) ||
          (row.description ?? "").toLowerCase().includes(term),
      );
    }
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    if (sql.includes("limit")) rows = rows.slice(0, Number(params.at(-1)));
    return { rows: rows.map(encode) };
  });
  const env = {
    APP_URL: CALENDAR_ORIGIN,
    SESSION_SECRET,
    DISCORD_INVITE_URL: INVITE,
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
  return { env, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

function venueRows() {
  return [
    archiveRow(201, {
      eventKey: VENUE_KEY,
      title: "Scope night with venue",
      timezone: PAST_TZ,
      location: PAST_LOCATION,
    }),
    archiveRow(202, {
      eventKey: BARE_KEY,
      title: "Scope night bare room",
      timezone: BARE_TZ,
      location: null,
    }),
  ];
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The search input tag, wherever the screen renders it.
function searchInput(html: string): string {
  const match = html.match(new RegExp(`<input\\b[^>]*data-testid="${EVENTS_SEARCH_TESTID}"[^>]*>`));
  expect(match, "calendar search input is rendered").not.toBeNull();
  return match![0];
}

// The ids the search input points at via aria-describedby (may be several).
function describedIds(input: string): string[] {
  const match = input.match(/\baria-describedby="([^"]+)"/);
  expect(match, "search input carries aria-describedby").not.toBeNull();
  return match![1]!.split(/\s+/).filter((id) => id.length > 0);
}

// Inner markup of the element with the given id (first match wins).
function elementById(html: string, id: string): { attrs: string; inner: string } | null {
  const match = html.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)</\\1>`),
  );
  if (!match) return null;
  return { attrs: match[2]!, inner: match[3]! };
}

// The <li> card block for one event key (same root on both twins).
function cardBlock(html: string, key: string): string {
  const anchor = html.indexOf(`data-event-key="${key}"`);
  expect(anchor, `card for ${key} is rendered`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<li", anchor), html.indexOf("</li>", anchor));
}

// First paragraph of the card: the time line on both twins today.
function timeParagraph(card: string): string {
  const match = card.match(/<p>([\s\S]*?)<\/p>/);
  expect(match, "card carries a time paragraph").not.toBeNull();
  return match![1]!;
}

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
}, 60_000);
afterAll(() => kit?.dispose());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RED: visible search scope on the Hono calendar", () => {
  it("ties the search input to its hint via aria-describedby", async () => {
    const { request } = calendarFixture([], []);
    const html = await (await request("/events")).text();
    const ids = describedIds(searchInput(html));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(elementById(html, id), `hint element #${id} exists`).not.toBeNull();
    }
  });

  it("shows a visible hint naming the searched scope", async () => {
    const { request } = calendarFixture([], []);
    const html = await (await request("/events")).text();
    const ids = describedIds(searchInput(html));
    const hints = ids
      .map((id) => elementById(html, id))
      .filter((el) => el !== null)
      .map((el) => ({ ...el, text: stripTags(el.inner).toLowerCase() }));
    const hint = hints.find((el) => el.text.includes("title") && el.text.includes("description"));
    expect(hint, "one describedby target names titles and descriptions").toBeDefined();
    expect(hint!.attrs).not.toMatch(/\bsr-only\b/);
    expect(hint!.attrs).not.toMatch(/\bhidden\b/);
    expect(hint!.attrs).not.toContain("aria-hidden");
    expect(stripTags(hint!.inner).length).toBeGreaterThan(0);
  });

  it.each(["/events?q=raid", "/events?view=calendar&month=2030-03"])(
    "keeps the hint association in every calendar state (%s)",
    async (path) => {
      const upcoming = [
        calendarRow({
          eventKey: UPCOMING_KEY,
          title: "Raid planning",
          location: UPCOMING_LOCATION,
        }),
      ];
      const { request } = calendarFixture(upcoming, []);
      const response = await request(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      const ids = describedIds(searchInput(html));
      const texts = ids.map((id) => stripTags(elementById(html, id)?.inner ?? "").toLowerCase());
      expect(
        texts.some((text) => text.includes("title") && text.includes("description")),
        "hint still names the scope",
      ).toBe(true);
    },
  );
});

describe("RED: past-card zone and location on both twins", () => {
  it("Hono past card shows zone + location in the upcoming shape", async () => {
    const source = archiveReadFixture();
    source.replaceRows(venueRows());
    const response = await app.request(
      new Request("https://archive.example.test/events/past"),
      {},
      source.env,
    );
    expect(response.status).toBe(200);
    const card = cardBlock(await response.text(), VENUE_KEY);
    const time = stripTags(timeParagraph(card));
    expect(time).toContain(PAST_TZ);
    expect(time).toContain(PAST_LOCATION);
    expect(time).toContain("·");
    expect(time.indexOf(PAST_TZ)).toBeLessThan(time.indexOf(PAST_LOCATION));
  });

  it("Kit past card shows the identical zone + location for the shared fixture", async () => {
    const source = archiveReadFixture();
    source.replaceRows(venueRows());
    const [hono, kitResponse] = await Promise.all([
      app.request(new Request("https://archive.example.test/events/past"), {}, source.env),
      (async () => {
        const { dispatchPastArchiveRequest } = await import("../src/kit-past-events");
        return dispatchPastArchiveRequest(
          new Request("https://archive.example.test/events/past"),
          source.env,
          () => kit.request(new Request("https://archive.example.test/events/past"), source.env),
        );
      })(),
    ]);
    expect(hono.status).toBe(200);
    expect(kitResponse.status).toBe(200);
    const honoTime = stripTags(timeParagraph(cardBlock(await hono.text(), VENUE_KEY)));
    const kitTime = stripTags(timeParagraph(cardBlock(await kitResponse.text(), VENUE_KEY)));
    for (const [name, text] of [
      ["Hono", honoTime],
      ["Kit", kitTime],
    ] as const) {
      expect(text, `${name} shows the zone label`).toContain(PAST_TZ);
      expect(text, `${name} shows the location`).toContain(PAST_LOCATION);
      expect(text.indexOf(PAST_TZ)).toBeLessThan(text.indexOf(PAST_LOCATION));
    }
  });

  it.each(archiveTwins)("a missing location renders cleanly on %s", async (twin: ArchiveTwin) => {
    const source = archiveReadFixture();
    source.replaceRows(venueRows());
    const url = "https://archive.example.test/events/past";
    const response =
      twin === "Hono"
        ? await app.request(new Request(url), {}, source.env)
        : await (async () => {
            const { dispatchPastArchiveRequest } = await import("../src/kit-past-events");
            return dispatchPastArchiveRequest(new Request(url), source.env, () =>
              kit.request(new Request(url), source.env),
            );
          })();
    expect(response.status).toBe(200);
    const card = cardBlock(await response.text(), BARE_KEY);
    expect(stripTags(timeParagraph(card))).toContain(BARE_TZ);
    const text = stripTags(card);
    expect(text).not.toMatch(/·\s*·/);
    expect(text).not.toMatch(/·\s*$/);
    expect(card).not.toMatch(/<span>\s*<\/span>/);
  });
});

describe("CONTROL: preserved calendar + archive contract", () => {
  it("keeps the search label, placeholder, testids and form shape", async () => {
    const { request } = calendarFixture([], []);
    const html = await (await request("/events")).text();
    const input = searchInput(html);
    expect(input).toContain(`placeholder="${EVENTS_SEARCH_PLACEHOLDER}"`);
    expect(input).toContain(`aria-label="${EVENTS_SEARCH_LABEL}"`);
    expect(input).toContain('type="search"');
    expect(input).toContain('name="q"');
    expect(input).toContain('id="events-search-input"');
    expect(html).toContain(`<label class="sr-only" for="events-search-input">`);
    expect(html).toContain(`<form method="get" action="/events" role="search">`);
    expect(EVENTS_SEARCH_DEBOUNCE_MS).toBe(300);
  });

  it("keeps the upcoming-card shape, sign-in destination and canonical", async () => {
    const upcoming = [
      calendarRow({
        eventKey: UPCOMING_KEY,
        title: "Scope upcoming",
        game: "Chess",
        timezone: UPCOMING_TZ,
        location: UPCOMING_LOCATION,
      }),
    ];
    const { request } = calendarFixture(upcoming, []);
    const html = await (await request("/events")).text();
    expect(html).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
    const card = cardBlock(html, UPCOMING_KEY);
    expect(card).toContain(`data-testid="${EVENT_CARD_TESTID}"`);
    expect(card).toContain("<time datetime=");
    expect(stripTags(card)).toContain(UPCOMING_TZ);
    expect(stripTags(card)).toContain(UPCOMING_LOCATION);
    expect(card).toContain('data-testid="event-going-count"');
    expect(card).toContain('data-testid="signin"');
    expect(card).toContain(`/join/discord?next=${encodeURIComponent("/events")}`);
    expect(card).toContain(EVENTS_EMPTY_COPY.signIn);
    expect(html).toContain(`<link rel="canonical" href="${CALENDAR_ORIGIN}/events"`);
  });

  it("keeps the month grid, fragment zones and live regions", async () => {
    // One row inside the requested wall month: an empty schedule renders the
    // never-empty state instead of the grid.
    const upcoming = [calendarRow({ startsAt: new Date("2030-03-10T19:00:00Z") })];
    const { request } = calendarFixture(upcoming, []);
    const html = await (await request("/events?view=calendar&month=2030-03")).text();
    for (const heading of WEEKDAY_HEADINGS) {
      expect(html).toContain(heading);
    }
    expect(html).toContain(`data-testid="${EVENTS_CALENDAR_GRID_TESTID}"`);
    expect(html).toContain(`data-testid="${CALENDAR_DAY_TESTID}"`);
    expect(html).toContain('data-cal-zone="head"');
    expect(html).toContain('data-cal-zone="actions"');
    expect(html).toContain("data-cal-feedback");
  });

  it.each(archiveTwins)("renders the shared archive fixtures on %s", async (twin: ArchiveTwin) => {
    const source = archiveReadFixture();
    source.replaceRows(venueRows());
    const url = "https://archive.example.test/events/past";
    const response =
      twin === "Hono"
        ? await app.request(new Request(url), {}, source.env)
        : await (async () => {
            const { dispatchPastArchiveRequest } = await import("../src/kit-past-events");
            return dispatchPastArchiveRequest(new Request(url), source.env, () =>
              kit.request(new Request(url), source.env),
            );
          })();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`data-event-key="${VENUE_KEY}"`);
    expect(html).toContain(`data-event-key="${BARE_KEY}"`);
    expect(html).toContain('data-total-pages="1"');
    expect(html).toContain("schedule-attendance");
  });
});
