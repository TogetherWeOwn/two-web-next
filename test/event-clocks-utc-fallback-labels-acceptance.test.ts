// route-inventory: GET /events/past
// Acceptance: event clocks label UTC fallbacks honestly (schedule + archive).
//
// Locked contract (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// A stored zone Intl rejects (or a blank one) already computes its wall
// clock as UTC on the card helpers. The dishonesty is the label beside that
// clock: upcoming cards, archive cards (Hono + Kit) and the event-list
// Markdown print the rejected stored string as if the clock were computed
// in it. The fix is one shared effective-zone authority:
// - Invalid/blank zones label UTC, never the rejected zone name. The wall
//   clock shown is the UTC reading of the same instant: on CalCard the
//   existing card label computed in UTC; on archive/Markdown either the
//   existing ISO-instant fallback text or the equivalent full UTC format —
//   both name the UTC reading, and Hono/Kit must agree with each other.
// - calendarZone ignores invalid/absent zones BEFORE modal selection: an
//   invalid majority must not beat a valid minority, and UTC is the answer
//   only when no valid choice remains. Deterministic first-seen tie order
//   among valid zones is preserved.
// - Valid zones and valid aliases (e.g. US/Eastern) keep their exact stored
//   label and wall clock, byte-for-byte. Stored zones are never rewritten,
//   UTC `datetime` instants never move, and detail-Markdown behavior (which
//   already labels UTC) stays as it is.
//
// Coverage: the real CalCard renderer, the real archive route/read/render
// path on both twins (Hono page + compiled Svelte EventCard), the real
// Markdown list builder, and the shared calendarZone helper. Fixtures are
// synthetic in-memory rows only — no database, no network.
//
// RED proof: every RED test fails on base HEAD for the missing behavior
// (bogus/blank label printed, or invalid modal winner collapsing to UTC);
// CONTROL tests pass before and after, proving the fixtures are live.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mdEvent, mdEvents, type MdEvent } from "../src/ai-friendly/md";
import { calendarZone } from "../src/events/date-format";
import { CalCard } from "../src/events/pages-calendar-card";
import type { PublicEvent } from "../src/events/reads";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  archiveReadFixture,
  archiveRow,
  archiveTwins,
  compileArchiveKit,
  requestArchive,
  type ArchiveTwin,
} from "./helpers/past-archive-search-acceptance";
import app from "./app";

const APP_URL = "https://clocks.example.test";
const BOGUS = "Bogus/Zone";

// Summer instant where UTC (19:00), London BST (20:00) and US Eastern
// (15:00) all disagree, so a mis-labelled clock cannot hide.
const SUMMER = new Date("2026-07-15T19:00:00Z");

function cardRow(over: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "game-night-1",
    title: "Game night",
    game: null,
    description: null,
    startsAt: SUMMER,
    endsAt: new Date(SUMMER.getTime() + 7200_000),
    timezone: "Europe/London",
    location: null,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
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
    createdAt: SUMMER,
    updatedAt: SUMMER,
    syncRevision: 1,
    syncedRevision: 0,
    goingCount: 0,
    goingOccupancy: 0,
    ...over,
  } as PublicEvent;
}

function renderCard(e: PublicEvent, zone = "UTC"): string {
  return CalCard({
    e,
    zone,
    now: new Date("2026-07-01T12:00:00Z"),
    isPast: false,
    member: true,
    inviteUrl: "https://discord.gg/example",
    loginReturnTo: null,
  })!.toString() as string;
}

