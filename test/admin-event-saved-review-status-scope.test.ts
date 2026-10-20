import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";

// Corrections are publication advice ("before publishing"), so only drafts get
// them. A published event that legitimately ended, or a terminally cancelled
// event, must not be told to fix fields in order to publish.
const now = new Date("2030-01-10T20:00:00Z");
const degraded = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  location: " \t ",
  endsAt: new Date("2030-01-09T20:00:00Z"),
  updatedAt: new Date("2030-01-09T11:12:13Z"),
};

describe("saved-event review corrections are draft-only publication advice", () => {
  it("withholds corrections from a published event with blank location and past end", () => {
    const view = savedEventReview({ ...degraded, status: "published" }, now);
    expect(view.corrections).toEqual([]);
    expect(view.guidance).toContain("already published");
  });

  it("withholds corrections from a cancelled event with blank location and past end", () => {
    const view = savedEventReview({ ...degraded, status: "cancelled" }, now);
    expect(view.corrections).toEqual([]);
    expect(view.guidance).toContain("cannot be republished");
  });

  it("control: the same degraded draft still gets both corrections", () => {
    const view = savedEventReview({ ...degraded, status: "draft" }, now);
    expect(view.corrections.map((issue) => issue.href)).toEqual(["#f-location", "#f-ends-at"]);
  });
});
