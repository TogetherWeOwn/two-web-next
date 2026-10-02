// Calendar-year contract and real Hono /events SSR on synthetic sources only.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { registerEventRoutes } from "../src/events/routes";
import {
  addCalendarMonth,
  calendarMonthLabel,
  monthGrid,
  parseCalendarMonth,
  wallDateIso,
  wallMonth,
  type CalendarDay,
  type DiscordTransient,
} from "../src/islands/contracts";

function expectFullWeeks(days: CalendarDay[]) {
  expect(days.length % 7).toBe(0);
  expect(new Date(`${days[0]!.iso}T00:00:00Z`).getUTCDay()).toBe(1);
  expect(new Date(`${days.at(-1)!.iso}T00:00:00Z`).getUTCDay()).toBe(0);
  for (const [i, day] of days.entries()) {
    const date = new Date(`${day.iso}T00:00:00Z`);
    expect(date.toISOString().split("T")[0]).toBe(day.iso);
    if (i > 0) {
      expect(date.getTime() - new Date(`${days[i - 1]!.iso}T00:00:00Z`).getTime()).toBe(86_400_000);
    }
  }
}

// Active Discord rows can have no announced end. A synthetic past local row
// supplies the host zone when requested; pg-proxy never connects to a real DB.
function calendarFixture(startsAt: Date, zone?: string) {
  const pastStart = new Date("2025-01-15T12:00:00Z");
  const past: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: "zone-fixture",
    title: "Past zone fixture",
    game: null,
    description: null,
    startsAt: pastStart,
    endsAt: new Date("2025-01-15T13:00:00Z"),
    timezone: zone ?? "UTC",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: pastStart,
    updatedAt: pastStart,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql) => ({
    rows:
      zone && /"ends_at" </.test(sql)
        ? [
            columns.map((key) => {
              const value = past[key];
              return value instanceof Date ? value.toISOString() : value;
            }),
          ]
        : [],
  }));
  const event: DiscordTransient = {
    discordId: "123456789",
    status: "active",
    title: "Boundary fixture",
    description: null,
    location: null,
    startsAt,
    endsAt: null,
  };
  const env = {
    APP_URL: "https://calendar.example.test",
    DISCORD_INVITE_URL: "https://discord.gg/example",
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [event], lastReadFailed: () => false },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );
  return (path: string) => app.request(path, undefined, env);
}

function renderedDays(html: string) {
  return [...html.matchAll(/<td\b([^>]*)>/g)].map((match) => ({
    iso: /data-date="([^"]+)"/.exec(match[1]!)![1]!,
    inMonth: !match[1]!.includes('data-outside="true"'),
    isToday: match[1]!.includes('aria-current="date"'),
  }));
}

function monthLink(html: string, label: string) {
  const href = new RegExp(`<a href="([^"]+)" aria-label="${label}"`).exec(html)![1]!;
  return href.replaceAll("&amp;", "&");
}

afterEach(() => vi.useRealTimers());