/** Visible texts of every <time> element, in document order. */
function timeTexts(html: string): string[] {
  return [...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map((m) => m[1]!.trim());
}

function datetimeAttrs(html: string): string[] {
  return [...html.matchAll(/<time[^>]*\bdatetime="([^"]+)"/g)].map((m) => m[1]!);
}

/** The zone label: the first <span> after the last </time> in the fragment. */
function zoneLabel(html: string): string | null {
  const afterTimes = html.slice(html.lastIndexOf("</time>") + "</time>".length);
  const m = /<span[^>]*>([^<]*)<\/span>/.exec(afterTimes);
  return m ? m[1]!.trim() : null;
}

describe("calendarZone: invalid zones never win the modal pick", () => {
  it("RED: an invalid majority loses to a valid minority", () => {
    expect(calendarZone([BOGUS, BOGUS, "Europe/London"])).toBe("Europe/London");
    expect(calendarZone([BOGUS, "Also/Bad", BOGUS, "America/New_York", "Also/Bad"])).toBe(
      "America/New_York",
    );
  });

  it("RED: blank zones are ignored before counting, not counted as a zone", () => {
    expect(calendarZone(["   ", "   ", "Europe/Paris"])).toBe("Europe/Paris");
    expect(calendarZone(["", null, undefined, "Pacific/Auckland"])).toBe("Pacific/Auckland");
  });

  it("RED: a valid zone tied with an invalid one wins regardless of order", () => {
    expect(calendarZone([BOGUS, "Europe/London"])).toBe("Europe/London");
    expect(calendarZone(["Europe/London", BOGUS])).toBe("Europe/London");
  });

  it("CONTROL: ties among valid zones keep deterministic first-seen order", () => {
    expect(calendarZone(["Europe/London", "America/New_York"])).toBe("Europe/London");
    expect(calendarZone(["America/New_York", "Europe/London"])).toBe("America/New_York");
    expect(
      calendarZone(["America/New_York", "Europe/London", "Europe/London", "America/New_York"]),
    ).toBe("America/New_York");
  });

  it("CONTROL: UTC only when no valid choice remains", () => {
    expect(calendarZone([])).toBe("UTC");
    expect(calendarZone([null, undefined, ""])).toBe("UTC");
    expect(calendarZone([BOGUS, "Also/Bad"])).toBe("UTC");
  });

  it("CONTROL: a valid majority wins and a valid alias keeps its exact stored name", () => {
    expect(calendarZone(["Europe/London", "America/New_York", "Europe/London"])).toBe(
      "Europe/London",
    );
    expect(calendarZone(["US/Eastern", "Europe/London", "US/Eastern"])).toBe("US/Eastern");
  });
});

describe("Hono CalCard (upcoming): the label matches the computed clock", () => {
  it("RED: an invalid stored zone labels UTC beside the UTC wall clock", () => {
    const e = cardRow({ timezone: BOGUS });
    const html = renderCard(e);
    expect(html).not.toContain(BOGUS);
    expect(zoneLabel(html), "passing condition: zone span reads UTC").toBe("UTC");
    // Both the start and the same-day end read as UTC wall times.
    expect(timeTexts(html)).toEqual(["Wed 15 Jul, 19:00", "21:00"]);
    // The machine instant and the stored zone are untouched by rendering.
    expect(datetimeAttrs(html)[0]).toBe(SUMMER.toISOString());
    expect(e.timezone).toBe(BOGUS);
  });

  it.each(["", "   "])("RED: a blank stored zone (%j) labels UTC at the year boundary", (tz) => {
    const startsAt = new Date("2026-12-31T23:30:00Z");
    const html = renderCard(
      cardRow({
        timezone: tz,
        startsAt,
        endsAt: new Date("2027-01-01T00:30:00Z"),
      }),
    );
    expect(zoneLabel(html), "passing condition: zone span reads UTC").toBe("UTC");
    // 23:30Z on 31 Dec in UTC — never rolled into 2027 by a rejected zone.
    expect(timeTexts(html)[0]).toBe("Thu 31 Dec, 23:30");
    expect(datetimeAttrs(html)[0]).toBe(startsAt.toISOString());
  });

  it("CONTROL: a valid zone keeps its label and DST wall clock (spring forward)", () => {
    // 01:30Z on 29 Mar 2026 is 02:30 BST — London has sprung forward.
    const startsAt = new Date("2026-03-29T01:30:00Z");
    const html = renderCard(
      cardRow({ timezone: "Europe/London", startsAt, endsAt: new Date("2026-03-29T03:30:00Z") }),
    );
    expect(zoneLabel(html)).toBe("Europe/London");
    expect(timeTexts(html)).toEqual(["Sun 29 Mar, 02:30", "04:30"]);
    expect(datetimeAttrs(html)[0]).toBe(startsAt.toISOString());
  });

  it("CONTROL: a valid alias keeps its exact stored label and wall clock", () => {
    const html = renderCard(cardRow({ timezone: "US/Eastern" }));
    expect(zoneLabel(html)).toBe("US/Eastern");
    expect(timeTexts(html)).toEqual(["Wed 15 Jul, 15:00", "17:00"]);
  });
});

describe("archive twins (Hono page + Kit EventCard): honest UTC labels", () => {
  let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
  beforeAll(async () => {
    kit = await compileArchiveKit();
  }, 60_000);
  afterAll(() => kit?.dispose());
  beforeEach(() => {
    __resetAnonEventCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ARCHIVE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function archiveCard(twin: ArchiveTwin, row: PublicEvent): Promise<string> {
    const fx = archiveReadFixture();
    fx.replaceRows([row]);
    const res =
      twin === "Hono"
        ? await app.request(new Request(`${ARCHIVE_ORIGIN}/events/past`), {}, fx.env)
        : await requestArchive(twin, "/events/past", fx.env, kit);
    expect(res.status).toBe(200);
    const html = await res.text();
    const card = new RegExp(`<li[^>]*data-event-key="${row.eventKey}"[\\s\\S]*?</li>`).exec(
      html,
    )?.[0];
    expect(card, `${twin} archive renders the fixture card`).toBeDefined();
    return card!;
  }

  const pastRow = (over: Partial<PublicEvent>): PublicEvent =>
    archiveRow(701, {
      title: "Archive clock night",
      startsAt: SUMMER,
      endsAt: new Date(SUMMER.getTime() + 7200_000),
      ...over,
    });

  it.each(archiveTwins)(
    "RED (%s): an invalid stored zone labels UTC, never the bogus name",
    async (twin) => {
      const card = await archiveCard(twin, pastRow({ timezone: BOGUS }));
      expect(card).not.toContain(BOGUS);
      expect(zoneLabel(card), `passing condition (${twin}): zone span reads UTC`).toBe("UTC");
      expect(datetimeAttrs(card)[0]).toBe(SUMMER.toISOString());
      // The visible clock names the UTC reading: the existing ISO fallback or
      // the equivalent full UTC format — never a non-UTC wall time.
      expect([SUMMER.toISOString(), "Wednesday, 15 July 2026 at 19:00"]).toContain(
        timeTexts(card)[0],
      );
    },
  );

  it.each(archiveTwins)("RED (%s): a blank stored zone labels UTC", async (twin) => {
    const card = await archiveCard(twin, pastRow({ timezone: "" }));
    expect(zoneLabel(card), `passing condition (${twin}): zone span reads UTC`).toBe("UTC");
    expect(datetimeAttrs(card)[0]).toBe(SUMMER.toISOString());
  });

  it.each(archiveTwins)(
    "CONTROL (%s): a valid zone keeps its label and wall clock byte-for-byte",
    async (twin) => {
      const card = await archiveCard(twin, pastRow({ timezone: "Europe/London" }));
      expect(zoneLabel(card)).toBe("Europe/London");
      expect(timeTexts(card)[0]).toBe("Wednesday, 15 July 2026 at 20:00");
      expect(datetimeAttrs(card)[0]).toBe(SUMMER.toISOString());
    },
  );

  it("RED: Hono and Kit archive cards agree on clock and label for an invalid zone", async () => {
    const row = pastRow({ timezone: BOGUS });
    const hono = await archiveCard("Hono", row);
    const kitCard = await archiveCard("Kit", row);
    expect([timeTexts(kitCard)[0], zoneLabel(kitCard)]).toEqual([
      timeTexts(hono)[0],
      zoneLabel(hono),
    ]);
    expect(zoneLabel(hono)).toBe("UTC");
  });
});

describe("event-list Markdown: the (zone) suffix matches the computed clock", () => {
  const mdRow = (over: Partial<MdEvent> = {}): MdEvent => ({
    eventKey: "01H0000000000000000000ABCD",
    title: "Clock night",
    game: null,
    description: null,
    startsAt: SUMMER,
    endsAt: new Date(SUMMER.getTime() + 7200_000),
    timezone: "Europe/London",
    location: null,
    capacity: null,
    goingCount: null,
    goingOccupancy: null,
    status: "published",
    ...over,
  });

  const whenLine = (body: string): string => {
    const line = body.split("\n").find((l) => l.startsWith("- When: "));
    expect(line, "event list renders a When line").toBeDefined();
    return line!;
  };

  it("RED: an invalid stored zone reads (UTC), never the bogus name", () => {
    const body = mdEvents(APP_URL, [mdRow({ timezone: BOGUS })]);
    expect(body).not.toContain(BOGUS);
    const line = whenLine(body);
    expect(line.endsWith(" (UTC)"), `passing condition: When line ends (UTC), got: ${line}`).toBe(
      true,
    );
    // The clock before the suffix names the UTC reading of the instant.
    const clock = line.slice("- When: ".length, -" (UTC)".length);
    expect([SUMMER.toISOString(), "Wednesday, 15 July 2026 at 19:00"]).toContain(clock);
  });

  it.each(["", "   "])("RED: a blank stored zone (%j) reads (UTC)", (tz) => {
    const line = whenLine(mdEvents(APP_URL, [mdRow({ timezone: tz })]));
    expect(line.endsWith(" (UTC)"), `passing condition: When line ends (UTC), got: ${line}`).toBe(
      true,
    );
  });

  it("CONTROL: a valid zone keeps its exact When line", () => {
    expect(whenLine(mdEvents(APP_URL, [mdRow()]))).toBe(
      "- When: Wednesday, 15 July 2026 at 20:00 (Europe/London)",
    );
  });

  it("CONTROL: a valid alias keeps its exact stored name in the suffix", () => {
    expect(whenLine(mdEvents(APP_URL, [mdRow({ timezone: "US/Eastern" })]))).toBe(
      "- When: Wednesday, 15 July 2026 at 15:00 (US/Eastern)",
    );
  });

  it("CONTROL: per-event detail Markdown already labels UTC and stays unchanged", () => {
    const body = mdEvent(APP_URL, mdRow({ timezone: BOGUS, goingCount: 0 }));
    expect(body).not.toContain(BOGUS);
    const starts = body.split("\n").find((l) => l.startsWith("- Starts: "));
    expect(starts, "detail renders a Starts line").toBeDefined();
    expect(starts!.endsWith(" (UTC)")).toBe(true);
  });
});
