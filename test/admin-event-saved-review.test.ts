import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";

const now = new Date("2030-01-10T20:00:00Z");
const row = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  status: "draft",
  location: "Voice room",
  endsAt: new Date("2030-01-10T21:00:00Z"),
  updatedAt: new Date("2030-01-09T11:12:13Z"),
};

describe("saved-event review read model", () => {
  it("does not invent provenance when an older projection omits the update time", () => {
    expect(savedEventReview({ ...row, updatedAt: undefined }, now).updatedAt).toBeNull();
  });

  it("uses the persisted update time, not the advice rendering clock", () => {
    expect(savedEventReview(row, now).updatedAt).toBe(row.updatedAt.toISOString());
  });

  it("retains both corrections, without exposing saved field values in links", () => {
    const view = savedEventReview({ ...row, location: " \t ", endsAt: new Date(0) }, now);
    expect(view.corrections.map((issue) => issue.href)).toEqual(["#f-location", "#f-ends-at"]);
    expect(view.href).toBe(`/events/${row.eventKey}`);
    expect(view.guidance).toContain("needs corrections");
  });

  it("describes cancellation as terminal rather than ready", () => {
    expect(savedEventReview({ ...row, status: "cancelled" }, now).guidance).toContain(
      "cannot be republished",
    );
  });

  it("describes the published record rather than offering another publication", () => {
    expect(savedEventReview({ ...row, status: "published" }, now).guidance).toContain(
      "already published",
    );
  });

  it("offers date correction rather than readiness for an unrenderable saved end", () => {
    const view = savedEventReview({ ...row, endsAt: new Date(Number.NaN) }, now);
    expect(view.corrections).toEqual([
      {
        message: "The saved end time is unavailable. Correct its dates before publishing.",
        href: "#f-ends-at",
        label: "Edit end time",
      },
    ]);
    expect(view.guidance).toContain("needs corrections");
  });

  it("does not crash the repair page when the persisted update time is unrenderable", () => {
    const view = savedEventReview({ ...row, updatedAt: new Date(Number.NaN) }, now);
    expect(view.updatedAt).toBeNull();
    expect(view.href).toBe(`/events/${row.eventKey}`);
  });

  it("uses the supplied equality boundary without mutating the persisted row", () => {
    const frozen = Object.freeze({ ...row, endsAt: now });
    const view = savedEventReview(frozen, now);
    expect(view.corrections).toEqual([]);
    expect(view.guidance).toContain("ready");
    expect(frozen.endsAt).toBe(now);
  });
});
