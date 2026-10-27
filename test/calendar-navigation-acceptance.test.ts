import { describe, expect, it } from "vitest";
import { calendarShowingPast, calendarUrl } from "../src/islands/contracts";
import {
  attribute,
  elements,
  firstPageName,
  hidePastName,
  lastPageName,
  links,
  navigationHtml,
  navigationState,
  params,
  text,
} from "./helpers/calendar-navigation-acceptance";

// Missing/reversed destinations, state loss, a closable search drawer, and a
// false current-page announcement are the breaks these independent oracles catch.
for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: schedule navigation acceptance`, () => {
    it.each(["list", "calendar"] as const)(
      "closes a manually opened %s preview with a native state-preserving link",
      async (view) => {
        const html = await navigationHtml(twin, { view, past: true });
        const hide = links(html).filter((link) => hidePastName.test(link.name));
        expect(hide).toHaveLength(1);
        expect(params(hide[0]!.href)).toEqual({
          path: "/events",
          search:
            view === "calendar"
              ? { game: "Co-op", view: "calendar", month: "2060-07" }
              : { game: "Co-op", page: "3" },
          hash: "",
        });
        expect(html).toContain("Past navigation fixture");
        const closed = await navigationHtml(twin, { view, past: false });
        expect(closed).not.toContain("Past navigation fixture");
        expect(links(closed).some((link) => /show past events/i.test(link.name))).toBe(true);
        expect(links(closed).some((link) => hidePastName.test(link.name))).toBe(false);
      },
    );

    it.each([false, true])(
      "search forces the preview open without a misleading hide control (past=%s)",
      async (past) => {
        const html = await navigationHtml(twin, { q: "fixture", past });
        expect(html).toContain("Past navigation fixture");
        expect(links(html).some((link) => hidePastName.test(link.name))).toBe(false);
        const continuation = links(html).find((link) =>
          /continue search in past events/i.test(link.name),
        );
        expect(continuation).toBeDefined();
        expect(params(continuation!.href)).toEqual({
          path: "/events/past",
          search: { q: "fixture" },
          hash: "",
        });
      },
    );

    it("whitespace-only search is a manually closable preview, not a forced search", async () => {
      const html = await navigationHtml(twin, { q: " \t ", past: true });
      const hide = links(html).find((link) => hidePastName.test(link.name));
      expect(hide).toBeDefined();
      expect(params(hide!.href).search).toEqual({ game: "Co-op", page: "3" });
    });

    it.each([
      { page: 1, total: 7, first: false, last: true },
      { page: 3, total: 7, first: true, last: true },
      { page: 7, total: 7, first: true, last: false },
      { page: 1, total: 2, first: false, last: true },
      { page: 2, total: 2, first: true, last: false },
      { page: 1, total: 1, first: false, last: false },
      { page: 1, total: 0, first: false, last: false },
    ])(
      "offers only meaningful boundaries at page $page of $total",
      async ({ page, total, first, last }) => {
        const html = await navigationHtml(
          twin,
          { page, past: true, q: "fixture" },
          total,
          total === 0,
        );
        const all = links(html);
        const firstLinks = all.filter((link) => firstPageName.test(link.name));
        const lastLinks = all.filter((link) => lastPageName.test(link.name));
        expect(firstLinks).toHaveLength(first ? 1 : 0);
        expect(lastLinks).toHaveLength(last ? 1 : 0);
        if (first)
          expect(params(firstLinks[0]!.href)).toEqual({
            path: "/events",
            search: { q: "fixture", game: "Co-op", past: "1" },
            hash: "",
          });
        if (last)
          expect(params(lastLinks[0]!.href)).toEqual({
            path: "/events",
            search: { q: "fixture", game: "Co-op", past: "1", page: String(total) },
            hash: "",
          });
        expect(
          all.some(
            (link) =>
              new URL(link.href, "https://calendar.example.test").searchParams.get("page") === "0",
          ),
        ).toBe(false);
      },
    );

    it("returns directly from a far out-of-range request without claiming the last page is current", async () => {
      const html = await navigationHtml(twin, { page: 999, past: true, q: "fixture" }, 7, true);
      const first = links(html).filter((link) => firstPageName.test(link.name));
      expect(first).toHaveLength(1);
      expect(params(first[0]!.href)).toEqual({
        path: "/events",
        search: { q: "fixture", game: "Co-op", past: "1" },
        hash: "",
      });
      expect(html).toContain("Page 999 is outside the schedule");
    });

    it("does not announce the last valid page as current on an unavailable request", async () => {
      const html = await navigationHtml(twin, { page: 999 }, 7, true);
      expect(html).toContain("Page 999 is outside the schedule");
      // Site/view navigation can legitimately be current; only the list pager
      // must not claim that an unavailable request is the last valid page.
      const pager = elements(html, "nav").filter(
        (node) => attribute(node, "data-testid") === "events-pager",
      );
      expect(pager.map(text).join(" ")).not.toMatch(/Page 7 of 7/);
    });

    it("does not put list-boundary actions into a month grid", async () => {
      const html = await navigationHtml(twin, { view: "calendar", past: true });
      expect(
        links(html).some((link) => firstPageName.test(link.name) || lastPageName.test(link.name)),
      ).toBe(false);
    });
  });
}

describe("shared state authority controls", () => {
  it("omits page one and closed past while retaining the normalized game", () => {
    expect(calendarUrl({ ...navigationState, game: " Co-op ", page: 1, past: false })).toBe(
      "/events?game=Co-op",
    );
    expect(calendarUrl({ ...navigationState, view: "calendar", past: false })).toBe(
      "/events?game=Co-op&view=calendar&month=2060-07",
    );
  });
  it("never closes nonblank search matches merely by clearing the manual flag", () => {
    expect(calendarShowingPast({ ...navigationState, q: "fixture", past: false })).toBe(true);
    expect(calendarShowingPast({ ...navigationState, q: " \t ", past: false })).toBe(false);
  });
});
