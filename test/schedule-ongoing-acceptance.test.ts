// Local fixtures only. Run: env -u DATABASE_URL npx vitest run test/schedule-ongoing-acceptance.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOKABLE,
  DISCORD_MANAGED,
  FULL,
  KEY,
  PAUSED,
  PAST,
  TWO_LEFT,
  UNLIMITED,
  discordEvent,
  model,
  render,
} from "./fixtures/schedule-availability";
import {
  END,
  MID,
  ONGOING,
  START,
  attribute,
  clientSurface,
  ongoingEvent,
  scheduleEntries,
  visibleText,
} from "./helpers/event-ongoing-acceptance";

// Breaks caught: exclusive start, inclusive end, start-only/clock-only verdicts,
// treating RSVP availability as clock state, or leaking draft/cancelled labels.
const cases = [
  {
    name: "mid-event keeps two occupancy-derived seats",
    row: ongoingEvent(),
    now: MID,
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "ongoing and paused coexist",
    row: ongoingEvent({ rsvpOpen: false }),
    now: MID,
    ongoing: true,
    availability: PAUSED,
  },
  {
    name: "ongoing and full coexist",
    row: ongoingEvent({ goingOccupancy: 10 }),
    now: MID,
    ongoing: true,
    availability: FULL,
  },
  {
    name: "ongoing uncapped stays uncapped",
    row: ongoingEvent({ capacity: null }),
    now: MID,
    ongoing: true,
    availability: UNLIMITED,
  },
  {
    name: "exactly at start is ongoing",
    row: ongoingEvent(),
    now: START,
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "one millisecond before start is not ongoing",
    row: ongoingEvent(),
    now: new Date("2035-10-20T10:59:59.999Z"),
    ongoing: false,
    availability: TWO_LEFT,
  },
  {
    name: "one millisecond before end is still ongoing",
    row: ongoingEvent(),
    now: new Date("2035-10-20T12:59:59.999Z"),
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "exactly at end ended wins",
    row: ongoingEvent(),
    now: END,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "elapsed end wins over paused",
    row: ongoingEvent({ rsvpOpen: false }),
    now: END,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "elapsed end wins over full",
    row: ongoingEvent({ goingOccupancy: 10 }),
    now: END,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "cancelled interval has no ongoing label",
    row: ongoingEvent({ status: "cancelled" }),
    now: MID,
    ongoing: false,
    availability: /\bcancelled\b/i,
  },
  {
    name: "draft interval has no ongoing label",
    row: ongoingEvent({ status: "draft" }),
    now: MID,
    ongoing: false,
    availability: null,
  },
  {
    name: "explicit past status wins inside interval",
    row: ongoingEvent({ status: "past" }),
    now: MID,
    ongoing: false,
    availability: PAST,
  },
];

// Discord's active status, not the elapsed scheduled start, is its authoritative
// signal. Active rows may lack an announced end; a known end still wins.
const transients = [
  {
    name: "active inside interval",
    over: { status: "active", startsAt: START, endsAt: END },
    ongoing: true,
  },
  {
    name: "scheduled inside interval is not active",
    over: { status: "scheduled", startsAt: START, endsAt: END },
    ongoing: false,
  },
  {
    name: "active without an end",
    over: { status: "active", startsAt: START, endsAt: null },
    ongoing: true,
  },
  {
    name: "active status wins over a stale future scheduled start",
    over: { status: "active", startsAt: new Date("2035-10-20T12:30:00Z"), endsAt: END },
    ongoing: true,
  },
  {
    name: "known end wins over active status",
    over: { status: "active", startsAt: START, endsAt: MID },
    ongoing: false,
  },
] as const;

afterEach(() => vi.restoreAllMocks());

for (const target of ["Hono", "Kit"] as const) {
  for (const view of ["list", "calendar"] as const) {
    describe(`${target} ${view} ongoing snapshot`, () => {
      it.each(cases)("$name", async ({ row, now, ongoing, availability }) => {
        const html = await render({ ...model([row], { view }), now }, target);
        for (const entry of scheduleEntries(html, KEY, view)) {
          const visible = visibleText(entry);
          expect.soft(ONGOING.test(visible), visible).toBe(ongoing);
          if (availability) expect.soft(visible).toMatch(availability);
          if (view === "calendar") {
            const accessible = attribute(entry, "aria-label");
            expect(accessible).toBeDefined();
            expect.soft(ONGOING.test(accessible!), accessible).toBe(ongoing);
            if (availability) expect.soft(accessible!).toMatch(availability);
            // WCAG label-in-name: adding a badge must not make visible words
            // disappear from the grid link's explicit accessible name.
            expect.soft(accessible!.replace(/\s+/g, " ")).toContain(visible);
          }
          if (availability === PAST || availability === PAUSED || availability === FULL) {
            expect.soft(visible).not.toMatch(BOOKABLE);
          }
        }
      });

      it.each(transients)(
        "Discord $name retains Discord-managed truth",
        async ({ over, ongoing }) => {
          const row = { ...discordEvent(), ...over };
          const html = await render(model([row], { view }), target);
          for (const entry of scheduleEntries(html, `discord-${row.discordId}`, view)) {
            const visible = visibleText(entry);
            expect.soft(ONGOING.test(visible), visible).toBe(ongoing);
            expect.soft(visible).toMatch(DISCORD_MANAGED);
            expect.soft(visible).not.toMatch(BOOKABLE);
            if (view === "calendar") {
              const accessible = attribute(entry, "aria-label")!;
              expect.soft(ONGOING.test(accessible), accessible).toBe(ongoing);
              expect.soft(accessible).toMatch(DISCORD_MANAGED);
            }
          }
        },
      );

      it("multi-day continuation entries carry the same clock and availability truth", async () => {
        const row = ongoingEvent({
          startsAt: new Date("2035-10-19T23:00:00Z"),
          endsAt: new Date("2035-10-21T01:00:00Z"),
        });
        const html = await render(model([row], { view }), target);
        const entries = scheduleEntries(html, KEY, view);
        expect(entries).toHaveLength(view === "calendar" ? 3 : 1);
        for (const entry of entries) {
          expect.soft(visibleText(entry)).toMatch(ONGOING);
          expect.soft(visibleText(entry)).toMatch(TWO_LEFT);
          if (view === "calendar") expect.soft(attribute(entry, "aria-label")!).toMatch(ONGOING);
        }
      });

      it("CONTROL: snapshot render adds no network, timers, handlers or client island", async () => {
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("No external reads allowed"));
        const timeout = vi.spyOn(globalThis, "setTimeout");
        const interval = vi.spyOn(globalThis, "setInterval");
        const html = await render(model([ongoingEvent()], { view }), target);
        const surface = clientSurface(html);
        expect(surface.scripts).toEqual([
          { src: "/islands/copy-link.js", body: "" },
          { src: "/islands/events-calendar.js", body: "" },
        ]);
        expect(surface.islands).toEqual(["events-calendar"]);
        expect(surface.handlers).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
      });
    });
  }
}
