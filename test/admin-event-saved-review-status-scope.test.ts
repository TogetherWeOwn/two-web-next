import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";

const now = new Date("2030-01-10T20:00:00Z");
const degraded = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  location: " \t ",
  startsAt: new Date("2030-01-09T19:00:00Z"),
  endsAt: new Date("2030-01-09T20:00:00Z"),
  updatedAt: new Date("2030-01-09T11:12:13Z"),
};

describe("publication corrections belong only to drafts", () => {
  it.each([
    ["published", "already published"],
    ["cancelled", "This event is cancelled."],
    ["past", "has ended and cannot be published as-is"],
    ["archived", "not a draft and cannot be published as-is"],
  ])("names %s rather than advising publication", (status, guidance) => {
    for (const row of [
      degraded,
      { ...degraded, location: "Hall", endsAt: new Date("2030-01-10T21:00:00Z") },
    ]) {
      const view = savedEventReview({ ...row, status }, now);
      expect(view.corrections).toEqual([]);
      expect(view.guidance).toContain(guidance);
      expect(view.guidance).not.toContain("ready for the current publication checks");
    }
  });

  it("control: the same degraded draft still gets both corrections", () => {
    const view = savedEventReview({ ...degraded, status: "draft" }, now);
    expect(view.corrections.map((issue) => issue.href)).toEqual([
      `${view.editHref}#f-location`,
      `${view.editHref}#f-ends-at`,
    ]);
  });
});
