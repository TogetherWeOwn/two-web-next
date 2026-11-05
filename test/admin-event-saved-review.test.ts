import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";

const now = new Date("2030-01-10T20:00:00Z");
const row = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  status: "draft",
  location: "Voice room",
  startsAt: new Date("2030-01-10T19:00:00Z"),
  endsAt: new Date("2030-01-10T21:00:00Z"),
  updatedAt: new Date("2030-01-09T11:12:13Z"),
};

describe("saved-event review read model", () => {
  it("does not invent provenance when an older projection omits the update time", () => {
    expect(savedEventReview({ ...row, updatedAt: undefined }, now).updatedAt).toBeNull();
  });

  it("uses the persisted update time, not the rendering clock", () => {
    expect(savedEventReview(row, now).updatedAt).toBe(row.updatedAt.toISOString());
  });

  it("retains both corrections and links to the persisted member detail rendering", () => {
    const view = savedEventReview({ ...row, location: " \t ", endsAt: new Date(0) }, now);
    expect(view.corrections.map((issue) => issue.href)).toEqual([
      `${view.editHref}#f-location`, `${view.editHref}#f-ends-at`,
    ]);
    expect(view.href).toBe(`/e/${row.eventKey}?review=1`);
    expect(view.corrections[0]?.message).toBe("Location is blank. Add a location and save.");
  });

  it("describes cancellation instead of offering publication advice", () => {
    const view = savedEventReview({ ...row, status: "cancelled" }, now);
    expect(view.guidance).toBe("This event is cancelled. Members don't see it in listings.");
    expect(view.corrections).toEqual([]);
  });

  it("describes the published record rather than offering another publication", () => {
    expect(savedEventReview({ ...row, status: "published" }, now).guidance).toBe(
      "This event is already published. This is what members see now.",
    );
  });

  it.each(["startsAt", "endsAt"] as const)("offers correction for an unreadable %s", (field) => {
    const view = savedEventReview({ ...row, [field]: new Date(Number.NaN) }, now);
    expect(view.corrections).toHaveLength(1);
    expect(view.corrections[0]?.message).toContain("time can't be read");
    expect(view.corrections[0]?.href).toBe(`${view.editHref}#f-${field === "startsAt" ? "starts" : "ends"}-at`);
  });

  it("does not crash when the persisted update time is unrenderable", () => {
    const view = savedEventReview({ ...row, updatedAt: new Date(Number.NaN) }, now);
    expect(view.updatedAt).toBeNull();
    expect(view.href).toBe(`/e/${row.eventKey}?review=1`);
  });

  it("uses the supplied equality boundary without mutating the persisted row", () => {
    const frozen = Object.freeze({ ...row, endsAt: now });
    const view = savedEventReview(frozen, now);
    expect(view.corrections).toEqual([]);
    expect(view.guidance).toContain("Only moderators can see this page");
    expect(frozen.endsAt).toBe(now);
  });
});
