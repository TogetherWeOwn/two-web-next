// Month-grid links expose complete event names.
// DB-free: real SSR shells rendered directly.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  calendarJumpUrl,
  cardDayLabel,
  gridTitle,
  wallDateIso,
  wallMonth,
  wallTimeHm,
  type CalendarEmptyState,
  type CalendarState,
  type DiscordTransient,
} from "../src/islands/contracts";
import { rowKey } from "../src/events/pages-calendar-row";

const APP_URL = "https://next.example.test";
const ZONE = "Europe/London";

function persisted(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-15T20:00:00Z");
  const base: PublicEvent = {
    id: 1,
    icsSequence: 1n,
    eventKey: "ev-1",
    title: "Game night",
    game: null,
    description: null,
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
    timezone: ZONE,
    location: null,
    capacity: null,
    status: "published",
    rsvpOpen: true,
    goingCount: 0,
    goingOccupancy: 0,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
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
    updatedAt: start,
  };
  return { ...base, ...overrides };
}

function transient(overrides: Partial<DiscordTransient> = {}): DiscordTransient {
  const startsAt = new Date("2030-01-15T20:00:00Z");
  const base: DiscordTransient = {
    discordId: "t1",
    status: "scheduled",
    title: "Discord raid",
    description: null,
    location: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3600_000),
  };
  return { ...base, ...overrides };
}

async function renderGrid(upcoming: (PublicEvent | DiscordTransient)[]): Promise<string> {
  const state: CalendarState = {
    view: "calendar",
    month: "2030-01",
    q: "",
    game: "",
    past: false,
    page: 1,
    weekStart: "monday",
  };
  return jsx(EventsCalendarPage, {
    state,
    upcoming,
    past: [],
    zone: ZONE,
    now: new Date("2030-01-01T12:00:00Z"),
    totalPages: 1,
    emptyState: null as CalendarEmptyState,
    discordFailed: false,
    games: [],
    gameFilter: null,
    member: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: APP_URL,
  }).toString();
}

interface GridLink {
  href: string;
  attrs: string;
  visible: string;
}

function gridLinks(html: string): GridLink[] {
  const links: GridLink[] = [];
  const re = /<a([^>]*?)data-cal-jump([^>]*?)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Rejoin around the marker the pattern consumes so presence checks see it.
    const attrs = `${m[1] ?? ""}data-cal-jump${m[2] ?? ""}`;
    const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
    links.push({ href, attrs, visible: (m[3] ?? "").trim() });
  }
  return links;
}

const ariaOf = (attrs: string): string | null => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? null;

// WCAG 2.5.3: speech-input users say the visible words, so the name must start with them.
function expectNameLeadsWithVisible(name: string, link: GridLink): void {
  // Strip nested markup (the availability suffix node): speech users say the
  // visible words, not the tags. A manual scan, not a tag-matching regex:
  // rendered titles are escaped, so the only literal brackets are real tags.
  let words = "";
  let rest = link.visible;
  for (;;) {
    const open = rest.indexOf("<");
    if (open === -1) {
      words += rest;
      break;
    }
    words += rest.slice(0, open);
    const close = rest.indexOf(">", open + 1);
    if (close === -1) {
      words += rest.slice(open);
      break;
    }
    rest = rest.slice(close + 1);
  }
  const lead = words.replace(/…$/, "");
  expect(name.slice(0, lead.length)).toBe(lead);
}

