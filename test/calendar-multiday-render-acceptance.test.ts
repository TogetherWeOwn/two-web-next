// Test-Author-owned interval/render acceptance. Read/query correctness is
// covered separately by real SQL; these fixtures exercise both real screens.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordTransient } from "../src/islands/contracts";
import {
  calendarLinks,
  gathering,
  gatheringKey,
  gatheringTitle,
  intervalCases,
  renderCalendar,
} from "./helpers/calendar-multiday-acceptance";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const appUrl = "https://calendar.example.test";

// Live persisted entries carry bounded schedule origin scalars; parse the URL so
// a lost or wrong origin fails without relaxing the native path/anchor target.
function expectEntryUrl(
  href: string,
  path: string,
  hash: string,
  params: [string, string][],
): void {
  const url = new URL(href, appUrl);
  expect(href.startsWith("/")).toBe(true);
  expect(url.origin).toBe(appUrl);
  expect(url.pathname).toBe(path);
  expect(url.hash).toBe(hash);
  expect([...url.searchParams].sort()).toEqual([...params].sort());
}

function detailHrefs(html: string, eventKey: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)]
    .map((match) => match[1]!.replaceAll("&amp;", "&"))
    .filter((href) => new URL(href, appUrl).pathname === `/e/${eventKey}`);
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: canonical interval day membership`, () => {
    it.each(intervalCases)("plots $name on the hand-derived host days only", async (fixture) => {
      const row = gathering({
        startsAt: new Date(fixture.start),
        endsAt: new Date(fixture.end),
        timezone: fixture.zone,
      });
      // The page zone deliberately disagrees: canonical rows own their host
      // zone; the viewer/page zone must not redefine their occupied days.
      const html = await renderCalendar(twin, [row], { month: fixture.month, zone: "Asia/Tokyo" });
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(fixture.days);
      expect(new Set(links.map((link) => link.day)).size).toBe(links.length);
      for (const link of links)
        expectEntryUrl(link.href, "/events", `#event-${gatheringKey}`, [
          ["event", gatheringKey],
          ["schedulePage", "1"],
          ["scheduleView", "calendar"],
          ["scheduleMonth", fixture.month],
        ]);
    });

    it("labels a continuation rather than announcing the original start again", async () => {
      const html = await renderCalendar(twin, [gathering()]);
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(["2027-02-14", "2027-02-15"]);
      expect(links[0]!.text).toContain("23:30");
      expect(links[0]!.text).not.toContain("Continues");
      const next = links[1]!;
      expect(next.text).toContain("Continues");
      expect(next.text).toContain("Multi-day");
      expect(next.text).not.toContain("23:30");
      expect(next.name).toContain("Continues");
      expect(next.name).toContain(gatheringTitle);
      expect(next.name).toContain("Monday");
      expect(next.name).toContain("15 February 2027");
      expect(next.name).not.toContain("14 February");
      expect(next.name).not.toBe(links[0]!.name);
    });

    it("renders only continuations when the original start is outside the grid", async () => {
      const html = await renderCalendar(twin, [
        gathering({
          startsAt: new Date("2027-01-20T23:30:00Z"),
          endsAt: new Date("2027-02-03T00:00:00Z"),
        }),
      ]);
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(["2027-02-01", "2027-02-02"]);
      for (const link of links) {
        expect(link.text).toContain("Continues");
        expect(link.name).toContain("Continues");
        expect(link.name).not.toContain("20 January");
      }
      expect(links[0]!.name).toContain("1 February 2027");
      expect(links[1]!.name).toContain("2 February 2027");
    });

    it("keeps one canonical list card and unique document IDs, not one card per day", async () => {
      const row = gathering();
      const grid = await renderCalendar(twin, [row]);
      const list = await renderCalendar(twin, [row], { view: "list" });
      expect(calendarLinks(grid)).toHaveLength(2);
      expect([...list.matchAll(/data-testid="event-card"/g)]).toHaveLength(1);
      expect([...list.matchAll(new RegExp(`id="event-${gatheringKey}"`, "g"))]).toHaveLength(1);
      const details = detailHrefs(list, gatheringKey);
      expect(details).toHaveLength(1);
      expectEntryUrl(details[0]!, `/e/${gatheringKey}`, "", [["schedulePage", "1"]]);
      for (const html of [grid, list]) {
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });

    it("clips millennia to the grid before walking daily Date values", async () => {
      const NativeDate = Date;
      const row = gathering({
        startsAt: new NativeDate("0100-01-01T00:00:00Z"),
        endsAt: new NativeDate("9999-12-01T00:00:00Z"),
      });
      let dateWork = 0;
      // A work bound, not a wall-clock assertion. Observe allocation AND
      // in-place wall-day stepping, so reusing one Date cannot hide the walk.
      const tick = () => {
        dateWork += 1;
        if (dateWork > 2000)
          throw new Error("Interval iteration exceeded 2000 Date operations for a 28-cell grid");
      };
      const utcStep = NativeDate.prototype.setUTCDate;
      const localStep = NativeDate.prototype.setDate;
      vi.spyOn(NativeDate.prototype, "setUTCDate").mockImplementation(function (this: Date, day) {
        tick();
        return utcStep.call(this, day);
      });
      vi.spyOn(NativeDate.prototype, "setDate").mockImplementation(function (this: Date, day) {
        tick();
        return localStep.call(this, day);
      });
      vi.stubGlobal(
        "Date",
        new Proxy(NativeDate, {
          construct(target, args) {
            tick();
            return Reflect.construct(target, args);
          },
        }),
      );
      const html = await renderCalendar(twin, [row]);
      expect(dateWork).toBeLessThanOrEqual(2000);
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(
        Array.from({ length: 28 }, (_, n) => `2027-02-${String(n + 1).padStart(2, "0")}`),
      );
      expect(links.every((link) => link.text.includes("Continues"))).toBe(true);
    });

    it("does not expand a Discord-transient interval or invent an unknown end", async () => {
      const transient: DiscordTransient = {
        discordId: "discord-only",
        status: "active",
        title: "Discord transient",
        description: null,
        location: null,
        startsAt: new Date("2027-02-14T23:30:00Z"),
        endsAt: new Date("2027-02-16T01:00:00Z"),
      };
      for (const row of [transient, { ...transient, endsAt: null }]) {
        const html = await renderCalendar(twin, [row]);
        const links = calendarLinks(html);
        expect(links.map((link) => link.day)).toEqual(["2027-02-14"]);
        expect(links[0]!.text).not.toContain("Continues");
        expect(html).not.toContain('href="/e/discord-only"');
      }
    });

    it("retains each stored recurrence occurrence's identity when expanding its interval", async () => {
      const parent = gathering({
        recurrenceFrequency: "weekly",
        recurrenceCount: 2,
        recurrenceIndex: 1,
      });
      const child = gathering({
        id: 2,
        eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        startsAt: new Date("2027-02-21T23:30:00Z"),
        endsAt: new Date("2027-02-22T01:00:00Z"),
        parentEventId: 1,
        recurrenceIndex: 2,
      });
      const links = calendarLinks(await renderCalendar(twin, [parent, child]));
      expect(
        links.map((link) => [
          link.day,
          new URL(link.href, "https://calendar.example.test").searchParams.get("event"),
        ]),
      ).toEqual([
        ["2027-02-14", parent.eventKey],
        ["2027-02-15", parent.eventKey],
        ["2027-02-21", child.eventKey],
        ["2027-02-22", child.eventKey],
      ]);
      const list = await renderCalendar(twin, [parent, child], { view: "list" });
      expect([...list.matchAll(/data-testid="event-card"/g)]).toHaveLength(2);
      expect([...list.matchAll(new RegExp(`id="event-${parent.eventKey}"`, "g"))]).toHaveLength(1);
      expect([...list.matchAll(new RegExp(`id="event-${child.eventKey}"`, "g"))]).toHaveLength(1);
    });
  });
}
