import { describe, expect, it } from "vitest";
import { resolveCalendarInput } from "../src/events/page-models.server";

describe("framework-neutral calendar page input", () => {
  it("preserves raw search, bounds pages, and forces search into list view", () => {
    expect(
      resolveCalendarInput({ q: "  Night  ", view: "calendar", page: "999999999999999999999" }),
    ).toMatchObject({
      q: "  Night  ",
      searching: true,
      view: "list",
      past: false,
      page: 1,
      jumpKey: "",
    });
  });

  it("defaults invalid views and pages without changing a valid raw query", () => {
    expect(
      resolveCalendarInput({ q: "   ", view: "bogus", page: "-2", past: "1", event: "abc" }),
    ).toMatchObject({
      q: "   ",
      searching: false,
      view: "list",
      past: true,
      page: 1,
      jumpKey: "abc",
    });
  });

  it("refuses overlong queries and drops NUL from bounded jump keys", () => {
    const tooLong = resolveCalendarInput({ q: "x".repeat(256) });
    expect(tooLong).toMatchObject({ queryTooLong: true, searching: false, page: 1 });
    expect(resolveCalendarInput({ event: `a${String.fromCharCode(0)}b` }).jumpKey).toBe("ab");
    expect(resolveCalendarInput({ event: "x".repeat(65) }).jumpKey).toBe("");
  });
});