describe("month grid accessible names", () => {
  it("gives same-time same-prefix persisted rows distinct accessible names with full title + day/time", async () => {
    const prefix = "Game night spectacular raid evening";
    const a = persisted({
      id: 1,
      eventKey: "ev-alpha",
      title: `${prefix} alpha Hobbiton`,
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    const b = persisted({
      id: 2,
      eventKey: "ev-beta",
      title: `${prefix} beta Rivendell`,
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    // Prove the collision is real in visible text: same clock, same truncation.
    expect(wallTimeHm(a.startsAt, ZONE)).toBe(wallTimeHm(b.startsAt, ZONE));
    expect(gridTitle(a.title)).toBe(gridTitle(b.title));

    const html = await renderGrid([a, b]);
    const links = gridLinks(html);
    expect(links).toHaveLength(2);
    const names = links.map((l) => ariaOf(l.attrs));
    // A removed full-name attribute/text alternative must fail: names required.
    expect(names[0]).not.toBeNull();
    expect(names[1]).not.toBeNull();
    expect(names[0]).not.toBe(names[1]);
    for (const [e, link] of [
      [a, links[0]!],
      [b, links[1]!],
    ] as const) {
      const name = ariaOf(link.attrs)!;
      // Complete title, not the truncated visible label.
      expect(name).toContain(e.title);
      expect(name.length).toBeGreaterThan(link.visible.length);
      expectNameLeadsWithVisible(name, link);
      // Useful day context follows the title.
      expect(name).toContain(wallTimeHm(e.startsAt, ZONE));
      expect(name).toContain(cardDayLabel(e.startsAt, ZONE));
      // Compact visible label plus the uncapped availability suffix.
      expect(link.visible).toBe(
        `${wallTimeHm(e.startsAt, ZONE)} ${gridTitle(e.title)} <span data-testid="event-schedule-availability">No seat limit</span>`,
      );
      // Link target / jump behavior unchanged.
      expect(link.href).toBe(calendarJumpUrl(false, rowKey(e)));
      expect(link.attrs).toContain("data-cal-jump");
    }
  });

  it("covers Discord-native rows, Unicode and escaped punctuation without markup interpretation", async () => {
    const uni = persisted({
      id: 3,
      eventKey: "ev-unicode",
      title: "🎲 Raid nacht — naïve dragon Über alles nye 猟師 ∀x ∃y",
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    const evilTitle = `Raid <script>alert("x")</script> & "quoted" 'solo' %_\\ end of a very long title here`;
    const evil = persisted({
      id: 4,
      eventKey: "ev-evil",
      title: evilTitle,
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    const d = transient({
      discordId: "discord-1",
      title: "Discord spectacular raid evening extravaganza with a very long tail gamma",
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    const html = await renderGrid([uni, evil, d]);
    // No title is interpreted as markup: raw tags never appear, escaped form does.
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    const links = gridLinks(html);
    expect(links).toHaveLength(3);
    const byHref = new Map(links.map((l) => [l.href, l]));
    const uniLink = byHref.get(calendarJumpUrl(false, rowKey(uni)))!;
    expect(ariaOf(uniLink.attrs)).toContain(uni.title);
    expectNameLeadsWithVisible(ariaOf(uniLink.attrs)!, uniLink);
    const evilLink = byHref.get(calendarJumpUrl(false, rowKey(evil)))!;
    const evilName = ariaOf(evilLink.attrs)!;
    expectNameLeadsWithVisible(evilName, evilLink);
    // Escaped punctuation survives as text (decoded form keeps every character).
    expect(evilName).toContain("&quot;");
    expect(evilName).not.toContain("<script>");
    expect(evilName).toContain("quoted");
    const dLink = byHref.get(calendarJumpUrl(false, rowKey(d)))!;
    const dName = ariaOf(dLink.attrs)!;
    expect(dName).toContain(d.title);
    expectNameLeadsWithVisible(dName, dLink);
    expect(dName).toContain(wallTimeHm(d.startsAt, ZONE));
    expect(dName).toContain(cardDayLabel(d.startsAt, ZONE));
    expect(dLink.visible).toBe(
      `${wallTimeHm(d.startsAt, ZONE)} ${gridTitle(d.title)} <span data-testid="event-schedule-availability">Discord-managed</span>`,
    );
  });

  it("keeps the names and link targets on consecutive month pages", async () => {
    const jan = persisted({
      id: 5,
      eventKey: "ev-jan",
      title: "January spectacular raid evening with a very long tail delta",
      startsAt: new Date("2030-01-15T20:00:00Z"),
    });
    const febStart = new Date("2030-02-12T19:30:00Z");
    const feb = persisted({
      id: 6,
      eventKey: "ev-feb",
      title: "February spectacular raid evening with a very long tail epsilon",
      startsAt: febStart,
    });
    const janHtml = await renderGrid([jan]);
    // The binder patches server HTML verbatim (not executed here), so each month page must carry the names.
    const febState: CalendarState = {
      view: "calendar",
      month: "2030-02",
      q: "",
      game: "",
      past: false,
      page: 1,
      weekStart: "monday",
    };
    const febHtml = await jsx(EventsCalendarPage, {
      state: febState,
      upcoming: [feb],
      past: [],
      zone: ZONE,
      now: new Date("2030-01-01T12:00:00Z"),
      totalPages: 1,
      emptyState: null as CalendarEmptyState,
      discordFailed: false,
      games: [],
      gameFilter: null,
      member: false,
      inviteUrl: "https://discord.gg/fixture",
      appUrl: APP_URL,
    }).toString();
    for (const [e, html] of [
      [jan, janHtml],
      [feb, febHtml],
    ] as const) {
      const links = gridLinks(html);
      expect(links).toHaveLength(1);
      const name = ariaOf(links[0]!.attrs)!;
      expect(name).toContain(e.title);
      expectNameLeadsWithVisible(name, links[0]!);
      expect(name).toContain(cardDayLabel(e.startsAt, ZONE));
      expect(links[0]!.href).toBe(calendarJumpUrl(false, rowKey(e)));
      expect(links[0]!.attrs).toContain("data-cal-jump");
    }
    // No-JS behavior and geometry: real anchors into the list, one table grid,
    // day cells keep their dates.
    expect(janHtml).toContain('data-testid="events-calendar-grid"');
    expect(janHtml).toContain(`data-date="${wallDateIso(jan.startsAt, ZONE)}"`);
    expect(febHtml).toContain(`data-date="${wallDateIso(feb.startsAt, ZONE)}"`);
    expect(febHtml).toContain(`month=${wallMonth(febStart, ZONE)}`);
  });

  it("names a persisted row by its own zone, matching the visible time and the cell day", async () => {
    const ny = persisted({
      id: 7,
      eventKey: "ev-ny",
      title: "NY raid night",
      timezone: "America/New_York",
      startsAt: new Date("2030-01-15T01:00:00Z"),
      // One NY wall day: multi-day intervals intentionally occupy every
      // touched day, so the zone-naming assertion needs a same-day end.
      endsAt: new Date("2030-01-15T02:00:00Z"),
    });
    const html = await renderGrid([ny]);
    const links = gridLinks(html);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.visible).toBe(
      '20:00 NY raid night <span data-testid="event-schedule-availability">No seat limit</span>',
    );
    expect(ariaOf(link.attrs)).toBe("20:00 NY raid night No seat limit, Mon 14 Jan");
    const cell = new RegExp(`<td[^>]*data-date="2030-01-14"[^>]*>([\\s\\S]*?)</td>`).exec(
      html,
    )![1]!;
    expect(cell).toContain(
      '>20:00 NY raid night <span data-testid="event-schedule-availability">No seat limit</span></a>',
    );
  });
});
