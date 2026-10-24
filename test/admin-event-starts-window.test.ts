import { describe, expect, it } from "vitest";
import {
  eventListParams,
  eventListUrl,
  eventStartsBounds,
  eventStartsWindowSummary,
  parseEventListQuery,
  parseEventStartsWindow,
} from "../src/admin/event-list";

describe("event starts window authority (no DB)", () => {
  it("is absent for ordinary and empty-bound requests", () => {
    expect(parseEventListQuery({}).startsWindow).toBeUndefined();
    expect(
      parseEventListQuery({ starts_from: "", starts_before: "" }).startsWindow,
    ).toBeUndefined();
    expect("startsWindow" in parseEventListQuery({})).toBe(false);
  });

  it("maps canonical dates to half-open UTC midnights, either bound optional", () => {
    const window = parseEventStartsWindow("2032-02-29", "2032-03-02");
    expect(window).toEqual({ from: "2032-02-29", before: "2032-03-02" });
    const bounds = eventStartsBounds(window)!;
    expect(bounds.from?.toISOString()).toBe("2032-02-29T00:00:00.000Z");
    expect(bounds.before?.toISOString()).toBe("2032-03-02T00:00:00.000Z");
    expect(eventStartsBounds(parseEventStartsWindow("", "0001-01-01"))!.from).toBeNull();
    expect(eventStartsBounds(parseEventStartsWindow("0001-01-01", ""))!.from?.toISOString()).toBe(
      "0001-01-01T00:00:00.000Z",
    );
    expect(eventStartsBounds(parseEventStartsWindow("9999-12-31", undefined))!.before).toBeNull();
  });

  it.each([
    "2031-02-29",
    "1900-02-29",
    "2100-02-29",
    "2032-04-31",
    "2032-00-10",
    "2032-13-10",
    "2032-01-00",
    "0000-01-01",
    "2032-2-9",
    "2032-02-29T00:00:00Z",
    "２０３２-02-29",
    "2".repeat(300),
  ])("refuses %s without reflecting it", (value) => {
    const window = parseEventStartsWindow(value, undefined)!;
    expect(window.error).toMatch(/valid calendar dates/);
    expect(window.from).toBeUndefined();
    expect(window.error).not.toContain(value);
    expect(eventStartsBounds(window)).toBeNull();
  });

  it("accepts real leap days including century rule 2000", () => {
    expect(parseEventStartsWindow("2000-02-29", undefined)).toEqual({ from: "2000-02-29" });
    expect(parseEventStartsWindow("2032-02-29", undefined)).toEqual({ from: "2032-02-29" });
  });

  it("refuses equal and reversed bounds but keeps them for correction", () => {
    for (const [from, before] of [
      ["2032-03-02", "2032-02-29"],
      ["2032-02-29", "2032-02-29"],
    ]) {
      const window = parseEventStartsWindow(from, before)!;
      expect(window.error).toMatch(/before Starts before/);
      expect(window).toMatchObject({ from, before });
      expect(eventStartsBounds(window)).toBeNull();
    }
  });

  it("refuses repeated parameters, even identical or empty ones", () => {
    const window = eventListParams(
      new URLSearchParams("starts_from=&starts_from=2032-02-29&q=a&q=b"),
    );
    expect(window.q).toBe("a");
    expect(parseEventListQuery(window).startsWindow?.error).toMatch(/only once/);
    expect(
      parseEventListQuery(
        eventListParams(new URLSearchParams("starts_before=2032-03-02&starts_before=2032-03-02")),
      ).startsWindow?.error,
    ).toMatch(/only once/);
  });

  it("retains normalized bounds in links and drops refused values", () => {
    const query = parseEventListQuery({
      starts_from: "2032-02-29",
      starts_before: "2032-03-02",
      page: "2",
    });
    const url = new URL(eventListUrl(query, { page: 3 }), "https://next.example.test");
    expect(url.searchParams.get("starts_from")).toBe("2032-02-29");
    expect(url.searchParams.get("starts_before")).toBe("2032-03-02");
    expect(url.searchParams.get("page")).toBe("3");
    const bad = parseEventListQuery({ starts_from: "nope", starts_before: "2032-03-02" });
    const badUrl = new URL(eventListUrl(bad), "https://next.example.test");
    expect(badUrl.searchParams.has("starts_from")).toBe(false);
    expect(badUrl.searchParams.get("starts_before")).toBe("2032-03-02");
  });

  it("describes the interval without implying a refused window matched", () => {
    expect(eventStartsWindowSummary(parseEventStartsWindow("2032-02-29", "2032-03-02"))).toBe(
      "Showing events that start at or after 2032-02-29 00:00 UTC (included) and before 2032-03-02 00:00 UTC (excluded). Event times below stay in UTC.",
    );
    expect(eventStartsWindowSummary(parseEventStartsWindow("2032-03-02", "2032-02-29"))).toBeNull();
    expect(eventStartsWindowSummary(undefined)).toBeNull();
  });
});