describe("bounded calendar years", () => {
  it.each([
    ["1-1", "0001-01"],
    ["0099-01", "0099-01"],
    ["99-2", "0099-02"],
    ["0100-01", "0100-01"],
    ["2026-3", "2026-03"],
    ["9999-12", "9999-12"],
  ])("normalizes supported month %s", (raw, expected) => {
    expect(parseCalendarMonth(raw)).toBe(expected);
  });

  it.each([
    "0000-01",
    "0-12",
    "-0001-01",
    "10000-01",
    "9999-13",
    "2026-00",
    "bad",
    "",
    null,
    undefined,
  ])("rejects unsupported month %s for the existing fallback", (raw) => {
    expect(parseCalendarMonth(raw)).toBeNull();
  });

  it.each([
    ["0001-01", -1, "0001-01"],
    ["0001-01", 1, "0001-02"],
    ["0099-12", 1, "0100-01"],
    ["0100-01", -1, "0099-12"],
    ["2026-01", -1, "2025-12"],
    ["2026-12", 1, "2027-01"],
    ["9999-12", -1, "9999-11"],
    ["9999-12", 1, "9999-12"],
    ["2026-01", -999999, "0001-01"],
    ["2026-01", 999999, "9999-12"],
  ])("bounds navigation from %s by %s", (month, delta, expected) => {
    const next = addCalendarMonth(month, delta);
    expect(next).toBe(expected);
    expect(parseCalendarMonth(next)).toBe(next);
  });

  it.each([NaN, Infinity, -Infinity, 0.5])(
    "does not generate a month from non-integer delta %s",
    (delta) => {
      expect(addCalendarMonth("2026-01", delta)).toBe("2026-01");
    },
  );

  it.each([
    ["0001-01", "January 1", 31],
    ["0099-01", "January 99", 31],
    ["0100-01", "January 100", 31],
    ["9999-12", "December 9999", 31],
    ["0096-02", "February 96", 29],
    ["0100-02", "February 100", 28],
    ["2000-02", "February 2000", 29],
    ["2026-02", "February 2026", 28],
    ["2026-01", "January 2026", 31],
    ["2028-02", "February 2028", 29],
  ])("keeps %s label and whole-week day ISO values consistent", (month, label, count) => {
    expect(calendarMonthLabel(month)).toBe(label);
    const today = `${month}-15`;
    const event = { title: "Same date" };
    const weeks = monthGrid(month, today, new Map([[today, [event]]]));
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    const days = weeks.flat();
    expectFullWeeks(days);
    expect(days.filter((day) => day.inMonth).map((day) => day.iso)).toEqual(
      Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
    );
    expect(days.filter((day) => day.isToday).map((day) => day.iso)).toEqual([today]);
    expect(days.find((day) => day.iso === today)!.events).toEqual([event]);
  });

  it("keeps the full expanded ISO date on upper-bound trailing neighbours", () => {
    const days = monthGrid("9999-12", "2026-01-15", new Map()).flat();
    expect(days.slice(-2).map((day) => [day.iso, day.inMonth])).toEqual([
      ["+010000-01-01", false],
      ["+010000-01-02", false],
    ]);
  });

  it.each<[string, string, string, string, string | null]>([
    ["9999-12-31T23:30:00Z", "Etc/GMT-1", "+010000-01-01", "+010000-01", "9999-12"],
    ["0001-01-01T00:30:00Z", "Etc/GMT+1", "0000-12-31", "0000-12", null],
    ["0000-01-01T00:30:00Z", "Etc/GMT+1", "-000001-12-31", "-000001-12", null],
    ["2026-12-31T23:30:00Z", "Etc/GMT-1", "2027-01-01", "2027-01", "2027-01"],
    ["0099-12-31T23:30:00Z", "Etc/GMT-1", "0100-01-01", "0100-01", "0100-01"],
    ["2026-01-15T12:00:00Z", "invalid-zone", "2026-01-15", "2026-01", "2026-01"],
  ])("uses canonical host-zone years for %s in %s", (start, zone, date, month, gridMonth) => {
    const instant = new Date(start);
    const bucket = wallDateIso(instant, zone);
    expect(bucket).toBe(date);
    expect(wallMonth(instant, zone)).toBe(month);
    expect(parseCalendarMonth(wallMonth(instant, zone))).toBe(gridMonth === month ? month : null);
    if (gridMonth) {
      const event = { title: "Host-zone boundary" };
      const days = monthGrid(gridMonth, bucket, new Map([[bucket, [event]]])).flat();
      expect(days.find((day) => day.iso === date)!.events).toEqual([event]);
      expect(days.filter((day) => day.isToday).map((day) => day.iso)).toEqual([date]);
    }
  });

  it.each(["0001", "0099", "0100", "2026", "9999"])(
    "pads host-zone event bucket and default month for year %s",
    (year) => {
      const instant = new Date(`${year}-01-15T12:00:00Z`);
      expect(wallDateIso(instant, "UTC")).toBe(`${year}-01-15`);
      expect(wallMonth(instant, "UTC")).toBe(`${year}-01`);
    },
  );
});

