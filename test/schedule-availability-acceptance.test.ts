import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOKABLE,
  CANCELLED,
  DISCORD_MANAGED,
  FULL,
  KEY,
  PAUSED,
  PAST,
  TITLE,
  TWO_LEFT,
  UNLIMITED,
  discordEvent,
  event,
  model,
  render,
} from "./fixtures/schedule-availability";

const FINITE_SEATS = /\b-?\d+\s+(?:seats?|spots?|places?)\s+(?:left|remaining|available)\b/i;

function entry(html: string, key: string, view: "list" | "calendar"): string {
  // Inspect the rendered row, not source text or unrelated page chrome.
  const pattern =
    view === "list"
      ? new RegExp(`<article\\b[^>]*id="event-${key}"[^>]*>[\\s\\S]*?</article>`)
      : new RegExp(`<li>\\s*<a\\b[^>]*event=${key}[^>]*>[\\s\\S]*?</li>`);
  const match = html.match(pattern);
  expect(match, `rendered ${view} row ${key}`).not.toBeNull();
  return match![0];
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// These catch absent/incorrect state selection, named-count subtraction, and closed seats
// advertised as bookable. Copy alternatives are semantic; no new CSS or helper API is required.
const cases = [
  {
    name: "open finite uses occupancy 8, not named count 3, for 2 remaining",
    row: event(),
    want: TWO_LEFT,
  },
  {
    name: "one available seat uses singular copy",
    row: event({ goingOccupancy: 9 }),
    want: /\b1\s+(?:seat|spot|place)\s+(?:left|remaining|available)\b/i,
  },
  {
    name: "zero occupancy keeps all ten seats available",
    row: event({ goingCount: 0, goingOccupancy: 0 }),
    want: /\b10\s+(?:seats|spots|places)\s+(?:left|remaining|available)\b/i,
  },
  {
    name: "uncapped open has no invented finite count",
    row: event({ capacity: null }),
    want: UNLIMITED,
  },
  {
    name: "paused finite does not advertise bookable seats",
    row: event({ rsvpOpen: false }),
    want: PAUSED,
  },
  {
    name: "paused uncapped does not advertise open capacity",
    row: event({ rsvpOpen: false, capacity: null }),
    want: PAUSED,
  },
  {
    name: "paused wins over full",
    row: event({ rsvpOpen: false, goingOccupancy: 10 }),
    want: PAUSED,
  },
  {
    name: "full uses occupancy even with three named members",
    row: event({ goingOccupancy: 10 }),
    want: FULL,
  },
  {
    name: "overfull stays full, never negative remaining",
    row: event({ goingOccupancy: 12 }),
    want: FULL,
  },
  {
    name: "cancelled wins over paused and positive capacity",
    row: event({ status: "cancelled", rsvpOpen: false }),
    want: CANCELLED,
  },
  {
    name: "cancelled wins over past and paused",
    row: event({
      status: "cancelled",
      rsvpOpen: false,
      goingOccupancy: 12,
      startsAt: new Date("2035-10-19T18:00:00Z"),
      endsAt: new Date("2035-10-19T20:00:00Z"),
    }),
    want: CANCELLED,
  },
  {
    name: "explicit past status never advertises seats even with a future timestamp",
    row: event({ status: "past" }),
    want: PAST,
  },
  {
    name: "past wins over paused and positive capacity",
    row: event({
      rsvpOpen: false,
      startsAt: new Date("2035-10-19T18:00:00Z"),
      endsAt: new Date("2035-10-19T20:00:00Z"),
    }),
    want: PAST,
  },
  {
    name: "past wins over full or overfull",
    row: event({
      goingOccupancy: 12,
      startsAt: new Date("2035-10-19T18:00:00Z"),
      endsAt: new Date("2035-10-19T20:00:00Z"),
    }),
    want: PAST,
  },
  {
    name: "at the end instant seats are closed",
    row: event({
      startsAt: new Date("2035-10-20T10:00:00Z"),
      endsAt: new Date("2035-10-20T12:00:00Z"),
    }),
    want: PAST,
  },
  {
    name: "ongoing interval is not past just because its start elapsed",
    row: event({
      startsAt: new Date("2035-10-20T11:00:00Z"),
      endsAt: new Date("2035-10-20T13:00:00Z"),
    }),
    want: TWO_LEFT,
  },
];

afterEach(() => vi.restoreAllMocks());

for (const target of ["Hono", "Kit"] as const) {
  for (const view of ["list", "calendar"] as const) {
    describe(`${target} ${view} availability`, () => {
      it.each(cases)("$name", async ({ row, want }) => {
        const visible = text(entry(await render(model([row], { view }), target), KEY, view));
        expect(visible).toMatch(want);
        if (want === PAUSED || want === PAST || want === CANCELLED || want === FULL) {
          expect(visible).not.toMatch(BOOKABLE);
        }
        if (want === CANCELLED || want === PAST) expect(visible).not.toMatch(PAUSED);
        if (want === CANCELLED) expect(visible).not.toMatch(PAST);
        if (want === UNLIMITED) expect(visible).not.toMatch(FINITE_SEATS);
        expect(visible).not.toMatch(/\b-\d+\s+(?:seats?|spots?|places?)/i);
        expect(visible).not.toMatch(/\b(?:guaranteed|reserved|attended|attendance confirmed)\b/i);
      });

      it("Discord-native display-only row describes managed or unknown availability", async () => {
        const html = await render(model([discordEvent()], { view }), target);
        const visible = text(entry(html, "discord-123456789012345678", view));
        expect(visible).toMatch(DISCORD_MANAGED);
        expect(visible).not.toMatch(BOOKABLE);
        expect(visible).not.toMatch(FULL);
        expect(visible).not.toMatch(PAUSED);
      });

      it("CONTROL: keeps title, time, cancellation and real navigation without RSVP mutations", async () => {
        const html = await render(model([event({ status: "cancelled" })], { view }), target);
        const row = entry(html, KEY, view);
        expect(row).toMatch(/18:00/);
        expect(row).toContain(view === "list" ? TITLE : 'aria-label="');
        expect(text(row)).toMatch(CANCELLED);
        expect(row).not.toMatch(/<button|<form|data-island="rsvp-button"/);
        const published = entry(await render(model([event()], { view }), target), KEY, view);
        expect(published).toContain(view === "list" ? `/e/${KEY}` : `event=${KEY}`);
        if (view === "list") expect(text(published)).toMatch(/\b3(?:\s+of\s+10)?\s+going\b/);
      });
    });
  }
}

it("CONTROL: guest sign-in keeps its exact committed return path and paging keeps q/game", async () => {
  const data = model([event({ rsvpOpen: false })], {
    q: "cooperative",
    game: "Deep Rock Galactic",
    page: 2,
  });
  data.loginReturnTo = "/events?q=cooperative&game=Deep+Rock+Galactic&page=2";
  const html = await render(data, "Hono");
  const row = entry(html, KEY, "list");
  expect(row).toContain(
    "/join/discord?next=%2Fevents%3Fq%3Dcooperative%26game%3DDeep%2BRock%2BGalactic%26page%3D2",
  );
  const next = html.match(/<a[^>]*data-testid="events-pager-next"[^>]*>/)?.[0];
  expect(next).toBeDefined();
  expect(next).toContain("q=cooperative");
  expect(next).toContain("game=Deep+Rock+Galactic");
  expect(next).toContain("page=3");
});

it("CONTROL: Hono and Kit preserve the same rendered event entries", async () => {
  for (const view of ["list", "calendar"] as const) {
    const data = model([event(), discordEvent()], { view, game: "Deep Rock Galactic" });
    const hono = await render(data, "Hono");
    const kit = await render(data, "Kit");
    expect(entry(kit, KEY, view)).toBe(entry(hono, KEY, view));
    expect(entry(kit, "discord-123456789012345678", view)).toBe(
      entry(hono, "discord-123456789012345678", view),
    );
  }
});

it("CONTROL: rendering provided rows adds no fetch, timer or RSVP island", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected transport"));
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const interval = vi.spyOn(globalThis, "setInterval");
  for (const target of ["Hono", "Kit"] as const) {
    for (const view of ["list", "calendar"] as const) {
      const html = await render(
        model(
          [
            event(),
            event({ id: 2, eventKey: "01K7MZ00000000000000000002", rsvpOpen: false }),
            discordEvent(),
          ],
          { view },
        ),
        target,
      );
      expect(html).not.toContain('data-island="rsvp-button"');
    }
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
});

it("negative control: changing only occupancy from 8 to 10 changes remaining to full", async () => {
  for (const target of ["Hono", "Kit"] as const) {
    for (const view of ["list", "calendar"] as const) {
      const available = text(entry(await render(model([event()], { view }), target), KEY, view));
      const full = text(
        entry(await render(model([event({ goingOccupancy: 10 })], { view }), target), KEY, view),
      );
      expect(available).toMatch(TWO_LEFT);
      expect(available).not.toMatch(FULL);
      expect(full).toMatch(FULL);
      expect(full).not.toMatch(BOOKABLE);
    }
  }
});