describe("calendar year-boundary Hono SSR", () => {
  it.each([
    ["0001-01", "January 1", "0001-01", "0001-02"],
    ["0099-01", "January 99", "0098-12", "0099-02"],
    ["0099-12", "December 99", "0099-11", "0100-01"],
    ["0100-01", "January 100", "0099-12", "0100-02"],
    ["9999-12", "December 9999", "9999-11", "9999-12"],
  ])(
    "renders %s with matching label, in-month cells, event and supported links",
    async (month, label, previous, next) => {
      const request = calendarFixture(new Date(`${month}-15T12:00:00Z`));
      const response = await request(`/events?view=calendar&month=${month}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`data-month="${month}"`);
      expect(html).toContain(`data-testid="calendar-month">${label}</strong>`);
      expect(html).toContain(`<caption class="sr-only">${label}</caption>`);
      expect(html).toContain(`data-testid="calendar-month-status">${label}</p>`);
      const days = renderedDays(html);
      expect(days.filter((day) => day.inMonth).map((day) => day.iso)).toEqual(
        Array.from({ length: 31 }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
      );
      const eventCell = new RegExp(`<td[^>]*data-date="${month}-15"[^>]*>([\\s\\S]*?)</td>`).exec(
        html,
      )![1]!;
      expect(eventCell).toContain('data-cal-jump="true">12:00 Boundary fixture');
      for (const [direction, expected] of [
        ["Previous month", previous],
        ["Next month", next],
      ]) {
        const link = monthLink(html, direction!);
        expect(new URL(link, "https://calendar.example.test").searchParams.get("month")).toBe(
          expected,
        );
        const navigated = await request(link);
        expect(navigated.status).toBe(200);
        expect(await navigated.text()).toContain(`data-month="${expected}"`);
      }
      if (month === "9999-12") {
        expect(days.slice(-2).map((day) => day.iso)).toEqual(["+010000-01-01", "+010000-01-02"]);
      }
    },
  );

  it.each(["0000-01", "10000-01", "2026-13", "bad"])(
    "preserves bad-month fallback for %s",
    async (raw) => {
      const request = calendarFixture(new Date("2026-01-15T12:00:00Z"));
      const response = await request(`/events?view=calendar&month=${raw}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-month="2026-01"');
      expect(html).toContain('data-testid="calendar-month">January 2026</strong>');
      expect(renderedDays(html).filter((day) => day.inMonth)).toHaveLength(31);
    },
  );

  it.each(["0099-01-15T12:00:00Z", "+010000-01-15T12:00:00Z"])(
    "bounds the implicit first-event month for %s",
    async (start) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
      const response = await calendarFixture(new Date(start))("/events?view=calendar");
      expect(response.status).toBe(200);
      const expected = start.startsWith("0099") ? "0099-01" : "2026-01";
      expect(await response.text()).toContain(`data-month="${expected}"`);
    },
  );

  it("renders a host-year-10000 event and today in the expanded trailing cell", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const instant = new Date("9999-12-31T23:30:00Z");
    vi.setSystemTime(instant);
    const response = await calendarFixture(
      instant,
      "Etc/GMT-1",
    )("/events?view=calendar&month=9999-12");
    expect(response.status).toBe(200);
    const html = await response.text();
    const cell = /<td[^>]*data-date="\+010000-01-01"[^>]*>([\s\S]*?)<\/td>/.exec(html)![1]!;
    expect(cell).toContain('data-cal-jump="true">00:30 Boundary fixture');
    expect(
      renderedDays(html)
        .filter((day) => day.isToday)
        .map((day) => day.iso),
    ).toEqual(["+010000-01-01"]);
  });

  it("falls back for host year zero without aliasing the event into December 0001", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const request = calendarFixture(new Date("0001-01-01T00:30:00Z"), "Etc/GMT+1");
    const response = await request("/events?view=calendar");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-month="2026-01"');
    const december = await request("/events?view=calendar&month=0001-12");
    expect(december.status).toBe(200);
    const cell = /<td[^>]*data-date="0001-12-31"[^>]*>([\s\S]*?)<\/td>/.exec(
      await december.text(),
    )![1]!;
    expect(cell).not.toContain("Boundary fixture");
  });

  it("preserves ordinary 2026 today highlighting and Monday-first rendered weeks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const response = await calendarFixture(new Date("2026-01-15T12:00:00Z"))(
      "/events?view=calendar&month=2026-01",
    );
    expect(response.status).toBe(200);
    const days = renderedDays(await response.text());
    expect(days[0]!.iso).toBe("2025-12-29");
    expect(days.at(-1)!.iso).toBe("2026-02-01");
    expect(days).toHaveLength(35);
    expect(days.filter((day) => day.isToday).map((day) => day.iso)).toEqual(["2026-01-15"]);
  });
});
